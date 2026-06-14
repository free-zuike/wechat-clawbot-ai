// AI 服务 - Worker AI 集成
// 默认模型: @cf/meta/llama-3.2-3b-instruct
// 可通过配置 KV 中的 AI_MODEL 覆盖
// 支持: 对话上下文（按 user_id 存储最近 N 条消息）
// 优化：支持 DO SQLite 作为上下文存储，彻底消除 KV 读写

import { Logger } from "../utils/error";
import {
  getContext,
  getContextFromSQLite,
  addMessageToContext,
  saveContextToSQLite,
  clearContext,
  clearContextSQLite,
  buildMessagesWithContext,
  shouldClearContext,
} from "./context";

const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot AI），一个由 Cloudflare Workers + Worker AI 驱动的微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 200 字以内，除非用户明确要求更长。";

// 本地快捷回复（零 Token 消耗）
const QUICK_REPLIES: Record<string, string> = {
  "你好": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "你好啊": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "在吗": "在的 👋 有什么能帮你的？",
  "早上好": "早上好 ☀️ 新的一天，有什么需要帮你查的吗？",
  "晚上好": "晚上好 🌙 这么晚还没睡？有什么能帮你的？",
  "谢谢": "不客气 😊",
  "感谢": "应该的，不客气～",
  "再见": "再见！需要的时候再回来找我 👋",
  "拜拜": "拜拜 👋",
  "你是谁": "我是爪爪 ClawBot AI —— 基于 Cloudflare Workers + Worker AI 的个人微信机器人。",
  "版本": "爪爪 ClawBot AI v2.0\n架构参考 bee-swarm",
  "帮助": "我可以帮你：\n1. 回答问题\n2. 陪你聊天\n3. 写文本草稿\n4. 中英互译\n\n直接发送你想问的问题即可。",
};

// 指令处理（不调用 AI）
const COMMANDS: Record<string, string> = {
  "/help": "📖 使用指南\n- 直接发送问题，AI 会回复\n- '重置' 清空对话上下文\n- '关于' 查看机器人信息",
  "/clear": "✅ 已清空上下文，我们重新开始吧。",
  "/reset": "✅ 已重置对话，我们重新开始吧。",
  "/about": "🦞 爪爪 ClawBot AI v2.0\n基于 Cloudflare Workers + Worker AI 构建\n架构设计参考 bee-swarm 项目",
};

export function tryQuickReply(text: string): string | null {
  const clean = text.trim().toLowerCase();
  // 先查指令
  if (COMMANDS[clean]) return COMMANDS[clean];
  // 再查快捷回复
  if (QUICK_REPLIES[clean]) return QUICK_REPLIES[clean];
  return null;
}

// 判断存储类型：KVNamespace 还是 DO SQLite (SqlStorage)
function isSQLiteStorage(storage: any): boolean {
  return storage && typeof storage.exec === "function";
}

// 带上下文的 AI 调用（用于微信消息处理）
// 优化：支持 DO SQLite 存储上下文，彻底消除 KV 读写
export async function callAIWithContext(
  storage: KVNamespace | SqlStorage,
  aiBinding: any,
  userId: string,
  userMessage: string,
  systemPrompt: string,
  aiModel: string
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();
  const useSQLite = isSQLiteStorage(storage);

  // 检查快捷回复（不走存储）
  const quick = tryQuickReply(cleanMsg);
  if (quick) {
    Logger.info(`[ai] Quick reply for ${userId}`, { message: cleanMsg.slice(0, 30) });
    return quick;
  }

  // 检查是否需要清空上下文
  if (shouldClearContext(cleanMsg)) {
    if (useSQLite) {
      await clearContextSQLite(storage as SqlStorage, userId);
    } else {
      await clearContext(storage as KVNamespace, userId);
    }
    return "✅ 已清空对话上下文，我们重新开始吧！";
  }

  const model = aiModel || "@cf/meta/llama-3.2-3b-instruct";
  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  // —— 读取上下文 ——
  let context;
  if (useSQLite) {
    context = await getContextFromSQLite(storage as SqlStorage, userId);
  } else {
    context = await getContext(storage as KVNamespace, userId);
  }
  Logger.debug(`[ai] Context for ${userId}`, { messageCount: context.messages.length, storage: useSQLite ? "sqlite" : "kv" });

  const messages = buildMessagesWithContext(system, cleanMsg, context);

  Logger.info(`[ai] Calling AI for ${userId}`, { model, contextSize: context.messages.length });

  let reply = "";
  try {
    const response = await aiBinding.run(model, {
      messages,
      max_tokens: 320,
    });
    reply = typeof response === "string" ? response : response?.response || "";
  } catch (e: any) {
    Logger.error(`[ai] AI call failed for ${userId}`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }

  // —— 保存上下文 ——
  if (reply) {
    const now = Date.now();
    context.messages.push({ role: "user", content: cleanMsg.slice(0, 500), timestamp: now });
    context.messages.push({ role: "assistant", content: reply.slice(0, 500), timestamp: now });

    // 保留最近 10 条
    if (context.messages.length > 10) {
      context.messages = context.messages.slice(-10);
    }
    context.lastUpdated = now;

    try {
      if (useSQLite) {
        await saveContextToSQLite(storage as SqlStorage, userId, context);
      } else {
        await (storage as KVNamespace).put(`clawbot:context:${userId}`, JSON.stringify(context), {
          expirationTtl: 24 * 60 * 60,
        });
      }
      Logger.info(`[ai] Reply & context saved for ${userId}`, { replyLength: reply.length, storage: useSQLite ? "sqlite" : "kv" });
    } catch (e) {
      Logger.warn(`[ai] Failed to persist context for ${userId}`, { error: (e as Error).message });
    }
  } else {
    Logger.warn(`[ai] Empty response for ${userId}`);
  }

  return (reply || "").slice(0, 700) || "（AI 没有返回内容）";
}

// 无上下文的 AI 调用（用于管理后台测试）
export async function callAI(
  aiBinding: any,
  userMessage: string,
  systemPrompt: string,
  aiModel: string
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();
  const quick = tryQuickReply(cleanMsg);
  if (quick) return quick;

  const model = aiModel || "@cf/meta/llama-3.2-3b-instruct";
  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  Logger.info(`[ai] Calling AI (no context)`, { model });

  try {
    const response = await aiBinding.run(model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: cleanMsg },
      ],
      max_tokens: 320,
    });
    const text = typeof response === "string" ? response : response?.response || "";
    return (text || "").slice(0, 700) || "（AI 没有返回内容）";
  } catch (e: any) {
    Logger.error(`[ai] AI call failed`, { error: e?.message || String(e) });
    return "抱歉，我刚刚脑子卡了一下 😅 能换个说法再问一遍吗？";
  }
}

export function getDefaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}
