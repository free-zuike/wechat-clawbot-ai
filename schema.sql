-- ============================================================
--  爪爪 ClawBot AI — D1 统计数据库 schema
--  ------------------------------------------------------------
--  初始化:
--    wrangler d1 create clawbot-stats
--    wrangler d1 execute clawbot-stats --file=./schema.sql
-- ============================================================

-- 每小时一条聚合统计（不做更细粒度, 省 D1 写入额度）
CREATE TABLE IF NOT EXISTS stats_hourly (
    hour_unix INTEGER NOT NULL PRIMARY KEY,       -- 小时整点时间戳 (UTC)
    polls INTEGER NOT NULL DEFAULT 0,
    handled INTEGER NOT NULL DEFAULT 0,
    shortcuts INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    ai_fails INTEGER NOT NULL DEFAULT 0,
    max_consecutive_fails INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stats_hourly_time ON stats_hourly (hour_unix DESC);

-- 最近错误（最多保留 200 条, 超出自动删最早的）
CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,          -- 'ai' / 'ilink' / 'network'
    message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors (ts DESC);
