// ======================================================================
//  AI 对话服务 —— 使用 Cloudflare Worker AI
// ----------------------------------------------------------------------
//  - 系统提示词可配置
//  - 每个用户按 userId 独立保存上下文
//  - 每条消息带上近期对话轮历史,避免 AI 失忆
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

// 默认模型
const DEFAULT_MODEL = "@cf/meta/llama-3-8b-instruct";
const MAX_TURNS = 16; // 每用户保存最多 8 轮对话
const TTL_SECONDS = 3 * 60 * 60; // 3 小时

// 系统提示词
const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot），一个由 Cloudflare Worker AI 驱动的微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 300 字以内，除非用户明确要求更长。";

// ---------- 指令处理（在调用 AI 之前） ----------

export interface CommandResult {
  handled: boolean;
  reply?: string;
  reset?: boolean;
}

export function tryHandleCommand(text: string): CommandResult {
  const t = text.trim();
  if (/^(帮助|help|\/help|\?|？|功能)$/i.test(t)) {
    return {
      handled: true,
      reply:
        "🦞 爪爪 ClawBot AI 使用指南\n\n" +
        "• 直接发送文字 → AI 会回复你\n" +
        "• 发送图片/文件 → 暂不处理\n\n" +
        "特殊指令：\n" +
        "  重置 / clear  → 清空对话上下文\n" +
        "  帮助 / help  → 显示本消息\n" +
        "  关于 / about  → 关于爪爪\n\n" +
        "默认模型：Llama 3 8B Instruct（Cloudflare Worker AI）",
    };
  }
  if (/^(重置|清空|clear|reset|\/reset)$/i.test(t)) {
    return { handled: true, reply: "✅ 已清空对话上下文", reset: true };
  }
  if (/^(关于|about|version|版本)$/i.test(t)) {
    return {
      handled: true,
      reply:
        "🦞 爪爪 ClawBot AI v1.0\n\n" +
        "• 接入：微信 ClawBot / iLink 协议\n" +
        "• 后端：Cloudflare Workers\n" +
        "• 模型：Worker AI (Llama 3 8B Instruct)\n" +
        "• 存储：Cloudflare KV（每用户独立上下文）\n\n" +
        "完全开源、无平台绑定，合法合规接入微信个人号。",
    };
  }
  return { handled: false };
}

// ---------- 上下文管理 ----------

const KV_PREFIX = "clawbot:ctx:";
const KV_BUFFER_PREFIX = "clawbot:buf:";

function contextKey(userId: string) {
  return `${KV_PREFIX}${userId}`;
}

export async function loadContext(
  kv: KVNamespace | null,
  userId: string
): Promise<ChatContext> {
  if (!kv) return { userId, turns: [], updatedAt: Date.now() };
  try {
    const raw = await kv.get(contextKey(userId));
    if (raw) {
      const data = JSON.parse(raw) as ChatContext;
      return {
        userId,
        turns: data.turns || [],
        updatedAt: data.updatedAt || Date.now(),
      };
    }
  } catch {
    // ignore
  }
  return { userId, turns: [], updatedAt: Date.now() };
}

export async function saveContext(
  kv: KVNamespace | null,
  ctx: ChatContext
): Promise<void> {
  if (!kv) return;
  try {
    const trimmed: ChatContext = {
      ...ctx,
      turns: ctx.turns.slice(-MAX_TURNS),
      updatedAt: Date.now(),
    };
    await kv.put(contextKey(ctx.userId), JSON.stringify(trimmed), {
      expirationTtl: TTL_SECONDS,
    });
  } catch {
    // ignore
  }
}

export async function clearContext(
  kv: KVNamespace | null,
  userId: string
): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(contextKey(userId));
  } catch {
    // ignore
  }
}

// ---------- 长轮询同步游标 ----------

export async function loadBuf(kv: KVNamespace | null): Promise<string> {
  if (!kv) return "";
  try {
    return (await kv.get(KV_BUFFER_PREFIX + "default")) || "";
  } catch {
    return "";
  }
}

export async function saveBuf(
  kv: KVNamespace | null,
  buf: string
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(KV_BUFFER_PREFIX + "default", buf);
  } catch {
    // ignore
  }
}

// ---------- AI 调用 ----------

export async function aiReply(
  aiBinding: any, // Ai 或 Worker AI binding
  userMessage: string,
  ctx: ChatContext,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT
): Promise<string> {
  try {
    const ai = new Ai(aiBinding);
    // 取最近 N 条作为对话历史
    const history = ctx.turns.slice(-6).map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    // console.log("[ai] calling with messages:", messages.length);
    const response = await ai.run(DEFAULT_MODEL, {
      messages,
      max_tokens: 800,
    });

    // response 可能是 { response: "..." } 或 string
    const text =
      typeof response === "string"
        ? response
        : response && typeof response === "object"
        ? response.response || response.message || JSON.stringify(response)
        : String(response);

    return (text || "").trim() || "（AI 没有返回内容）";
  } catch (e) {
    console.error("[ai] error:", e);
    return "抱歉，AI 现在有点忙，稍后再试试 😊";
  }
}

// 同时更新上下文
export async function turnAndSave(
  aiBinding: any,
  kv: KVNamespace | null,
  userId: string,
  userMessage: string,
  systemPrompt?: string
): Promise<string> {
  const ctx = await loadContext(kv, userId);
  const reply = await aiReply(aiBinding, userMessage, ctx, systemPrompt);
  ctx.turns.push({ role: "user", content: userMessage, ts: Date.now() });
  ctx.turns.push({ role: "assistant", content: reply, ts: Date.now() });
  await saveContext(kv, ctx);
  return reply;
}
