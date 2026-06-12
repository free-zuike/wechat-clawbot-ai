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

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_from_user_id ON messages(from_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date);
`;

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

  // 初始化数据库（创建表和索引）
  async init(): Promise<void> {
    if (this.initialized) return;
    
    try {
      await this.db.exec(CREATE_MESSAGES_TABLE);
      await this.db.exec(CREATE_SESSIONS_TABLE);
      await this.db.exec(CREATE_STATS_TABLE);
      await this.db.exec(CREATE_INDEXES);
      this.initialized = true;
      Logger.info("[D1] Database initialized");
    } catch (error) {
      Logger.error("[D1] Failed to initialize database", { error: (error as Error).message });
      throw error;
    }
  }

  // ========== 消息操作 ==========

  async insertMessage(message: DBMessage): Promise<number> {
    const { message_id, from_user_id, to_user_id, content, message_type, context_token, created_at } = message;
    
    const result = await this.db.run(
      `INSERT OR IGNORE INTO messages 
       (message_id, from_user_id, to_user_id, content, message_type, context_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [message_id, from_user_id, to_user_id || null, content, message_type || 1, context_token || null, created_at]
    );
    
    Logger.debug("[D1] Message inserted", { message_id, changes: result.changes });
    return result.lastInsertRowId || 0;
  }

  async updateMessageReply(messageId: string, replyContent: string): Promise<void> {
    await this.db.run(
      `UPDATE messages SET processed = TRUE, reply_content = ?, reply_at = ? WHERE message_id = ?`,
      [replyContent, new Date().toISOString(), messageId]
    );
    Logger.debug("[D1] Message reply updated", { messageId });
  }

  async getMessageById(messageId: string): Promise<DBMessage | null> {
    const result = await this.db.get(`SELECT * FROM messages WHERE message_id = ?`, [messageId]);
    return result as DBMessage || null;
  }

  async getMessagesByUser(userId: string, limit: number = 50): Promise<DBMessage[]> {
    const results = await this.db.all(
      `SELECT * FROM messages WHERE from_user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit]
    );
    return results as DBMessage[];
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.db.run(`DELETE FROM messages WHERE message_id = ?`, [messageId]);
    Logger.debug("[D1] Message deleted", { messageId });
  }

  async getUnprocessedMessages(limit: number = 100): Promise<DBMessage[]> {
    const results = await this.db.all(
      `SELECT * FROM messages WHERE processed = FALSE ORDER BY created_at ASC LIMIT ?`,
      [limit]
    );
    return results as DBMessage[];
  }

  // ========== 会话操作 ==========

  async upsertSession(userId: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.get(`SELECT * FROM sessions WHERE user_id = ?`, [userId]);
    
    if (existing) {
      await this.db.run(
        `UPDATE sessions SET last_message_at = ?, message_count = message_count + 1, updated_at = ? WHERE user_id = ?`,
        [now, now, userId]
      );
    } else {
      await this.db.run(
        `INSERT INTO sessions (user_id, last_message_at, message_count, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
        [userId, now, now, now]
      );
    }
    Logger.debug("[D1] Session updated", { userId });
  }

  async getSession(userId: string): Promise<DBSession | null> {
    const result = await this.db.get(`SELECT * FROM sessions WHERE user_id = ?`, [userId]);
    return result as DBSession || null;
  }

  async getAllSessions(limit: number = 100): Promise<DBSession[]> {
    const results = await this.db.all(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`, [limit]);
    return results as DBSession[];
  }

  async deleteSession(userId: string): Promise<void> {
    await this.db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    Logger.debug("[D1] Session deleted", { userId });
  }

  // ========== 统计操作 ==========

  async incrementStats(date: string, polls: number = 0, handled: number = 0, aiCalls: number = 0, aiFails: number = 0, latencyMs: number = 0): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.get(`SELECT * FROM stats WHERE date = ?`, [date]);
    
    if (existing) {
      await this.db.run(
        `UPDATE stats 
         SET polls = polls + ?, handled = handled + ?, ai_calls = ai_calls + ?, ai_fails = ai_fails + ?, 
             total_latency_ms = total_latency_ms + ?, updated_at = ? 
         WHERE date = ?`,
        [polls, handled, aiCalls, aiFails, latencyMs, now, date]
      );
    } else {
      await this.db.run(
        `INSERT INTO stats (date, polls, handled, ai_calls, ai_fails, total_latency_ms, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [date, polls, handled, aiCalls, aiFails, latencyMs, now, now]
      );
    }
    Logger.debug("[D1] Stats updated", { date, polls, handled, aiCalls });
  }

  async getStatsByDate(date: string): Promise<DBStats | null> {
    const result = await this.db.get(`SELECT * FROM stats WHERE date = ?`, [date]);
    return result as DBStats || null;
  }

  async getStatsRange(startDate: string, endDate: string): Promise<DBStats[]> {
    const results = await this.db.all(
      `SELECT * FROM stats WHERE date >= ? AND date <= ? ORDER BY date ASC`,
      [startDate, endDate]
    );
    return results as DBStats[];
  }

  async getTotalStats(): Promise<{ polls: number; handled: number; aiCalls: number; aiFails: number }> {
    const result = await this.db.get(
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
    
    const result = await this.db.run(`DELETE FROM messages WHERE created_at < ?`, [cutoffStr]);
    Logger.info("[D1] Old messages cleaned up", { deleted: result.changes });
  }

  async getMessageCount(): Promise<number> {
    const result = await this.db.get(`SELECT COUNT(*) as count FROM messages`);
    return result?.count || 0;
  }

  async getSessionCount(): Promise<number> {
    const result = await this.db.get(`SELECT COUNT(*) as count FROM sessions`);
    return result?.count || 0;
  }
}