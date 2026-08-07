-- ============================================================
--  爪爪 ClawBot AI — D1 数据库 schema
--  ------------------------------------------------------------
--  说明:
--    此文件定义的表结构与 src/worker/services/d1.ts 保持一致。
--    运行时 D1Service.init() 也会执行相同的 CREATE TABLE IF NOT EXISTS，
--    但为避免首次使用时查询接口报"表不存在"，部署后建议手动执行一次：
--      wrangler d1 execute clawbot-db --remote --file=./schema.sql
-- ============================================================

-- 消息表（收到的微信消息 + AI 回复内容）
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

CREATE INDEX IF NOT EXISTS idx_messages_from_user_id ON messages(from_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);

-- 会话表（按用户聚合，记录每个用户最后一次消息时间与消息数）
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  last_message_at TEXT,
  message_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- 统计表（按日聚合的轮询/处理/AI 调用统计）
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

CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date);

-- MCP Server 配置表（存储 MCP 服务器地址、密钥、工具列表）
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  api_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  tool_prefix TEXT,
  tools TEXT,
  tools_fetched_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MCP 会话表（存储与 MCP 服务器的会话状态，用于 Streamable HTTP 传输）
CREATE TABLE IF NOT EXISTS mcp_sessions (
  server_id TEXT PRIMARY KEY,
  session_id TEXT,
  protocol_version TEXT,
  server_capabilities TEXT,
  expires_at INTEGER,
  updated_at TEXT NOT NULL
);
