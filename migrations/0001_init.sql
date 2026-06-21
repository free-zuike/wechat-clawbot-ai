-- generation_logs: 生成记录（文字/图片/视频）
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
);

-- pending_videos: 待处理的视频生成任务
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
);
