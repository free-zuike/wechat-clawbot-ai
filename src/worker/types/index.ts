// 前后端共用的 TypeScript 类型定义

// ========== 消息相关类型 ==========
// CDN 媒体引用（iLink 协议要求）
export interface CDNMedia {
  /** CDN 下载加密参数（来自 getuploadurl 或上传响应头 x-encrypted-param） */
  encrypt_query_param?: string;
  /** AES-128 key，base64 编码 */
  aes_key?: string;
  /** 加密类型: 0=仅加密 fileid, 1=打包缩略图/中图等信息 */
  encrypt_type?: number;
}

// ========== 消息相关类型 ==========
export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; encode_type?: number; playtime?: number };
  /** 新协议：iLink CDN 媒体引用 */
  image_item?: {
    media?: CDNMedia;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    /** 兼容旧格式 */
    url?: string;
    cdn_url?: string;
    width?: number;
    height?: number;
  };
  file_item?: {
    media?: CDNMedia;
    file_name?: string;
    file_size?: number;
    /** 兼容旧格式 */
    url?: string;
    cdn_url?: string;
  };
  video_item?: {
    media?: CDNMedia;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
    thumb_media?: CDNMedia;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    /** 兼容旧格式 */
    url?: string;
    cdn_url?: string;
    thumb_url?: string;
    width?: number;
    height?: number;
    duration?: number;
  };
  ref_msg?: { title?: string; message_item?: MessageItem };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface ILinkCredentials {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId?: string;
}

// ========== 消息类型常量 ==========
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

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
  bufUpdated?: boolean;
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
  aiMaxTokens: number;
  aiTemperature: number;
}

export interface ConfigResponse {
  ok?: boolean;
  error?: string;
  aiModel?: string;
  aiSystemPrompt?: string;
}

// ========== 上下文相关类型 ==========
export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface UserContext {
  userId: string;
  messages: ContextMessage[];
  lastUpdated: number;
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

// ========== D1 数据库类型 ==========
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

export interface DBSession {
  id?: number;
  user_id: string;
  last_message_at?: string;
  message_count?: number;
  created_at: string;
  updated_at: string;
}

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

// ========== MCP (Model Context Protocol) 相关类型 ==========
export interface MCPServer {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  toolPrefix?: string;
  tools?: MCPToolDef[];
  toolsFetchedAt?: number;
}

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  serverId: string;
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