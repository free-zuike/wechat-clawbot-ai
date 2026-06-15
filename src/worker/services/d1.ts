// D1 数据库服务 - 消息、会话、统计数据持久化

import { Logger } from "../utils/error";

// SQL 建表语句
const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT,
  content TEXT NOT NULL,
  message_type INTEGER DEFAULT 1,
  context_token TEXT,
  created_at TEXT NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  reply_content TEXT,
  reply_at TEXT,
  UNIQUE(message_id)
);
`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CREATE_STATS_TABLE = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  polls INTEGER DEFAULT 0,
  handled INTEGER DEFAULT 0,
  ai_calls INTEGER DEFAULT 0,
  ai_fails INTEGER DEFAULT 0,
  total_latency_ms INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_messages_from_user_id ON messages(from_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date)`,
];

// 消息记录
export interface DBMessage {
  id?: number;
  message_id: string;
  from_user_id: string;
  to_user_id?: string;
  content: string;
  message_type?: number;
  context_token?: string;
  created_at: string;
  processed?: boolean;
  reply_content?: string;
  reply_at?: string;
}

// 会话记录
export interface DBSession {
  id?: number;
  user_id: string;
  last_message_at?: string;
  message_count?: number;
  created_at: string;
  updated_at: string;
}

// 统计记录
export interface DBStats {
  id?: number;
  date: string;
  polls: number;
  handled: number;
  ai_calls: number;
  ai_fails: number;
  total_latency_ms: number;
  created_at: string;
  updated_at: string;
}

export class D1Service {
  private db: D1Database;
  private initialized: boolean = false;

  constructor(db: D1Database) {
    this.db = db;
  }

  private prepare(sql: string, params: any[] = []) {
    return this.db.prepare(sql).bind(...params);
  }

  private async run(sql: string, params: any[] = []) {
    return this.prepare(sql, params).run();
  }

  private async first<T = Record<string, unknown>>(sql: string, params: any[] = []): Promise<T | null> {
    return await this.prepare(sql, params).first<T>() || null;
  }

  private async firstValue<T = unknown>(sql: string, params: any[] = [], columnName?: string): Promise<T | null> {
    const row = await this.prepare(sql, params).first<Record<string, T>>(columnName);
    if (columnName) return (row as T) ?? null;
    if (!row) return null;
    const firstKey = Object.keys(row)[0];
    return firstKey ? row[firstKey] : null;
  }

  private async all<T = Record<string, unknown>>(sql: string, params: any[] = []): Promise<T[]> {
    const result = await this.prepare(sql, params).all<T>();
    return result.results || [];
  }

  // 初始化数据库（创建表和索引）
  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await this.db.batch([
        this.db.prepare(CREATE_MESSAGES_TABLE),
        this.db.prepare(CREATE_SESSIONS_TABLE),
        this.db.prepare(CREATE_STATS_TABLE),
        ...CREATE_INDEXES.map(sql => this.db.prepare(sql)),
      ]);
      this.initialized = true;
      Logger.info("[D1] Database initialized");
    } catch (error) {
      Logger.error("[D1] Failed to initialize database", { error: (error as Error).message });
      throw error;
    }
  }

  // ========== 消息操作 ==========

  async insertMessage(message: DBMessage): Promise<number> {
    const {
      message_id,
      from_user_id,
      to_user_id,
      content,
      message_type,
      context_token,
      created_at,
      processed,
      reply_content,
      reply_at,
    } = message;

    const result = await this.run(
      `INSERT OR IGNORE INTO messages
       (message_id, from_user_id, to_user_id, content, message_type, context_token, created_at, processed, reply_content, reply_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message_id,
        from_user_id,
        to_user_id || null,
        content,
        message_type || 1,
        context_token || null,
        created_at,
        processed ? 1 : 0,
        reply_content || null,
        reply_at || null,
      ]
    );
    
    Logger.debug("[D1] Message inserted", { message_id, changes: result.changes });
    return result.lastInsertRowId || 0;
  }

  async updateMessageReply(messageId: string, replyContent: string): Promise<void> {
    await this.run(
      `UPDATE messages SET processed = TRUE, reply_content = ?, reply_at = ? WHERE message_id = ?`,
      [replyContent, new Date().toISOString(), messageId]
    );
    Logger.debug("[D1] Message reply updated", { messageId });
  }

  async getMessageById(messageId: string): Promise<DBMessage | null> {
    return await this.first<DBMessage>(`SELECT * FROM messages WHERE message_id = ?`, [messageId]);
  }

  async getMessagesByUser(userId: string, limit: number = 50): Promise<DBMessage[]> {
    return await this.all<DBMessage>(
      `SELECT * FROM messages WHERE from_user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.run(`DELETE FROM messages WHERE message_id = ?`, [messageId]);
    Logger.debug("[D1] Message deleted", { messageId });
  }

  async getUnprocessedMessages(limit: number = 100): Promise<DBMessage[]> {
    return await this.all<DBMessage>(
      `SELECT * FROM messages WHERE processed = FALSE ORDER BY created_at ASC LIMIT ?`,
      [limit]
    );
  }

  async getRecentMessages(limit: number = 50, offset: number = 0, search: string = ""): Promise<DBMessage[]> {
    const where = search ? `WHERE LOWER(from_user_id) LIKE ? OR LOWER(content) LIKE ?` : "";
    const params = search ? [`%${search}%`, `%${search}%`, limit, offset] : [limit, offset];
    return await this.all<DBMessage>(
      `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
  }

  async countMessages(search: string = ""): Promise<number> {
    const where = search ? `WHERE LOWER(from_user_id) LIKE ? OR LOWER(content) LIKE ?` : "";
    const params = search ? [`%${search}%`, `%${search}%`] : [];
    return await this.firstValue<number>(
      `SELECT COUNT(*) as count FROM messages ${where}`,
      params,
      "count"
    ) || 0;
  }

  // ========== 会话操作 ==========

  async upsertSession(userId: string, lastMessageAt?: string): Promise<void> {
    const now = new Date().toISOString();
    const messageAt = lastMessageAt || now;
    await this.run(
      `INSERT INTO sessions (user_id, last_message_at, message_count, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_message_at = CASE
           WHEN sessions.last_message_at IS NULL OR excluded.last_message_at > sessions.last_message_at
             THEN excluded.last_message_at
           ELSE sessions.last_message_at
         END,
         message_count = sessions.message_count + 1,
         updated_at = excluded.updated_at`,
      [userId, messageAt, now, now]
    );
    Logger.debug("[D1] Session updated", { userId });
  }

  async getSession(userId: string): Promise<DBSession | null> {
    return await this.first<DBSession>(`SELECT * FROM sessions WHERE user_id = ?`, [userId]);
  }

  async getAllSessions(limit: number = 100): Promise<DBSession[]> {
    return await this.all<DBSession>(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`, [limit]);
  }

  async getSessions(limit: number = 100, offset: number = 0, search: string = ""): Promise<DBSession[]> {
    const where = search ? `WHERE LOWER(user_id) LIKE ?` : "";
    const params = search ? [`%${search}%`, limit, offset] : [limit, offset];
    return await this.all<DBSession>(
      `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      params
    );
  }

  async countSessions(search: string = ""): Promise<number> {
    const where = search ? `WHERE LOWER(user_id) LIKE ?` : "";
    const params = search ? [`%${search}%`] : [];
    return await this.firstValue<number>(
      `SELECT COUNT(*) as count FROM sessions ${where}`,
      params,
      "count"
    ) || 0;
  }

  async deleteSession(userId: string): Promise<void> {
    await this.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    Logger.debug("[D1] Session deleted", { userId });
  }

  // ========== 统计操作 ==========

  async incrementStats(date: string, polls: number = 0, handled: number = 0, aiCalls: number = 0, aiFails: number = 0, latencyMs: number = 0): Promise<void> {
    const now = new Date().toISOString();
    await this.run(
      `INSERT INTO stats (date, polls, handled, ai_calls, ai_fails, total_latency_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         polls = stats.polls + excluded.polls,
         handled = stats.handled + excluded.handled,
         ai_calls = stats.ai_calls + excluded.ai_calls,
         ai_fails = stats.ai_fails + excluded.ai_fails,
         total_latency_ms = stats.total_latency_ms + excluded.total_latency_ms,
         updated_at = excluded.updated_at`,
      [date, polls, handled, aiCalls, aiFails, latencyMs, now, now]
    );
    Logger.debug("[D1] Stats updated", { date, polls, handled, aiCalls });
  }

  async getStatsByDate(date: string): Promise<DBStats | null> {
    return await this.first<DBStats>(`SELECT * FROM stats WHERE date = ?`, [date]);
  }

  async getStatsRange(startDate: string, endDate: string): Promise<DBStats[]> {
    return await this.all<DBStats>(
      `SELECT * FROM stats WHERE date >= ? AND date <= ? ORDER BY date ASC`,
      [startDate, endDate]
    );
  }

  async getTotalStats(): Promise<{ polls: number; handled: number; aiCalls: number; aiFails: number }> {
    const result = await this.first<{
      total_polls: number;
      total_handled: number;
      total_ai_calls: number;
      total_ai_fails: number;
    }>(
      `SELECT SUM(polls) as total_polls, SUM(handled) as total_handled, 
              SUM(ai_calls) as total_ai_calls, SUM(ai_fails) as total_ai_fails 
       FROM stats`
    );
    
    return {
      polls: result?.total_polls || 0,
      handled: result?.total_handled || 0,
      aiCalls: result?.total_ai_calls || 0,
      aiFails: result?.total_ai_fails || 0
    };
  }

  // ========== 工具方法 ==========

  getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  async deleteOldMessages(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffStr = cutoffDate.toISOString();
    
    const result = await this.run(`DELETE FROM messages WHERE created_at < ?`, [cutoffStr]);
    Logger.info("[D1] Old messages cleaned up", { deleted: result.changes });
  }

  async getMessageCount(): Promise<number> {
    return await this.firstValue<number>(`SELECT COUNT(*) as count FROM messages`, [], "count") || 0;
  }

  async getSessionCount(): Promise<number> {
    return await this.firstValue<number>(`SELECT COUNT(*) as count FROM sessions`, [], "count") || 0;
  }
}
