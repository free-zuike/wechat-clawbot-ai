// iLink 协议实现 - 基于 weixin-ilink SDK 逆向（源自 @tencent-weixin/openclaw-weixin）

// ========== 类型定义 ==========
export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string; encode_type?: number; playtime?: number };
  image_item?: { url?: string; cdn_url?: string; width?: number; height?: number };
  file_item?: { url?: string; cdn_url?: string; file_name?: string; file_size?: number };
  video_item?: { url?: string; cdn_url?: string; thumb_url?: string; width?: number; height?: number; duration?: number };
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

// ========== 常量 ==========
const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_CHANNEL_VERSION = "weixin-ilink/0.1.0";
const DEFAULT_LONG_POLL_MS = 35000;
const DEFAULT_API_MS = 15000;

// ========== 工具: 生成随机 X-WECHAT-UIN (Cloudflare Workers 兼容)
function randomWechatUin(): string {
  const rand = Math.floor(Math.random() * 1_000_000_000);
  const str = String(rand);
  if (typeof btoa === "function") {
    try {
      return btoa(str);
    } catch {}
  }
  // fallback: 十六进制
  return rand.toString(16);
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

async function post(
  creds: ILinkCredentials,
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const channelVersion = DEFAULT_CHANNEL_VERSION;
  const base = creds.baseUrl.endsWith("/") ? creds.baseUrl : creds.baseUrl + "/";
  const url = base + endpoint;
  const body = JSON.stringify({ ...payload, base_info: { channel_version: channelVersion } });
  const headers = buildHeaders(creds.botToken);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await r.text();
    if (!r.ok) throw new Error(`${endpoint} ${r.status}: ${text}`);
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ========== 扫码登录 ==========
export async function fetchQRCode(baseUrl = DEFAULT_BASE): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=3`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`获取二维码失败: ${r.status}`);
  const data = await r.json();
  return { qrcode: data.qrcode, qrcode_img_content: data.qrcode_img_content };
}

export async function getQRCodeStatus(qrcode: string, baseUrl = DEFAULT_BASE): Promise<{
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  raw?: any;
}> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35000);
  try {
    const r = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return { status: "wait" };
    const data = await r.json();
    const s = data?.status;
    return {
      status: s || "wait",
      bot_token: data.bot_token,
      ilink_bot_id: data.ilink_bot_id,
      baseurl: data.baseurl,
      ilink_user_id: data.ilink_user_id,
      raw: data,
    };
  } catch {
    clearTimeout(timer);
    return { status: "wait" };
  }
}

// ========== 消息拉取（长轮询 35 秒）==========
export async function getUpdates(
  creds: ILinkCredentials,
  buf: string = "",
): Promise<GetUpdatesResp> {
  try {
    const resp = await post(creds, "ilink/bot/getupdates", { get_updates_buf: buf }, DEFAULT_LONG_POLL_MS);
    return resp as GetUpdatesResp;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw e;
  }
}

// ========== 发送消息 ==========
export async function sendTextMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const msg: WeixinMessage = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } },
  };
  await post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS);
}

// ========== 工具 ==========
function generateClientId(): string {
  const arr = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  return `ilink-${Date.now()}-${hex}`;
}

export function extractMessageText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      if (ref?.title) return `[引用: ${ref.title}]\n${item.text_item.text}`;
      return item.text_item.text;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}
