// 对话上下文管理 - 按 user_id 存储最近 N 条消息
// 支持 KV 和 DO SQLite 两种存储后端

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

// ========== KV 版本（兼容旧代码和 messaging.ts）==========

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

// ========== DO SQLite 版本（零 KV 读写）==========

// 从 DO SQLite 获取上下文（表不存在时自动建表）
export async function getContextFromSQLite(sql: SqlStorage, userId: string): Promise<UserContext> {
  // 确保 contexts 表存在（DO 新建实例时表可能尚未创建）
  try {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        user_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL DEFAULT '[]',
        last_updated INTEGER NOT NULL
      )
    `);
  } catch (e) {
    Logger.warn(`[Context] Failed to ensure contexts table`, { error: (e as Error).message });
  }

  try {
    const cursor = sql.exec(
      `SELECT messages, last_updated FROM contexts WHERE user_id = ?`,
      userId
    );
    const row = cursor.one<{ messages: string; last_updated: number }>();

    if (row) {
      try {
        const messages = JSON.parse(row.messages as string);
        const lastUpdated = row.last_updated as number;

        // 检查是否过期（24 小时）
        const expireMs = CONTEXT_EXPIRE_HOURS * 60 * 60 * 1000;
        if (Date.now() - lastUpdated > expireMs) {
          Logger.info(`[Context] SQLite context expired for user ${userId}, resetting`);
          sql.exec(`DELETE FROM contexts WHERE user_id = ?`, userId);
          return { userId, messages: [], lastUpdated: Date.now() };
        }

        return { userId, messages, lastUpdated };
      } catch (parseError) {
        Logger.warn(`[Context] Corrupt context data for ${userId}, resetting`, { error: (parseError as Error).message });
        sql.exec(`DELETE FROM contexts WHERE user_id = ?`, userId);
      }
    }
  } catch (error) {
    Logger.warn(`[Context] Error loading SQLite context for ${userId}`, { error: (error as Error).message });
  }
  return { userId, messages: [], lastUpdated: Date.now() };
}

// 保存上下文到 DO SQLite（表不存在时自动建表）
export async function saveContextToSQLite(sql: SqlStorage, userId: string, context: UserContext): Promise<void> {
  // 确保 contexts 表存在
  try {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        user_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL DEFAULT '[]',
        last_updated INTEGER NOT NULL
      )
    `);
  } catch (e) {
    Logger.warn(`[Context] Failed to ensure contexts table on save`, { error: (e as Error).message });
  }

  context.lastUpdated = Date.now();

  // 只保留最近 N 条消息
  if (context.messages.length > MAX_CONTEXT_MESSAGES) {
    context.messages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
  }

  try {
    sql.exec(
      `INSERT INTO contexts (user_id, messages, last_updated)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         messages = excluded.messages,
         last_updated = excluded.last_updated`,
      userId, JSON.stringify(context.messages), context.lastUpdated
    );
    Logger.debug(`[Context] Saved SQLite context for ${userId}`, { messageCount: context.messages.length });
  } catch (error) {
    Logger.error(`[Context] Error saving SQLite context for ${userId}`, { error: (error as Error).message });
  }
}

// 清空 DO SQLite 中的上下文
export async function clearContextSQLite(sql: SqlStorage, userId: string): Promise<void> {
  try {
    sql.exec(`DELETE FROM contexts WHERE user_id = ?`, userId);
    Logger.info(`[Context] Cleared SQLite context for ${userId}`);
  } catch (error) {
    Logger.error(`[Context] Error clearing SQLite context for ${userId}`, { error: (error as Error).message });
  }
}

// ========== 通用工具函数 ==========

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
