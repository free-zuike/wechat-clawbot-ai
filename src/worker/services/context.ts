// 对话上下文管理 - 按 user_id 存储最近 N 条消息（DO SQLite）

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

// ========== DO SQLite 版本 ==========

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
    const row = cursor.one() as { messages: string; last_updated: number } | null;

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
    Logger.info(`[Context] Saved SQLite context for ${userId}`, { messageCount: context.messages.length });
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

// ========== D1 版本 ==========

export async function getContextFromD1(db: D1Database, userId: string): Promise<UserContext> {
  try {
    const { results } = await db.prepare(
      `SELECT messages, last_updated FROM contexts WHERE user_id = ?`
    ).bind(userId).all();

    if (results.length > 0) {
      const row = results[0] as { messages: string; last_updated: number };
      try {
        const messages = JSON.parse(row.messages as string);
        const lastUpdated = row.last_updated as number;
        const expireMs = CONTEXT_EXPIRE_HOURS * 60 * 60 * 1000;
        if (Date.now() - lastUpdated > expireMs) {
          await db.prepare(`DELETE FROM contexts WHERE user_id = ?`).bind(userId).run();
          return { userId, messages: [], lastUpdated: Date.now() };
        }
        return { userId, messages, lastUpdated };
      } catch {
        await db.prepare(`DELETE FROM contexts WHERE user_id = ?`).bind(userId).run();
      }
    }
  } catch (error) {
    Logger.warn(`[Context] Error loading D1 context for ${userId}`, { error: (error as Error).message });
  }
  return { userId, messages: [], lastUpdated: Date.now() };
}

export async function saveContextToD1(db: D1Database, userId: string, context: UserContext): Promise<void> {
  context.lastUpdated = Date.now();
  if (context.messages.length > MAX_CONTEXT_MESSAGES) {
    context.messages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
  }
  try {
    await db.prepare(
      `INSERT INTO contexts (user_id, messages, last_updated) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET messages = excluded.messages, last_updated = excluded.last_updated`
    ).bind(userId, JSON.stringify(context.messages), context.lastUpdated).run();
  } catch (error) {
    Logger.error(`[Context] Error saving D1 context for ${userId}`, { error: (error as Error).message });
  }
}

export async function clearContextD1(db: D1Database, userId: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM contexts WHERE user_id = ?`).bind(userId).run();
  } catch (error) {
    Logger.error(`[Context] Error clearing D1 context for ${userId}`, { error: (error as Error).message });
  }
}

// ========== 通用工具函数 ==========

// 构建带上下文的 AI 消息数组（带 token 截断）
export function buildMessagesWithContext(
  systemPrompt: string,
  userMessage: string,
  context: UserContext
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt }
  ];

  const MAX_CHARS = 12000;
  let totalChars = 0;

  // 从最新消息往前加，超过上限截断
  const recentMessages = [...context.messages].reverse();
  const kept: Array<{ role: string; content: string }> = [];
  for (const msg of recentMessages) {
    const msgLen = msg.content.length;
    if (totalChars + msgLen > MAX_CHARS) break;
    totalChars += msgLen;
    kept.push({ role: msg.role, content: msg.content });
  }
  kept.reverse();
  messages.push(...kept);

  messages.push({ role: "user", content: userMessage });

  return messages;
}

// 检查是否需要清空上下文的指令
export function shouldClearContext(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "重置" || clean === "清空" || clean === "reset" || clean === "clear" || clean === "/reset" || clean === "/clear";
}
