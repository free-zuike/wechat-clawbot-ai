// ======================================================================
//  iLink 协议（微信 ClawBot）核心客户端 —— Cloudflare Worker 版
// ----------------------------------------------------------------------
//  参考: @tencent-weixin/openclaw-weixin 官方插件源码
//  API 基址: https://ilinkai.weixin.qq.com
// ======================================================================

export const I_LINK_BASE = "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

// ---------------------- 类型定义 ----------------------

export interface QRCodeResponse {
  ret: number;
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRCodeStatus {
  ret: number;
  status: "wait" | "scaned" | "expired" | "confirmed" | string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  errmsg?: string;
}

export interface WechatMessageItem {
  type: number; // 1=text
  text_item?: { text: string };
  image_item?: {
    resource_url?: string;
    thumb_url?: string;
  };
  file_item?: {
    name?: string;
    resource_url?: string;
    size?: number;
  };
  sys_item?: { content?: string };
}

export interface WechatMessage {
  msg_id: string;
  from_user_id: string; // 发送者 openid / user id
  to_user_id: string;   // 机器人 id
  create_time: number;
  msg_type: number;     // 一般 1
  context_token: string;
  item_list: WechatMessageItem[];
  session_info?: { session_id?: string };
}

export interface GetUpdatesResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
  msgs: WechatMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg: {
    to_user_id: string;
    context_token: string;
    item_list: {
      type: number;
      text_item?: { text: string };
    }[];
  };
}

export interface SendMessageResponse {
  ret: number;
  errcode?: number;
  errmsg?: string;
}

export interface LoginCredentials {
  token: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  createdAt: number;
}

// ---------------------- 工具函数 ----------------------

function randomUint32Base64(): string {
  // 生成随机 uint32 并做 base64
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let n = 0;
  for (let i = 0; i < 4; i++) n = (n * 256) + buf[i];
  // 注意: uint32 超出 JS 安全整数(> 2^53-1)不会发生在 32 位,所以直接处理
  const strN = n.toString();
  // base64 encode string
  const bytes = new TextEncoder().encode(strN);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUint32Base64(),
    "iLink-App-ClientVersion": "1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// ---------------------- 扫码登录 ----------------------

export async function getQRCode(): Promise<{ key: string; imgUrl: string }> {
  const url = `${I_LINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    // 避免 Cloudflare 缓存
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) throw new Error(`获取二维码失败 HTTP ${r.status}`);
  const data = (await r.json()) as QRCodeResponse;
  if (data.ret !== 0) throw new Error(`获取二维码失败 ret=${data.ret}`);
  return { key: data.qrcode, imgUrl: data.qrcode_img_content };
}

export async function getQRCodeStatus(
  qrCodeKey: string
): Promise<QRCodeStatus> {
  const url = `${I_LINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(
    qrCodeKey
  )}`;
  const r = await fetch(url, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!r.ok) return { ret: r.status, status: "wait" };
  return (await r.json()) as QRCodeStatus;
}

// ---------------------- 消息接收 ----------------------

export async function getUpdates(
  token: string,
  buf: string,
  baseUrl = I_LINK_BASE,
  timeoutMs = 25000
): Promise<GetUpdatesResponse> {
  const url = `${baseUrl}/ilink/bot/getupdates`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ get_updates_buf: buf }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.status === 200) {
      const data = (await r.json()) as GetUpdatesResponse;
      return data || { ret: 0, msgs: [], get_updates_buf: buf };
    }
    return { ret: r.status, msgs: [], get_updates_buf: buf };
  } catch (e) {
    return { ret: -1, msgs: [], get_updates_buf: buf };
  }
}

// ---------------------- 消息发送 ----------------------

export async function sendMessage(
  token: string,
  payload: SendMessageRequest,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  const url = `${baseUrl}/ilink/bot/sendmessage`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
    });
    if (r.status === 200) {
      const data = (await r.json()) as SendMessageResponse;
      return data || { ret: 0 };
    }
    return { ret: r.status, errmsg: `HTTP ${r.status}` };
  } catch (e) {
    return { ret: -1, errmsg: String(e) };
  }
}

// 发送简单文本回复
export async function replyText(
  token: string,
  toUserId: string,
  contextToken: string,
  text: string,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  // 超长文本按 1800 字符分段发送
  const chunks: string[] = [];
  const max = 1800;
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  let last: SendMessageResponse = { ret: 0 };
  for (const chunk of chunks) {
    last = await sendMessage(
      token,
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
      },
      baseUrl
    );
    // 加一点间隔,避免触发频率限制
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

// ---------------------- 输入状态 ----------------------

export async function sendTyping(
  token: string,
  toUserId: string,
  typing = true,
  baseUrl = I_LINK_BASE
): Promise<SendMessageResponse> {
  const url = `${baseUrl}/ilink/bot/sendtyping`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        to_user_id: toUserId,
        is_typing: typing ? 1 : 0,
      }),
    });
    if (r.status === 200) {
      const data = (await r.json()) as SendMessageResponse;
      return data || { ret: 0 };
    }
    return { ret: r.status };
  } catch {
    return { ret: -1 };
  }
}

// ---------------------- 消息提取 ----------------------

export function extractText(msg: WechatMessage): string {
  const parts: string[] = [];
  for (const it of msg.item_list || []) {
    if (it.type === 1 && it.text_item?.text) parts.push(it.text_item.text);
    else if (it.image_item) parts.push("[图片]");
    else if (it.file_item) parts.push(`[文件: ${it.file_item.name || "未知"}]`);
    else if (it.sys_item?.content) parts.push(`[系统: ${it.sys_item.content}]`);
  }
  return parts.join("\n").trim();
}
