// 对话上下文管理 - 按 user_id 存储最近 N 条消息

import { Logger } from "../utils/error";

// 上下文消息结构
export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// 用户上下文结构
export interface UserContext {
  userId: string;
  messages: ContextMessage[];
  lastUpdated: number;
}

// 配置
const MAX_CONTEXT_MESSAGES = 10; // 保留最近 10 条消息（5轮对话）
const CONTEXT_EXPIRE_HOURS = 24; // 上下文 24 小时过期
const CONTEXT_KEY_PREFIX = "clawbot:context:";

// 获取用户上下文
export async function getContext(kv: KVNamespace, userId: string): Promise<UserContext> {
  const key = `${CONTEXT_KEY_PREFIX}${userId}`;
  try {
    const stored = await kv.get(key);
    if (stored) {
      const context: UserContext = JSON.parse(stored);
      // 检查是否过期
      const expireMs = CONTEXT_EXPIRE_HOURS * 60 * 60 * 1000;
      if (Date.now() - context.lastUpdated > expireMs) {
        Logger.info(`[Context] Context expired for user ${userId}, resetting`);
        return { userId, messages: [], lastUpdated: Date.now() };
      }
      return context;
    }
  } catch (error) {
    Logger.warn(`[Context] Error loading context for ${userId}`, { error: (error as Error).message });
  }
  return { userId, messages: [], lastUpdated: Date.now() };
}

// 保存用户上下文
export async function saveContext(kv: KVNamespace, context: UserContext): Promise<void> {
  const key = `${CONTEXT_KEY_PREFIX}${context.userId}`;
  context.lastUpdated = Date.now();
  
  // 只保留最近 N 条消息
  if (context.messages.length > MAX_CONTEXT_MESSAGES) {
    context.messages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
  }
  
  try {
    await kv.put(key, JSON.stringify(context), {
      expirationTtl: CONTEXT_EXPIRE_HOURS * 60 * 60 // 秒
    });
    Logger.debug(`[Context] Saved context for ${context.userId}`, { messageCount: context.messages.length });
  } catch (error) {
    Logger.error(`[Context] Error saving context for ${context.userId}`, { error: (error as Error).message });
  }
}

// 添加消息到上下文
export async function addMessageToContext(
  kv: KVNamespace,
  userId: string,
  role: "user" | "assistant",
  content: string
): Promise<UserContext> {
  const context = await getContext(kv, userId);
  
  context.messages.push({
    role,
    content: content.slice(0, 500), // 截断过长的消息
    timestamp: Date.now()
  });
  
  // 保留最近 N 条
  if (context.messages.length > MAX_CONTEXT_MESSAGES) {
    context.messages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
  }
  
  await saveContext(kv, context);
  return context;
}

// 清空用户上下文
export async function clearContext(kv: KVNamespace, userId: string): Promise<void> {
  const key = `${CONTEXT_KEY_PREFIX}${userId}`;
  try {
    await kv.delete(key);
    Logger.info(`[Context] Cleared context for ${userId}`);
  } catch (error) {
    Logger.error(`[Context] Error clearing context for ${userId}`, { error: (error as Error).message });
  }
}

// 构建带上下文的 AI 消息数组
export function buildMessagesWithContext(
  systemPrompt: string,
  userMessage: string,
  context: UserContext
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt }
  ];
  
  // 添加历史消息
  for (const msg of context.messages) {
    messages.push({
      role: msg.role,
      content: msg.content
    });
  }
  
  // 添加当前用户消息
  messages.push({ role: "user", content: userMessage });
  
  return messages;
}

// 检查是否需要清空上下文的指令
export function shouldClearContext(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "重置" || clean === "清空" || clean === "reset" || clean === "clear" || clean === "/reset" || clean === "/clear";
}