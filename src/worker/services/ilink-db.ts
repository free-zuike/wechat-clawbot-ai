// iLink Durable Object - 数据库初始化与迁移
// 集中管理 DO SQLite 和 D1 的表创建与列迁移

import { Logger } from "../utils/error";

// ========== DO SQLite 初始化 ==========

export async function initSQLite(sql: SqlStorage): Promise<void> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bot_token TEXT NOT NULL,
      account_id TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT 'https://ilinkai.weixin.qq.com',
      user_id TEXT NOT NULL,
      sync_buf TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await sql.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      user_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL DEFAULT '[]',
      last_updated INTEGER NOT NULL
    )
  `);

  await sql.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);

  await sql.exec(`
    CREATE TABLE IF NOT EXISTS pending_videos (
      task_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      video_url TEXT,
      video_id TEXT,
      to_user_id TEXT,
      context_token TEXT,
      account_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  await sql.exec(`
    CREATE TABLE IF NOT EXISTS generation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      prompt TEXT,
      result TEXT,
      provider TEXT,
      model TEXT,
      status TEXT DEFAULT 'success',
      error TEXT,
      source TEXT,
      from_user TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  Logger.info("[DO] SQLite tables initialized");
}

// ========== D1 初始化 ==========

export async function initD1Tables(db: D1Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS generation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      prompt TEXT,
      result TEXT,
      provider TEXT,
      model TEXT,
      status TEXT DEFAULT 'success',
      error TEXT,
      source TEXT,
      from_user TEXT,
      key_index INTEGER DEFAULT 0,
      provider_name TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_videos (
      task_id TEXT PRIMARY KEY,
      video_id TEXT,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      video_url TEXT,
      to_user_id TEXT,
      context_token TEXT,
      account_id TEXT,
      source TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      user_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL DEFAULT '[]',
      last_updated INTEGER NOT NULL
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  Logger.info("[DO] D1 tables initialized");
}

// ========== 列迁移 ==========

export async function ensurePendingVideosColumns(sql: SqlStorage): Promise<void> {
  try {
    const info = await sql.exec("PRAGMA table_info(pending_videos)");
    if (!info) return;
    const rows = info.toArray ? info.toArray() : [];
    const cols = new Set(rows.map((r: any) => r.name as string));
    const needAdd: [string, string][] = [
      ["to_user_id", "TEXT"],
      ["context_token", "TEXT"],
      ["account_id", "TEXT"],
      ["video_id", "TEXT"],
      ["source", "TEXT"],
      ["error_message", "TEXT"],
      ["retry_count", "INTEGER DEFAULT 0"],
      ["key_index", "INTEGER DEFAULT 0"],
      ["provider_name", "TEXT"],
    ];
    for (const [col, type] of needAdd) {
      if (!cols.has(col)) {
        await sql.exec(`ALTER TABLE pending_videos ADD COLUMN ${col} ${type}`);
        Logger.info("[DO] pending_videos column added", { column: col });
      }
    }
  } catch (e: any) {
    Logger.warn("[DO] pending_videos column check failed", { error: e?.message });
  }
}

export async function ensureGenerationLogsColumns(sql: SqlStorage): Promise<void> {
  try {
    const info = await sql.exec("PRAGMA table_info(generation_logs)");
    if (!info) return;
    const rows = info.toArray ? info.toArray() : [];
    const cols = new Set(rows.map((r: any) => r.name as string));
    const needAdd: [string, string][] = [
      ["key_index", "INTEGER DEFAULT 0"],
      ["provider_name", "TEXT"],
    ];
    for (const [col, type] of needAdd) {
      if (!cols.has(col)) {
        await sql.exec(`ALTER TABLE generation_logs ADD COLUMN ${col} ${type}`);
        Logger.info("[DO] generation_logs column added", { column: col });
      }
    }
  } catch (e: any) {
    Logger.warn("[DO] generation_logs column check failed", { error: e?.message });
  }
}

// ========== 凭证操作 ==========

export interface CredentialsRow {
  bot_token: string;
  account_id: string;
  base_url: string;
  user_id: string;
  sync_buf: string;
}

export async function loadCredentials(sql: SqlStorage): Promise<CredentialsRow | null> {
  try {
    const result = sql.exec("SELECT bot_token, account_id, base_url, user_id, sync_buf FROM credentials WHERE id = 1");
    if (!result) return null;
    const rows = result.toArray ? result.toArray() : [];
    if (rows.length === 0) return null;
    const row = rows[0] as any;
    return {
      bot_token: row.bot_token,
      account_id: row.account_id,
      base_url: row.base_url,
      user_id: row.user_id,
      sync_buf: row.sync_buf || "",
    };
  } catch {
    return null;
  }
}

export async function saveCredentials(sql: SqlStorage, creds: { botToken: string; accountId: string; baseUrl: string; userId: string; syncBuf: string }): Promise<void> {
  const now = Date.now();
  sql.exec(
    `INSERT INTO credentials (id, bot_token, account_id, base_url, user_id, sync_buf, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bot_token = excluded.bot_token, account_id = excluded.account_id,
       base_url = excluded.base_url, user_id = excluded.user_id,
       sync_buf = excluded.sync_buf, updated_at = excluded.updated_at`,
    creds.botToken, creds.accountId, creds.baseUrl, creds.userId, creds.syncBuf, now, now
  );
}

export async function clearCredentials(sql: SqlStorage): Promise<void> {
  sql.exec("DELETE FROM credentials WHERE id = 1");
}

export async function loadAllCredentials(sql: SqlStorage): Promise<CredentialsRow[]> {
  try {
    const result = sql.exec("SELECT bot_token, account_id, base_url, user_id, sync_buf FROM credentials");
    if (!result) return [];
    return (result.toArray ? result.toArray() : []).map((r: any) => ({
      bot_token: r.bot_token,
      account_id: r.account_id,
      base_url: r.base_url,
      user_id: r.user_id,
      sync_buf: r.sync_buf || "",
    }));
  } catch {
    return [];
  }
}