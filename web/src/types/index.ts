// 前后端共用的 TypeScript 类型定义（前端版本）

// ========== 消息相关类型 ==========
export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; encode_type?: number; playtime?: number };
  image_item?: { url?: string; cdn_url?: string; width?: number; height?: number };
  file_item?: { url?: string; cdn_url?: string; file_name?: string; file_size?: number };
  video_item?: { url?: string; cdn_url?: string; thumb_url?: string; width?: number; height?: number; duration?: number };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: MessageItem[];
  create_time_ms?: number;
}

// ========== 状态相关类型 ==========
export interface LoginStatus {
  loggedIn: boolean;
  status: 'logged_in' | 'not_logged_in';
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  loginAgeMs?: number;
  loginAgeText?: string;
  hasSyncBuf?: boolean;
  tokenHealth?: string;
  msgsCount?: number;
}

export interface Stats {
  polls: number;
  handled: number;
  aiCalls: number;
  aiFails: number;
  lastPollAt: string;
  lastLatencyMs: number;
}

export interface FullStatus extends LoginStatus {
  stats?: Stats;
}

// ========== 配置相关类型 ==========
export interface ClawBotConfig {
  aiModel: string;
  aiSystemPrompt: string;
}

export interface ConfigResponse {
  ok?: boolean;
  error?: string;
  aiModel?: string;
  aiSystemPrompt?: string;
}

// ========== 响应相关类型 ==========
export interface ApiResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ChatResponse {
  reply: string;
  source?: 'ai' | 'shortcut';
  error?: string;
}

export interface ProcessResult {
  pulled: number;
  handled: number;
  skipped?: number;
  error?: string;
  latencyMs: number;
}

// ========== 错误相关类型 ==========
export interface ApiError {
  code: string;
  message: string;
  status: number;
  raw?: any;
}

// ========== 调试相关类型 ==========
export interface DebugResult {
  ok: boolean;
  savedInfo?: {
    botTokenPrefix?: string;
    botTokenLen?: number;
    baseUrl?: string;
    accountId?: string;
    userId?: string;
    syncBuf?: string;
    loginAgeMs?: number;
    rawResponseKeys?: string[];
  };
  networkTest?: boolean;
  getUpdatesResult?: {
    msgsCount?: number;
    gotNewBuf?: boolean;
    success?: boolean;
    ret?: number;
    errcode?: number;
    errmsg?: string;
  };
  serverTime?: string;
}