// iLink 协议实现 - 基于 weixin-ilink SDK 逆向（源自 @tencent-weixin/openclaw-weixin）

import { Logger, withRetry, ClawBotError } from "../utils/error";
import type { WeixinMessage, MessageItem, GetUpdatesResp, ILinkCredentials } from "../types";

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

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

  const startTime = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  
  try {
    Logger.debug(`[iLink] POST ${endpoint}`, { url, payloadSize: body.length });
    const r = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const duration = Date.now() - startTime;
    clearTimeout(timer);
    
    const text = await r.text();
    Logger.debug(`[iLink] POST ${endpoint} completed`, { status: r.status, durationMs: duration });
    
    if (!r.ok) {
      Logger.warn(`[iLink] POST ${endpoint} failed`, { status: r.status, response: text });
      throw new ClawBotError('ILINK_HTTP_ERROR', `${endpoint} HTTP ${r.status}`, 502, { status: r.status, response: text });
    }
    
    try {
      const json = JSON.parse(text);
      if (json.errcode && json.errcode !== 0) {
        Logger.warn(`[iLink] ${endpoint} returned error`, { errcode: json.errcode, errmsg: json.errmsg });
        if (json.errcode === -14) {
          throw new ClawBotError('ILINK_SESSION_TIMEOUT', 'Session timeout', 401, { errcode: json.errcode, errmsg: json.errmsg });
        }
      }
      return json;
    } catch (parseError) {
      Logger.warn(`[iLink] Failed to parse response`, { error: parseError.message, response: text });
      throw new ClawBotError('ILINK_PARSE_ERROR', 'Failed to parse response', 502, { error: parseError.message });
    }
  } catch (e) {
    clearTimeout(timer);
    const duration = Date.now() - startTime;
    if (e instanceof ClawBotError) throw e;
    if ((e as any)?.name === "AbortError") {
      Logger.debug(`[iLink] ${endpoint} timeout after ${duration}ms`);
      throw e;
    }
    Logger.error(`[iLink] ${endpoint} error`, { error: (e as Error)?.message, durationMs: duration });
    throw new ClawBotError('ILINK_NETWORK_ERROR', `Network error: ${(e as Error)?.message}`, 503);
  }
}

// ========== 扫码登录 ==========
export async function fetchQRCode(baseUrl = DEFAULT_BASE): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=3`;
  
  Logger.debug(`[iLink] Fetching QR code`, { url });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const r = await fetch(url, { signal: ctrl.signal });
  clearTimeout(timer);
  
  if (!r.ok) {
    Logger.error(`[iLink] Failed to fetch QR code`, { status: r.status });
    throw new ClawBotError('ILINK_QRCODE_ERROR', `获取二维码失败: ${r.status}`, 502);
  }
  
  const data = await r.json();
  if (!data.qrcode || !data.qrcode_img_content) {
    Logger.error(`[iLink] Invalid QR code response`, { response: JSON.stringify(data) });
    throw new ClawBotError('ILINK_QRCODE_ERROR', '返回数据无效', 502);
  }
  
  Logger.info(`[iLink] QR code fetched successfully`);
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
  const timer = setTimeout(() => ctrl.abort(), 25000);
  
  try {
    Logger.debug(`[iLink] Polling QR status`, { qrcode: maskToken(qrcode) });
    const r = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal: ctrl.signal });
    clearTimeout(timer);
    
    if (!r.ok) {
      Logger.warn(`[iLink] QR status poll failed`, { status: r.status });
      return { status: "wait" };
    }
    
    const data = await r.json();
    const s = data?.status;
    
    const result = {
      status: s || "wait",
      bot_token: data.bot_token,
      ilink_bot_id: data.ilink_bot_id,
      baseurl: data.baseurl,
      ilink_user_id: data.ilink_user_id,
      raw: data,
    };
    
    if (s === "confirmed") {
      Logger.info(`[iLink] QR status confirmed`, { 
        ilink_bot_id: maskToken(data.ilink_bot_id || ""),
        baseurl: data.baseurl 
      });
    } else if (s === "expired") {
      Logger.warn(`[iLink] QR code expired`);
    }
    
    return result;
  } catch {
    clearTimeout(timer);
    Logger.debug(`[iLink] QR status poll timeout or error`);
    return { status: "wait" };
  }
}

// ========== 消息拉取（长轮询 35 秒）==========
export async function getUpdates(
  creds: ILinkCredentials,
  buf: string = "",
): Promise<GetUpdatesResp> {
  Logger.debug(`[iLink] Getting updates`, { buf: maskToken(buf) });
  
  try {
    const resp = await withRetry(
      () => post(creds, "ilink/bot/getupdates", { get_updates_buf: buf }, DEFAULT_LONG_POLL_MS),
      {
        retries: 2,
        baseDelayMs: 1000,
        onRetry: (attempt, error) => Logger.warn(`[iLink] Retrying getUpdates (attempt ${attempt})`, { error: error.message }),
        shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
      }
    );
    
    const result = resp as GetUpdatesResp;
    
    if (result.get_updates_buf && result.get_updates_buf !== buf) {
      Logger.debug(`[iLink] Updates received`, { msgsCount: result.msgs?.length, bufChanged: true });
    }
    
    return result;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      Logger.debug(`[iLink] getUpdates timeout`);
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw e;
  }
}

// ========== 发送输入状态 ==========
export async function sendTypingStatus(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  typing: boolean,
): Promise<void> {
  try {
    // 第一步：获取 typing_ticket
    const configResp = await post(creds, "ilink/bot/getconfig", {
      ilink_user_id: toUserId,
      context_token: contextToken,
    }, DEFAULT_API_MS);
    const typingTicket = configResp?.typing_ticket;
    if (!typingTicket) return;

    // 第二步：发送 typing 状态
    await post(creds, "ilink/bot/sendtyping", {
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
    }, DEFAULT_API_MS);
  } catch {
    // typing 状态失败不影响主流程
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
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
  
  Logger.debug(`[iLink] Sending message`, { 
    toUserId: maskToken(toUserId), 
    textLength: text.length 
  });
  
  await withRetry(
    () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
    {
      retries: 2,
      baseDelayMs: 500,
      onRetry: (attempt, error) => Logger.warn(`[iLink] Retrying sendMessage (attempt ${attempt})`, { error: error.message }),
      shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
    }
  );
  
  Logger.debug(`[iLink] Message sent successfully`);
}

// ========== 分段发送长消息 ==========
export async function sendTextChunked(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  text: string,
  maxLength: number = 4000,
): Promise<number> {
  if (text.length <= maxLength) {
    await sendTextMessage(creds, toUserId, contextToken, text);
    return 1;
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }

  for (const chunk of chunks) {
    await sendTextMessage(creds, toUserId, contextToken, chunk);
  }

  Logger.info(`[iLink] Message chunked`, { total: text.length, chunks: chunks.length });
  return chunks.length;
}

// ========== 媒体上传 ==========
export async function getUploadUrl(
  creds: ILinkCredentials,
  fileType: number,
  fileName: string,
  fileSize: number,
): Promise<{ upload_url: string; file_id: string }> {
  const resp = await post(creds, "ilink/bot/getuploadurl", {
    file_type: fileType,
    file_name: fileName,
    file_size: fileSize,
  }, DEFAULT_API_MS);
  Logger.info("[iLink] getUploadUrl full response", { response: JSON.stringify(resp).slice(0, 500) });
  // 尝试多种字段名
  const uploadUrl = resp.upload_url || resp.url || resp.uploadUrl || resp.data?.upload_url || resp.data?.url || "";
  const fileId = resp.file_id || resp.fileId || resp.data?.file_id || resp.data?.fileId || "";
  Logger.info("[iLink] getUploadUrl parsed", { upload_url: uploadUrl, file_id: fileId });
  return { upload_url: uploadUrl, file_id: fileId };
}

export async function uploadFile(
  uploadUrl: string,
  fileData: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);

  try {
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: fileData,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      throw new ClawBotError('ILINK_UPLOAD_FAILED', `Upload failed: ${resp.status}`, 502);
    }
    Logger.info("[iLink] File uploaded successfully");
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    throw new ClawBotError('ILINK_UPLOAD_FAILED', `Upload error: ${(e as Error).message}`, 502);
  }
}

export async function sendMediaMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  item: MessageItem,
): Promise<void> {
  const msg: WeixinMessage = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [item],
  };

  await withRetry(
    () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
    {
      retries: 2,
      baseDelayMs: 500,
      shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
    }
  );

  Logger.debug("[iLink] Media message sent");
}

// ========== 高级媒体发送（获取上传URL → 上传 → 发送）==========
export async function uploadAndSendMedia(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  fileType: number,
  fileName: string,
  fileData: ArrayBuffer,
  contentType: string,
): Promise<void> {
  // 1. 获取预签名上传 URL
  const { upload_url } = await getUploadUrl(creds, fileType, fileName, fileData.byteLength);

  // 2. 上传文件到 CDN
  await uploadFile(upload_url, fileData, contentType);

  // 3. 构造媒体消息
  let item: MessageItem;
  if (fileType === MessageItemType.IMAGE) {
    item = { type: MessageItemType.IMAGE, image_item: { cdn_url: upload_url, url: upload_url, width: 0, height: 0 } };
  } else if (fileType === MessageItemType.FILE) {
    item = { type: MessageItemType.FILE, file_item: { url: upload_url, file_name: fileName, file_size: fileData.byteLength } };
  } else if (fileType === MessageItemType.VOICE) {
    item = { type: MessageItemType.VOICE, voice_item: { text: "", encode_type: 0, playtime: 0 } };
  } else if (fileType === MessageItemType.VIDEO) {
    item = { type: MessageItemType.VIDEO, video_item: { url: upload_url, thumb_url: "", width: 0, height: 0, duration: 0 } };
  } else {
    throw new ClawBotError('ILINK_INVALID_MEDIA', `Unsupported file type: ${fileType}`);
  }

  // 4. 发送媒体消息
  await sendMediaMessage(creds, toUserId, contextToken, item);
}

// ========== 发送图片消息（优先下载+上传 CDN，iLink 可能无法加载外部 URL）==========
export async function sendImageMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  imageUrl: string,
  apiKey?: string,
): Promise<void> {
  // 方式1：下载图片后上传到 CDN 发送（最可靠）
  try {
    const dlHeaders: Record<string, string> = {};
    if (apiKey) dlHeaders["Authorization"] = `Bearer ${apiKey}`;
    const imgResp = await fetch(imageUrl, { headers: dlHeaders, signal: AbortSignal.timeout(60000) });
    if (imgResp.ok) {
      const buffer = await imgResp.arrayBuffer();
      const contentType = imgResp.headers.get("content-type") || "image/png";
      await uploadAndSendMedia(creds, toUserId, contextToken, MessageItemType.IMAGE, "generated.png", buffer, contentType);
      Logger.info("[iLink] Image sent via upload");
      return;
    }
  } catch (e: any) {
    Logger.warn("[iLink] Upload image failed, trying direct URL", { error: e?.message });
  }

  // 方式2：回退到直接发送带 URL 的图片消息
  const msg: WeixinMessage = {
    from_user_id: "",
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{
      type: MessageItemType.IMAGE,
      image_item: { url: imageUrl, cdn_url: imageUrl, width: 0, height: 0 },
    }],
  };

  try {
    await withRetry(
      () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
      {
        retries: 2,
        baseDelayMs: 500,
        shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
      }
    );
    Logger.info("[iLink] Image message sent via direct URL fallback");
    return;
  } catch (e: any) {
    Logger.warn("[iLink] Direct image URL send also failed", { error: e?.message });
  }

  throw new ClawBotError('ILINK_IMAGE_SEND_FAILED', 'All image send methods failed');
}
// ========== 发送视频消息 ==========
export async function sendVideoMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  videoUrl: string,
  apiKey?: string,
): Promise<void> {
  // iLink 协议不支持直接用外部 URL 发送视频，需要先下载再上传到 CDN
  // 失败时不降级，让上层（checkPendingVideos / 消息处理）决定跨 cron 重试
  await sendFileFromUrl(creds, toUserId, contextToken, videoUrl, MessageItemType.VIDEO, "generated_video.mp4", apiKey);
  Logger.info("[iLink] Video message sent (download + upload)");
}

export async function sendFileFromUrl(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  fileUrl: string,
  fileType: number,
  fileName: string,
  apiKey?: string,
): Promise<void> {
  // 下载文件（带 API Key 认证，部分提供商的媒体 URL 需要鉴权）
  // 媒体刚生成时 CDN 可能短暂不可用（502），重试几次
  // 注意：Agnes 返回的视频 URL 是 Google Cloud Storage 的，可能不需要/不接受 Agnes 的 API Key
  const maxRetries = 6;
  let resp: Response | null = null;
  let lastError: string | null = null;

  // 先尝试不带 Authorization 头（适用于公开 CDN URL）
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {};
      // 第 1-2 次尝试不带 Authorization（公开 CDN），后面尝试带 Authorization（需要鉴权的 URL）
      if (attempt >= 2 && apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      resp = await fetch(fileUrl, { headers, signal: AbortSignal.timeout(60000) });
      if (resp.ok) break;
      const errBody = await resp.text().catch(() => "");
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });
      lastError = `HTTP ${resp.status}`;
      Logger.warn("[iLink] Download attempt failed, retrying", {
        attempt: attempt + 1,
        status: resp.status,
        url: fileUrl.substring(0, 120),
        headersSent: Object.keys(headers).map(h => h.toLowerCase()),
        contentType: resp.headers.get("content-type"),
        body: errBody.slice(0, 500),
        responseHeaders: Object.entries(respHeaders).map(([k, v]) => `${k}=${v.slice(0, 80)}`),
      });
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
      }
    } catch (e: any) {
      lastError = e?.message || String(e);
      Logger.warn("[iLink] Download attempt failed with exception, retrying", {
        attempt: attempt + 1,
        error: lastError,
        url: fileUrl.substring(0, 120),
      });
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
      }
    }
  }

  if (!resp || !resp.ok) {
    throw new ClawBotError('ILINK_DOWNLOAD_FAILED', `Download failed after ${maxRetries} retries: ${lastError}`);
  }

  const buffer = await resp.arrayBuffer();
  const contentType = resp.headers.get("content-type") || "application/octet-stream";

  await uploadAndSendMedia(creds, toUserId, contextToken, fileType, fileName, buffer, contentType);
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

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return token.substring(0, 8) + "***" + token.substring(token.length - 4);
}

export function extractMessageText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  
  const parts: string[] = [];
  
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      if (ref?.title) {
        parts.push(`[引用: ${ref.title}]\n${item.text_item.text}`);
      } else {
        parts.push(item.text_item.text);
      }
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      const playtime = item.voice_item.playtime ? `（${item.voice_item.playtime}秒）` : "";
      parts.push(`🎤 [语音转文字${playtime}]: ${item.voice_item.text}`);
    }
    if (item.type === MessageItemType.IMAGE) {
      const url = item.image_item?.cdn_url || item.image_item?.url;
      const size = item.image_item?.width && item.image_item?.height 
        ? `${item.image_item.width}x${item.image_item.height}` 
        : "";
      parts.push(`🖼️ [图片${size}]: ${url || "图片消息"}`);
    }
    if (item.type === MessageItemType.FILE) {
      const name = item.file_item?.file_name || "文件";
      const size = item.file_item?.file_size 
        ? formatFileSize(item.file_item.file_size) 
        : "";
      parts.push(`📎 [文件${size}]: ${name}`);
    }
    if (item.type === MessageItemType.VIDEO) {
      const url = item.video_item?.cdn_url || item.video_item?.url;
      const duration = item.video_item?.duration 
        ? formatDuration(item.video_item.duration) 
        : "";
      parts.push(`🎬 [视频${duration}]: ${url || "视频消息"}`);
    }
    if (!item.type || item.type === MessageItemType.NONE) {
      // 未知类型，尝试提取文本
      if (item.text_item?.text) {
        parts.push(item.text_item.text);
      }
    }
  }
  
  return parts.join("\n") || "";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}秒`;
}
