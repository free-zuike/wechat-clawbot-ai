// ======================================================================
//  AI 对话服务 —— Cloudflare Worker AI（KV 优化版）
// ----------------------------------------------------------------------
//  存储方案（优化前 / 优化后对比）：
//
//  | 数据               | 优化前        | 优化后                         |
//  |--------------------|---------------|-------------------------------|
//  | bot_token 凭证     | KV（保留）    | 保留 KV，生命周期只写 1 次    |
//  | 每用户对话上下文   | KV 每次写     | Cache API，TTL 内自动过期      |
//  | 长轮询游标 buf     | KV 每次写     | 移除 —— 传空字符串即可          |
//  | 状态/计数          | KV 每次写     | Cache API（只查不强制写）      |
//  | AI 回复缓存        | (无)          | Cache API 12 小时              |
//
//  效果：每日 KV 写操作从 ~1500 → 0~10，免费额度不再是瓶颈
// ======================================================================

import { Ai } from "@cloudflare/ai";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface ChatContext {
  userId: string;
  turns: ChatTurn[];
  updatedAt: number;
}

// ---------------- 配置（v1.2 优化版） ----------------
const DEFAULT_MODEL = "@cf/meta/llama-3-8b-instruct";
const MAX_TURNS = 6;               // 每用户保留最近 3 轮 user + 3 轮 assistant
const MAX_TURN_CHARS = 240;        // 单轮内容字符上限，超过就截断（省 Prompt Token）
const CONTEXT_TTL = 3 * 3600;      // 上下文 TTL 3 小时
const REPLY_CACHE_TTL = 12 * 3600; // 简单问题回复缓存 12 小时
const AI_FAIL_CACHE_TTL = 30 * 60; // 同一问题 AI 失败 -> 30 分钟内不再调用
const MAX_TOKENS = 320;            // 控制 AI 输出长度（约 200 中文字，微信一条内搞定）
const AI_TIMEOUT_MS = 15000;       // AI 调用 15 秒超时，避免 Worker 被卡住
const HARD_OUTPUT_LIMIT = 700;     // 硬上限 700 字（超过就截断，防止生成超长文本）

// 系统提示词
const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot），一个由 Cloudflare Worker AI 驱动的微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 200 字以内，除非用户明确要求更长。";

// ---------------- 关键词快捷回复表 ----------------
// 完全不调用 AI，直接返回写好的回复 —— 零 Token 消耗
const QUICK_REPLIES: Record<string, string> = {
  "你好": "你好呀 👋 我是爪爪 AI，有什么能帮你的？",
  "你好啊": "你好呀 👋 我是爪爪 AI，有什么能帮你的？",
  "hi": "Hi！有什么我能帮你的吗？",
  "hello": "Hello！我是爪爪 AI，有什么能帮你的？",
  "在吗": "在的 👋 有什么能帮你的？",
  "在不在": "在的 👋 直接说问题吧。",
  "早上好": "早上好 ☀️ 新的一天，有什么需要帮你查的吗？",
  "晚上好": "晚上好 🌙 这么晚还没睡？有什么能帮你的？",
  "谢谢": "不客气 😊",
  "感谢": "应该的，不客气～",
  "thanks": "You're welcome 😊",
  "再见": "再见！需要的时候再回来找我 👋",
  "拜拜": "拜拜 👋",
  "时间": `现在是 ${formatNow()}`,
  "几点了": `现在是 ${formatNow()}`,
  "今天日期": `今天是 ${formatNow()}`,
  "星期几": `今天是 ${formatWeekday()}`,
  "天气": "抱歉，我目前还没接入天气 API。可以去微信小程序里搜「天气」。",
  "笑话": "为什么程序员不喜欢室外活动？\n因为外面 bug 太多了 🐛",
  "讲个笑话": "为什么程序员不喜欢室外活动？\n因为外面 bug 太多了 🐛",
  "你是谁": "我是爪爪 ClawBot AI —— 基于 Cloudflare Worker + Worker AI 的个人微信机器人。",
  "自我介绍":
    "我是爪爪 ClawBot AI，一个个人微信机器人。\n可以回答你的问题、帮你写文字、查资料。\n背后是 Cloudflare Workers + Llama 3 8B Instruct。",
  "版本": "爪爪 ClawBot AI v1.1（优化版）\nCloudflare Workers + Worker AI",
  "v": "爪爪 ClawBot AI v1.1（优化版）",
};

// 同义词映射 —— 用小写的统一 key 命中
function normalizeKey(t: string): string {
  return t
    .trim()
    .toLowerCase()
    .replace(/[，。！？、\s]/g, "")
    .replace(/[!?.]/g, "");
}

// 构建一次的 map（在 Worker 首次 load 时构建一次，后续一直复用）
const QUICK_REPLY_MAP = (() => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(QUICK_REPLIES)) {
    m.set(normalizeKey(k), v);
  }
  return m;
})();

// ---------------- 工具函数 ----------------
function formatNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
function formatWeekday(): string {
  return "星期" + ["日", "一", "二", "三", "四", "五", "六"][new Date().getDay()];
}

// 敏感词过滤（极简版，仅拦截明显不当内容，避免 AI 被诱导生成违规文本）
// 返回 null 表示通过，非空 string 表示命中并直接返回该兜底回复
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /赌博|博彩|赌场|网赌|赌球|百家乐|外围/i,
  /色情|黄片|裸聊|成人影片|自慰/i,
  /毒品|大麻|可卡因|海洛因|冰毒|摇头丸/i,
  /代开发票|代开票|洗钱|黑产|灰色产业/i,
  /(如何|怎么|教我|告诉我|办法).*(诈骗|黑客|盗取|破解|盗号|入侵|ddos|薅羊毛|刷单)/i,
];

const BLOCKED_REPLY =
  "抱歉，我不能帮你处理这类内容 😶。\n如果你有其他问题（写代码 / 写邮件 / 查资料 / 日常聊天），随时问我。";

function checkSensitive(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  for (const p of SENSITIVE_PATTERNS) if (p.test(t)) return BLOCKED_REPLY;
  return null;
}

// ---------- 简单事件：AI 每次成功/失败会回调（最多一个监听器）----------
// 用于：连续失败告警、统计、健康检查。
// 由 Worker 启动时调用 setAiResultListener 注册。
type AiResultListener = (ok: boolean, info?: string) => void;
let _listener: AiResultListener | null = null;
export function setAiResultListener(l: AiResultListener | null) {
  _listener = l;
}
function emitAiResult(ok: boolean, info?: string) {
  try { _listener?.(ok, info); } catch {}
}

// ---------------- 指令处理 ----------------
export interface CommandResult {
  handled: boolean;
  reply?: string;
  reset?: boolean;
}

export function tryHandleCommand(text: string): CommandResult {
  const t = text.trim();
  if (/^(帮助|help|\/help|\?|？|功能|使用说明|怎么用)$/i.test(t)) {
    return {
      handled: true,
      reply:
        "🦞 爪爪 ClawBot AI 使用指南\n\n" +
        "• 直接发文字 → AI 自动回复\n" +
        "• 发图片/语音/文件 → 我目前只处理文字\n\n" +
        "指令（直接发送）：\n" +
        "  重置 / clear  → 清空你的对话上下文\n" +
        "  帮助 / help  → 显示本消息\n" +
        "  关于 / about  → 我的版本信息\n\n" +
        "接入：微信 ClawBot (iLink) · 模型：Llama 3 8B",
    };
  }
  if (/^(重置|清空|clear|reset|\/reset|忘记对话)$/i.test(t)) {
    return { handled: true, reply: "✅ 已清空对话上下文，我们重新开始。", reset: true };
  }
  if (/^(关于|about|version|版本|你是谁)$/i.test(t)) {
    return {
      handled: true,
      reply:
        "🦞 爪爪 ClawBot AI v1.1（优化版）\n\n" +
        "• 接入：微信 ClawBot / iLink 协议\n" +
        "• 后端：Cloudflare Workers\n" +
        "• 模型：Worker AI · Llama 3 8B Instruct\n" +
        "• 存储：Cache API（每用户独立上下文，3 小时自动过期）\n\n" +
        "——合法合规接入个人微信 ——",
    };
  }
  // 关键词快捷回复
  const quick = QUICK_REPLY_MAP.get(normalizeKey(t));
  if (quick) return { handled: true, reply: quick };

  return { handled: false };
}

// ======================================================================
//  Cache API 上下文管理（替代 KV，零额度消耗）
// ----------------------------------------------------------------------
//  Cloudflare caches.default 是每数据中心的本地缓存，
//  对"每用户对话上下文"完全够用 —— TTL 内命中、过期自动清理。
//  它是免费的，不占 KV 写额度，也不占读额度。
// ======================================================================

function ctxCacheKey(userId: string): string {
  // 注意：Cache API 以 URL 为 key，所以我们用一个"虚拟 URL"
  return `https://clawbot.local/ctx/${encodeURIComponent(userId)}`;
}

function replyCacheKey(message: string): string {
  const clean = message.trim().slice(0, 200).toLowerCase();
  const hash = simpleHash(clean);
  return `https://clawbot.local/reply/${hash}`;
}

// 简单的 hash，不依赖外部库 —— 只用于把 query 映射成一个稳定的 key
function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 转成无符号 16 进制字符串
  return (h >>> 0).toString(16);
}

function failCacheKey(message: string): string {
  const clean = message.trim().slice(0, 200).toLowerCase();
  return `https://clawbot.local/ai-fail/${simpleHash(clean)}`;
}

// ---------- 上下文管理 ----------

// 单轮内容压缩：超过 MAX_TURN_CHARS 就截断，在末尾加"…"
function compressTurnContent(s: string): string {
  if (s.length <= MAX_TURN_CHARS) return s;
  // 在截断点附近找一个自然断句（换行/句号/逗号/空格）
  const cut = s.slice(0, MAX_TURN_CHARS);
  const br = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf("。"),
    cut.lastIndexOf("."),
    cut.lastIndexOf("，"),
    cut.lastIndexOf(",")
  );
  const endAt = br >= MAX_TURN_CHARS - 80 ? br : MAX_TURN_CHARS - 8;
  return cut.slice(0, endAt).trim() + "…";
}

export async function loadContext(userId: string): Promise<ChatContext> {
  try {
    const cache = caches.default;
    const req = new Request(ctxCacheKey(userId));
    const resp = await cache.match(req);
    if (resp) {
      const data = (await resp.json()) as ChatContext;
      return {
        userId,
        turns: data.turns || [],
        updatedAt: data.updatedAt || Date.now(),
      };
    }
  } catch {
    // cache 不可用（某些环境）—— 退化为内存空上下文
  }
  return { userId, turns: [], updatedAt: Date.now() };
}

export async function saveContext(ctx: ChatContext): Promise<void> {
  try {
    const cache = caches.default;
    // 应用 MAX_TURNS + 单轮压缩
    const trimmed: ChatContext = {
      ...ctx,
      turns: ctx.turns
        .slice(-MAX_TURNS)
        .map((t) => ({ ...t, content: compressTurnContent(t.content) })),
      updatedAt: Date.now(),
    };
    const resp = new Response(JSON.stringify(trimmed), {
      headers: {
        "Cache-Control": `public, max-age=${CONTEXT_TTL}`,
        "Content-Type": "application/json",
      },
    });
    cache.put(new Request(ctxCacheKey(ctx.userId)), resp).catch(() => {});
  } catch {
    // cache 不可用时静默失败，不影响回复
  }
}

export async function clearContext(userId: string): Promise<void> {
  try {
    const cache = caches.default;
    await cache.delete(new Request(ctxCacheKey(userId)));
  } catch {
    // 静默
  }
}

// ---------- AI 调用缓存辅助 ----------

async function tryGetCachedReply(message: string): Promise<string | null> {
  try {
    const cache = caches.default;
    const req = new Request(replyCacheKey(message));
    const r = await cache.match(req);
    if (r) return await r.text();
  } catch {
    // ignore
  }
  return null;
}

async function putCachedReply(message: string, reply: string): Promise<void> {
  try {
    const cache = caches.default;
    const req = new Request(replyCacheKey(message));
    const resp = new Response(reply, {
      headers: { "Cache-Control": `public, max-age=${REPLY_CACHE_TTL}` },
    });
    cache.put(req, resp).catch(() => {});
  } catch {
    // 静默
  }
}

async function checkFailMarker(message: string): Promise<boolean> {
  try {
    const cache = caches.default;
    const r = await cache.match(new Request(failCacheKey(message)));
    return !!r;
  } catch {
    return false;
  }
}

function putFailMarker(message: string): void {
  try {
    const cache = caches.default;
    const resp = new Response("1", {
      headers: { "Cache-Control": `public, max-age=${AI_FAIL_CACHE_TTL}` },
    });
    cache.put(new Request(failCacheKey(message)), resp).catch(() => {});
  } catch {
    // 静默
  }
}

// 在不依赖 Promise.withResolvers 的情况下，给 AI 调用加超时
function runWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const FALLBACK_REPLIES = [
  "抱歉，我刚才脑子转不动了，能换个说法再问一次吗 😊",
  "哎呀，我刚刚走神了，麻烦你再讲一遍？",
  "抱歉，我暂时答不上来 😅。换个角度问我试试？",
];
function randomFallback(): string {
  return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
}

export async function aiReply(
  aiBinding: any,
  userMessage: string,
  ctx: ChatContext,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();

  // 1) 敏感词拦截 —— 零 AI 调用
  const blocked = checkSensitive(cleanMsg);
  if (blocked) return blocked;

  // 2) 简单问题缓存（仅对无上下文的短问题生效，避免上下文对话被错误缓存）
  if (cleanMsg.length > 0 && cleanMsg.length <= 40 && ctx.turns.length === 0) {
    const cached = await tryGetCachedReply(cleanMsg);
    if (cached) return cached;
    // 如果同一问题近期 AI 失败过，直接走兜底，避免反复调用
    if (await checkFailMarker(cleanMsg)) return randomFallback();
  }

  // 3) 正常走 Worker AI（加超时 + 输出硬上限）
  try {
    const ai = new Ai(aiBinding);

    // 3a) 构建压缩后的历史（每个 turn 最多 MAX_TURN_CHARS 字）
    const history = ctx.turns
      .slice(-6)
      .map((t) => ({ role: t.role, content: compressTurnContent(t.content) }));

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: compressTurnContent(cleanMsg) },
    ];

    // 3b) 调用 + 超时控制
    const response = await runWithTimeout(
      ai.run(DEFAULT_MODEL, { messages, max_tokens: MAX_TOKENS }),
      AI_TIMEOUT_MS,
      "ai timeout"
    );

    // 3c) 统一读 text
    let text: string;
    if (typeof response === "string") text = response;
    else if (response && typeof response === "object") {
      text =
        response.response ||
        response.message ||
        response.reply ||
        (typeof response.result === "string" ? response.result : "");
    } else {
      text = "";
    }
    const clean = (text || "").trim() || "（AI 没有返回内容）";

    // 3d) 硬上限截断
    const final = clean.length > HARD_OUTPUT_LIMIT
      ? clean.slice(0, HARD_OUTPUT_LIMIT).trimEnd() + "…"
      : clean;

    // 3e) 对"短问题 + 无上下文 + 短回复"写入缓存（下次零 Token）
    if (
      cleanMsg.length > 0 &&
      cleanMsg.length <= 40 &&
      ctx.turns.length === 0 &&
      final.length > 0 &&
      final.length < 600
    ) {
      putCachedReply(cleanMsg, final); // fire-and-forget
    }

    emitAiResult(true);
    return final;
  } catch (e) {
    console.error("[ai] error:", e);
    // 失败时写入 fail marker —— 30 分钟内同问题不再浪费 Token
    if (cleanMsg.length > 0 && cleanMsg.length <= 40 && ctx.turns.length === 0) {
      putFailMarker(cleanMsg);
    }
    emitAiResult(false, e instanceof Error ? e.message : String(e));
    return randomFallback();
  }
}

// 主入口：处理一轮对话（读上下文 → AI → 写上下文）
export async function turnAndSave(
  aiBinding: any,
  userId: string,
  userMessage: string,
  systemPrompt?: string
): Promise<string> {
  const ctx = await loadContext(userId);
  const reply = await aiReply(aiBinding, userMessage, ctx, systemPrompt);
  ctx.turns.push({ role: "user", content: userMessage, ts: Date.now() });
  ctx.turns.push({ role: "assistant", content: reply, ts: Date.now() });
  // 上下文异步写 Cache，不阻塞返回
  saveContext(ctx).catch(() => {});
  return reply;
}
