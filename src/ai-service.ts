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

// ---------------- 配置 ----------------
const DEFAULT_MODEL = "@cf/meta/llama-3-8b-instruct";
const MAX_TURNS = 12;             // 每用户最多保留 6 轮对话
const CONTEXT_TTL = 3 * 3600;     // 上下文 TTL 3 小时（与 Cache 一致）
const REPLY_CACHE_TTL = 12 * 3600; // 简单问题回复缓存 12 小时
const MAX_TOKENS = 400;           // 控制 AI 输出长度，省 Token

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
    const trimmed: ChatContext = {
      ...ctx,
      turns: ctx.turns.slice(-MAX_TURNS),
      updatedAt: Date.now(),
    };
    const resp = new Response(JSON.stringify(trimmed), {
      headers: { "Cache-Control": `public, max-age=${CONTEXT_TTL}`, "Content-Type": "application/json" },
    });
    // Cache.put 不需要 await 完成，不阻塞主流程
    // 但为了稳妥我们 try/catch + fire-and-forget
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

// ======================================================================
//  AI 调用（含 Cache API 回复缓存）
// ======================================================================

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

export async function aiReply(
  aiBinding: any,
  userMessage: string,
  ctx: ChatContext,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT
): Promise<string> {
  // 1) 先尝试命中"简单问题缓存"（仅对短问题生效，避免上下文相关问题被错用）
  if (userMessage.length <= 40 && ctx.turns.length === 0) {
    const cached = await tryGetCachedReply(userMessage);
    if (cached) return cached;
  }

  // 2) 正常走 Worker AI
  try {
    const ai = new Ai(aiBinding);
    const history = ctx.turns.slice(-8).map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    const response = await ai.run(DEFAULT_MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
    });

    let text: string;
    if (typeof response === "string") text = response;
    else if (response && typeof response === "object")
      text =
        response.response ||
        response.message ||
        response.reply ||
        (typeof response.result === "string" ? response.result : JSON.stringify(response));
    else text = String(response);

    const clean = (text || "").trim() || "（AI 没有返回内容）";

    // 3) 对短问题 & 非上下文对话写入缓存
    if (userMessage.length <= 40 && ctx.turns.length === 0 && clean.length < 600) {
      putCachedReply(userMessage, clean); // fire-and-forget
    }

    return clean;
  } catch (e) {
    console.error("[ai] error:", e);
    return "抱歉，AI 现在有点忙，稍后再试试 😊";
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
  saveContext(ctx);
  return reply;
}
