// iLink 协议 - 消息发送与媒体上传
// 从 ilink.ts 拆出：HTTP POST 传输、消息发送、媒体发送、CDN 下载

import { Logger, withRetry, ClawBotError } from "../utils/error";
import { md5Hex } from "../utils/md5";
import { uploadMediaToCdn, UploadMediaType } from "./cdn-upload";
import { MessageType, MessageItemType, MessageState, TypingStatus, DEFAULT_API_MS, DEFAULT_CHANNEL_VERSION } from "./ilink-constants";
import type { WeixinMessage, MessageItem, ILinkCredentials } from "../types";
import { extractMp4Duration } from "./ilink-parse";

// ========== 工具 ==========

function randomWechatUin(): string {
  const rand = Math.floor(Math.random() * 1_000_000_000);
  const str = String(rand);
  if (typeof btoa === "function") {
    try { return btoa(str); } catch {}
  }
  return rand.toString(16);
}

// SKRouteTag 从环境变量或全局变量读取（可选）
let cachedRouteTag: string | null = null;
function getRouteTag(): string | null {
  if (cachedRouteTag !== null) return cachedRouteTag;
  try {
    if (typeof globalThis !== "undefined" && (globalThis as any).__SK_ROUTE_TAG) {
      cachedRouteTag = (globalThis as any).__SK_ROUTE_TAG;
      return cachedRouteTag;
    }
  } catch {}
  return null;
}

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  const routeTag = getRouteTag();
  if (routeTag) headers["SKRouteTag"] = routeTag;
  return headers;
}

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

// MessageItemType → UploadMediaType 映射
function toUploadMediaType(messageItemType: number): number {
  switch (messageItemType) {
    case MessageItemType.IMAGE: return UploadMediaType.IMAGE;
    case MessageItemType.VIDEO: return UploadMediaType.VIDEO;
    case MessageItemType.FILE: return UploadMediaType.FILE;
    case MessageItemType.VOICE: return UploadMediaType.VOICE;
    default: throw new ClawBotError("ILINK_INVALID_MEDIA", `Unsupported message item type: ${messageItemType}`, 400);
  }
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return token.substring(0, 8) + "***" + token.substring(token.length - 4);
}

// ========== HTTP POST 传输 ==========

export async function post(
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
    const r = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const duration = Date.now() - startTime;
    clearTimeout(timer);
    
    const text = await r.text();
    const status = r.status;
    
    if (!r.ok) {
      Logger.warn(`[iLink] POST ${endpoint} failed`, { status, response: text.slice(0, 500) });
      throw new ClawBotError('ILINK_HTTP_ERROR', `${endpoint} HTTP ${status}`, 502, { status, response: text });
    }
    
    try {
      const json = JSON.parse(text);
      
      const jsonKeys = Object.keys(json);
      if (jsonKeys.length === 0) return json;
      
      if (json.errcode !== undefined && json.errcode !== 0) {
        Logger.warn(`[iLink] ${endpoint} returned error`, { errcode: json.errcode, errmsg: json.errmsg });
        if (json.errcode === -14) {
          throw new ClawBotError('ILINK_SESSION_TIMEOUT', 'Session timeout', 401, { errcode: json.errcode, errmsg: json.errmsg });
        }
        throw new ClawBotError('ILINK_API_ERROR', `${endpoint} API error: ${json.errmsg || 'unknown'}`, 502, { errcode: json.errcode, errmsg: json.errmsg });
      }
      
      if (json.ret !== undefined && json.ret !== 0) {
        Logger.warn(`[iLink] ${endpoint} returned ret=${json.ret}`, { ret: json.ret });
        throw new ClawBotError('ILINK_API_ERROR', `${endpoint} ret=${json.ret}`, 502, { ret: json.ret });
      }
      
      return json;
    } catch (error) {
      if (error instanceof ClawBotError) throw error;
      Logger.error(`[iLink] Failed to parse response`, { endpoint, status, error: error.message, response: text.slice(0, 500) });
      throw new ClawBotError('ILINK_PARSE_ERROR', 'Failed to parse response', 502, { error: error.message, response: text.slice(0, 500), endpoint, status });
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if ((e as any)?.name === "AbortError") throw e;
    Logger.error(`[iLink] ${endpoint} error`, { error: (e as Error)?.message });
    throw new ClawBotError('ILINK_NETWORK_ERROR', `Network error: ${(e as Error)?.message}`, 503);
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
    const configResp = await post(creds, "ilink/bot/getconfig", {
      ilink_user_id: toUserId, context_token: contextToken,
    }, DEFAULT_API_MS);
    const typingTicket = configResp?.typing_ticket;
    if (!typingTicket) return;
    await post(creds, "ilink/bot/sendtyping", {
      ilink_user_id: toUserId, typing_ticket: typingTicket,
      status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
    }, DEFAULT_API_MS);
  } catch {}
}

// ========== 发送消息 ==========

export async function sendTextMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const msg: WeixinMessage = {
    from_user_id: creds.userId || "",
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
  
  const response = await withRetry(
    () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
    { retries: 2, baseDelayMs: 500, shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT') }
  );
  
  if (response && typeof response === 'object') {
    if (response.ret !== undefined && response.ret !== 0) {
      Logger.error(`[iLink] Message send returned error ret=${response.ret}`);
    }
    if (response.errcode !== undefined && response.errcode !== 0) {
      Logger.error(`[iLink] Message send returned errcode=${response.errcode}`);
    }
  }
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

  let sent = 0;
  for (const chunk of chunks) {
    try {
      await sendTextMessage(creds, toUserId, contextToken, chunk);
      sent++;
    } catch (e: any) {
      Logger.warn("[iLink] Chunk send failed, continuing", { error: e?.message, sent, total: chunks.length });
    }
  }
  Logger.info(`[iLink] Message chunked`, { total: text.length, chunks: chunks.length, sent });
  return sent;
}

// ========== 发送媒体消息 ==========

export async function sendMediaMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  item: MessageItem,
): Promise<void> {
  const messageId = generateClientId();
  const msg: WeixinMessage = {
    message_id: parseInt(messageId) || Date.now(),
    from_user_id: "",
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [item],
  };

  try {
    const resp = await withRetry(
      () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
      { retries: 2, baseDelayMs: 500, shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT') }
    );

    const hasError = resp && ('errcode' in resp && resp.errcode !== 0) || ('ret' in resp && resp.ret !== 0);
    if (hasError) {
      Logger.error("[iLink] sendmessage error", { errcode: resp?.errcode, ret: resp?.ret, errmsg: resp?.errmsg });
      throw new ClawBotError('ILINK_API_ERROR', `sendmessage error: errcode=${resp?.errcode}, ret=${resp?.ret}`, 502, { errcode: resp?.errcode, ret: resp?.ret });
    }
  } catch (e: any) {
    if (e instanceof ClawBotError) throw e;
    Logger.error("[iLink] sendmessage failed", { error: e?.message });
    throw e;
  }
}

// ========== 简单图片发送（SDK 方式）==========

export async function sendImageSimple(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  imageUrl: string,
): Promise<void> {
  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgResp.ok) throw new ClawBotError("ILINK_DOWNLOAD_FAILED", `Download failed: ${imgResp.status}`);
  const fileBytes = new Uint8Array(await imgResp.arrayBuffer());
  await uploadAndSendMedia(creds, toUserId, contextToken, MessageItemType.IMAGE, "generated.png", fileBytes, "image/png");
}

// ========== CDN 图片下载（用于以图生图）==========

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function downloadImageFromCdn(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Uint8Array | null> {
  const CDN_DOWNLOAD_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
  try {
    const downloadUrl = `${CDN_DOWNLOAD_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      Logger.warn("[iLink] downloadImageFromCdn failed", { status: resp.status });
      return null;
    }
    const encryptedBytes = new Uint8Array(await resp.arrayBuffer());
    const keyBytes = base64ToBytes(aesKeyBase64);
    const iv = new Uint8Array(16);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, encryptedBytes.buffer);
    return new Uint8Array(decrypted);
  } catch (e: any) {
    Logger.warn("[iLink] downloadImageFromCdn error", { error: e?.message });
    return null;
  }
}

// ========== 高级媒体发送：先上传到 CDN，再发送 CDNMedia 引用消息 ==========

export async function uploadAndSendMedia(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  messageItemType: number,
  fileName: string,
  fileData: ArrayBuffer | Uint8Array,
  contentType?: string,
): Promise<void> {
  const fileBytes = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
  const mediaType = toUploadMediaType(messageItemType);

  const rawMd5 = md5Hex(fileBytes);
  const videoDuration = messageItemType === MessageItemType.VIDEO ? extractMp4Duration(fileBytes) : undefined;

  try {
    const uploaded = await uploadMediaToCdn(creds, toUserId, fileBytes, mediaType);
    const item = buildMediaItem(messageItemType, uploaded, fileName, uploaded.fileSizeCiphertext, rawMd5, videoDuration);
    await sendMediaMessage(creds, toUserId, contextToken, item);
  } catch (e: any) {
    Logger.error("[iLink] uploadAndSendMedia failed", { error: e?.message?.slice(0, 200), mediaType });
    throw e;
  }
}

function buildMediaItem(
  messageItemType: number,
  uploaded: {
    downloadEncryptedQueryParam: string;
    aeskeyBase64: string;
    fileSize: number;
    fileSizeCiphertext: number;
    thumbSize?: number;
    thumbWidth?: number;
    thumbHeight?: number;
  },
  fileName: string,
  fileSize: number,
  fileMd5?: string,
  duration?: number,
): MessageItem {
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: uploaded.aeskeyBase64,
    encrypt_type: 1,
  };

  const thumbSize = uploaded.thumbSize || 0;
  const thumbWidth = uploaded.thumbWidth || 0;
  const thumbHeight = uploaded.thumbHeight || 0;

  if (messageItemType === MessageItemType.IMAGE) {
    return {
      type: MessageItemType.IMAGE,
      image_item: { media, mid_size: fileSize, thumb_size: thumbSize, thumb_height: thumbHeight, thumb_width: thumbWidth },
    };
  }
  if (messageItemType === MessageItemType.VIDEO) {
    const playLength = (duration && duration > 0) ? duration * 1000 : 0;
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media, video_size: fileSize, play_length: playLength, duration: playLength, video_md5: fileMd5 || "",
        thumb_size: thumbSize, thumb_height: thumbHeight, thumb_width: thumbWidth,
      },
    };
  }
  if (messageItemType === MessageItemType.FILE) {
    return {
      type: MessageItemType.FILE,
      file_item: { media, file_name: fileName, file_size: fileSize },
    };
  }
  throw new ClawBotError("ILINK_INVALID_MEDIA", `Unsupported message item type: ${messageItemType}`, 400);
}

// ========== 发送图片消息（先下载，再上传到 iLink CDN 发送）==========

export async function sendImageMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  imageUrl: string,
  _apiKey?: string,
): Promise<void> {
  const needsAuth = _apiKey && !imageUrl.includes("platform-outputs.agnes-ai.space");
  const headers: Record<string, string> = {};
  if (needsAuth) headers["Authorization"] = `Bearer ${_apiKey}`;
  const imgResp = await fetch(imageUrl, { headers, signal: AbortSignal.timeout(60000) });
  if (!imgResp.ok) {
    throw new ClawBotError("ILINK_IMAGE_DOWNLOAD_FAILED", `Image download HTTP ${imgResp.status}`, 502);
  }
  const buffer = new Uint8Array(await imgResp.arrayBuffer());
  const contentType = imgResp.headers.get("content-type") || "image/png";
  await uploadAndSendMedia(creds, toUserId, contextToken, MessageItemType.IMAGE, "generated.png", buffer, contentType);
  Logger.info("[iLink] Image sent via CDN upload");
}

// ========== 发送视频消息（先下载，再上传到 iLink CDN 发送）==========

export async function sendVideoMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  videoUrl: string,
  _apiKey?: string,
): Promise<void> {
  await sendFileFromUrl(creds, toUserId, contextToken, videoUrl, MessageItemType.VIDEO, "generated_video.mp4", _apiKey);
  Logger.info("[iLink] Video message sent (download + CDN upload)");
}

export async function sendFileFromUrl(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  fileUrl: string,
  fileType: number,
  fileName: string,
  _apiKey?: string,
): Promise<void> {
  const maxRetries = 6;
  let resp: Response | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {};
      resp = await fetch(fileUrl, { headers, signal: AbortSignal.timeout(60000) });
      if (resp.ok) break;
      const errBody = await resp.text().catch(() => "");
      lastError = `HTTP ${resp.status}`;
      Logger.warn("[iLink] Download attempt failed, retrying", {
        attempt: attempt + 1, status: resp.status, url: fileUrl.substring(0, 120), body: errBody.slice(0, 300),
      });
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
    } catch (e: any) {
      lastError = e?.message || String(e);
      Logger.warn("[iLink] Download attempt failed with exception, retrying", {
        attempt: attempt + 1, error: lastError, url: fileUrl.substring(0, 120),
      });
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 2000 + attempt * 2000));
    }
  }

  if (!resp || !resp.ok) {
    throw new ClawBotError("ILINK_DOWNLOAD_FAILED", `Download failed after ${maxRetries} retries: ${lastError}`);
  }

  const buffer = new Uint8Array(await resp.arrayBuffer());
  await uploadAndSendMedia(creds, toUserId, contextToken, fileType, fileName, buffer);
}