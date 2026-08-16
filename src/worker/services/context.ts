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
export const MAX_CONTEXT_MESSAGES = 40; // 保留最近 40 条消息（20轮对话）
export const CONTEXT_EXPIRE_HOURS = 0;   // 0 = 永不过期，用户手动"重置"才清空

// ========== DO SQLite 版本 ==========

// 从 DO SQLite 获取上下文（表由 initSQLite 确保存在）
export async function getContextFromSQLite(sql: SqlStorage, userId: string): Promise<UserContext> {
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

        // 检查是否过期（0 = 永不过期）
        if (CONTEXT_EXPIRE_HOURS > 0 && Date.now() - lastUpdated > CONTEXT_EXPIRE_HOURS * 60 * 60 * 1000) {
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

// 保存上下文到 DO SQLite（表由 initSQLite 确保存在）
export async function saveContextToSQLite(sql: SqlStorage, userId: string, context: UserContext): Promise<void> {
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
        if (CONTEXT_EXPIRE_HOURS > 0 && Date.now() - lastUpdated > CONTEXT_EXPIRE_HOURS * 60 * 60 * 1000) {
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

// 构建带上下文的 AI 消息数组（带智能压缩）
// 策略：
// 1. 最近 3 轮对话完整保留
// 2. 更早的对话自动压缩为摘要，保留关键信息
// 3. 工具结果独立预算，不挤占对话空间
const KEEP_ROUNDS = 3; // 完整保留的最近对话轮数
const SUMMARY_PREFIX_LEN = 200; // 每条旧消息保留的前缀长度

export function buildMessagesWithContext(
  systemPrompt: string,
  userMessage: string,
  context: UserContext,
  maxContextChars = 20000,
  maxToolResultChars = 2000,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt }
  ];

  // 分离工具结果和对话消息
  const toolResults: Array<{ role: string; content: string }> = [];
  const conversation: Array<{ role: string; content: string }> = [];
  for (const msg of context.messages) {
    const entry = { role: msg.role, content: msg.content };
    if (msg.content.startsWith("[查询结果]")) {
      toolResults.push(entry);
    } else {
      conversation.push(entry);
    }
  }

  const MAX_CONV_CHARS = maxContextChars - maxToolResultChars;

  // 保留最近 KEEP_ROUNDS 轮对话（2*KEEP_ROUNDS 条消息）完整保留
  const recentCount = Math.min(KEEP_ROUNDS * 2, conversation.length);
  const recent = conversation.slice(-recentCount);
  const old = conversation.slice(0, -recentCount);

  // 先把最近的对话完整加入
  const recentTotal = recent.reduce((sum, m) => sum + m.content.length, 0);
  let convTotal = recentTotal;
  let convKept = [...recent];

  // 如果最近对话已经超过预算，从最近对话中截断（从旧到新）
  if (convTotal > MAX_CONV_CHARS) {
    convKept = [];
    convTotal = 0;
    for (const msg of [...conversation].reverse()) {
      const msgLen = msg.content.length;
      if (convTotal + msgLen > MAX_CONV_CHARS) break;
      convTotal += msgLen;
      convKept.push(msg);
    }
    convKept.reverse();
    messages.push(...convKept);
  } else {
    // 有剩余空间，加入旧消息的压缩摘要
    let remaining = MAX_CONV_CHARS - convTotal;
    const compressed: string[] = [];

    for (const msg of [...old].reverse()) {
      const summary = msg.content.slice(0, SUMMARY_PREFIX_LEN).replace(/\n+/g, " ");
      const entry = msg.role === "user" ? `用户问: ${summary}` : `AI答: ${summary}`;
      if (remaining < entry.length + 20) break; // 留余量
      compressed.push(entry);
      remaining -= entry.length;
    }

    if (compressed.length > 0) {
      convKept = [{ role: "user" as const, content: `【历史摘要】\n${compressed.reverse().join("\n")}` }, ...convKept];
      convTotal = convKept.reduce((sum, m) => sum + m.content.length, 0);
    }

    messages.push(...convKept);
  }

  // 工具结果独立预算
  const toolKept: Array<{ role: string; content: string }> = [];
  let toolTotal = 0;
  for (const msg of [...toolResults].reverse()) {
    const msgLen = msg.content.length;
    if (toolTotal + msgLen > maxToolResultChars) break;
    toolTotal += msgLen;
    toolKept.push(msg);
  }
  toolKept.reverse();
  messages.push(...toolKept);

  messages.push({ role: "user", content: userMessage });

  return messages;
}

// 检查是否需要清空上下文的指令
export function shouldClearContext(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "重置" || clean === "清空" || clean === "reset" || clean === "clear" || clean === "/reset" || clean === "/clear";
}
