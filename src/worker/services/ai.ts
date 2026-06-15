// AI 服务 - 支持 Cloudflare Workers AI + OpenAI 兼容 API

import { Logger } from "../utils/error";
import {
  getContext,
  getContextFromSQLite,
  saveContextToSQLite,
  clearContext,
  clearContextSQLite,
  buildMessagesWithContext,
  shouldClearContext,
} from "./context";

const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot AI），一个微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "始终使用中文回答，不要使用英文。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 200 字以内，除非用户明确要求更长。";

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
  "你是谁": "我是爪爪 ClawBot AI —— 个人微信机器人。",
  "版本": "爪爪 ClawBot AI v2.0",
  "帮助": "我可以帮你：\n1. 回答问题\n2. 陪你聊天\n3. 写文本草稿\n4. 中英互译\n\n直接发送你想问的问题即可。",
};

const COMMANDS: Record<string, string> = {
  "/help": "📖 使用指南\n- 直接发送问题，AI 会回复\n- '重置' 清空对话上下文\n- '关于' 查看机器人信息",
  "/clear": "✅ 已清空对话上下文，我们重新开始吧。",
  "/reset": "✅ 已重置对话，我们重新开始吧。",
  "/about": "🦞 爪爪 ClawBot AI v2.0\n基于 Cloudflare Workers 构建",
};

export function tryQuickReply(text: string): string | null {
  const clean = text.trim().toLowerCase();
  if (COMMANDS[clean]) return COMMANDS[clean];
  if (QUICK_REPLIES[clean]) return QUICK_REPLIES[clean];
  return null;
}

function isSQLiteStorage(storage: any): boolean {
  return storage && typeof storage.exec === "function";
}

// ========== OpenAI 兼容 API 调用 ==========

async function callOpenAICompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
}): Promise<string> {
  const url = params.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

// ========== Cloudflare Workers AI 调用 ==========

async function callCloudflareAI(
  aiBinding: any,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Promise<string> {
  if (!aiBinding) throw new Error("Cloudflare AI binding 未配置");
  const response = await aiBinding.run(model, { messages, max_tokens: maxTokens });
  return typeof response === "string" ? response : response?.response || "";
}

// ========== 统一 AI 调用入口 ==========

interface AIConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
}

async function callModel(config: AIConfig, messages: Array<{ role: string; content: string }>): Promise<string> {
  if (config.provider === "openai") {
    return callOpenAICompatible({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || "gpt-3.5-turbo",
      messages,
      maxTokens: config.maxTokens,
    });
  }
  // 默认 Cloudflare
  return callCloudflareAI(undefined, config.model, messages, config.maxTokens);
}

// ========== 带上下文的 AI 调用（微信消息处理）==========

export async function callAIWithContext(
  storage: KVNamespace | SqlStorage,
  aiBinding: any,
  userId: string,
  userMessage: string,
  systemPrompt: string,
  aiModel: string,
  aiConfig?: Partial<AIConfig>
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();
  const useSQLite = isSQLiteStorage(storage);

  const quick = tryQuickReply(cleanMsg);
  if (quick) {
    Logger.info(`[ai] Quick reply for ${userId}`);
    return quick;
  }

  if (shouldClearContext(cleanMsg)) {
    if (useSQLite) {
      await clearContextSQLite(storage as SqlStorage, userId);
    } else {
      await clearContext(storage as KVNamespace, userId);
    }
    return "✅ 已清空对话上下文，我们重新开始吧！";
  }

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiModel || aiConfig?.model || "@cf/meta/llama-3.2-3b-instruct",
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
  };

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  let context;
  if (useSQLite) {
    context = await getContextFromSQLite(storage as SqlStorage, userId);
  } else {
    context = await getContext(storage as KVNamespace, userId);
  }

  const messages = buildMessagesWithContext(system, cleanMsg, context);

  Logger.info(`[ai] Calling AI for ${userId}`, { provider: config.provider, model: config.model });

  let reply = "";
  try {
    if (config.provider === "openai") {
      reply = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens,
      });
    } else {
      reply = await callCloudflareAI(aiBinding, config.model, messages, config.maxTokens);
    }
  } catch (e: any) {
    Logger.error(`[ai] AI call failed for ${userId}`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }

  if (reply) {
    const now = Date.now();
    context.messages.push({ role: "user", content: cleanMsg.slice(0, 500), timestamp: now });
    context.messages.push({ role: "assistant", content: reply.slice(0, 500), timestamp: now });
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
    } catch {}
  }

  return (reply || "").slice(0, 700) || "（AI 没有返回内容）";
}

// ========== 无上下文 AI 调用（管理后台测试）==========

export async function callAI(
  aiBinding: any,
  userMessage: string,
  systemPrompt: string,
  aiModel: string,
  aiConfig?: Partial<AIConfig>
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();
  const quick = tryQuickReply(cleanMsg);
  if (quick) return quick;

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiModel || aiConfig?.model || "@cf/meta/llama-3.2-3b-instruct",
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
  };

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  Logger.info(`[ai] Calling AI (no context)`, { provider: config.provider, model: config.model });

  try {
    let text = "";
    if (config.provider === "openai") {
      text = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: cleanMsg },
        ],
        maxTokens: config.maxTokens,
      });
    } else {
      text = await callCloudflareAI(aiBinding, config.model, [
        { role: "system", content: system },
        { role: "user", content: cleanMsg },
      ], config.maxTokens);
    }
    return (text || "").slice(0, 700) || "（AI 没有返回内容）";
  } catch (e: any) {
    Logger.error(`[ai] AI call failed`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }
}

export function getDefaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}
