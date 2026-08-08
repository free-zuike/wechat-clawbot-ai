// iLink 协议实现 - 基于 weixin-ilink SDK 逆向（源自 @tencent-weixin/openclaw-weixin）

import { Logger, withRetry, ClawBotError } from "../utils/error";
import { md5Hex } from "../utils/md5";
import { uploadMediaToCdn, UploadMediaType } from "./cdn-upload";
import type { WeixinMessage, MessageItem, GetUpdatesResp, ILinkCredentials } from "../types";

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

// ========== 重新导出 CDN 上传相关的公开 API ==========
export { uploadMediaToCdn, UploadMediaType } from "./cdn-upload";
export { getSimpleUploadUrl, uploadFileSimple } from "./cdn-upload";

// ========== 常量 ==========
const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_CHANNEL_VERSION = "2.0.0";
const DEFAULT_LONG_POLL_MS = 35000;
const DEFAULT_API_MS = 15000;

// base_info 和 SKRouteTag（参考 @weixin-claw/core）
function buildBaseInfo(): { channel_version: string } {
  return { channel_version: DEFAULT_CHANNEL_VERSION };
}

// SKRouteTag 从环境变量或 KV 读取（可选）
let cachedRouteTag: string | null = null;
function getRouteTag(): string | null {
  if (cachedRouteTag !== null) return cachedRouteTag;
  try {
    // 尝试从全局变量读取（Cloudflare Workers 环境）
    if (typeof globalThis !== "undefined" && (globalThis as any).__SK_ROUTE_TAG) {
      cachedRouteTag = (globalThis as any).__SK_ROUTE_TAG;
      return cachedRouteTag;
    }
  } catch {}
  return null;
}

// MessageItemType → UploadMediaType 映射
// MessageItemType: IMAGE=2, VOICE=3, FILE=4, VIDEO=5
// UploadMediaType:  IMAGE=1, VOICE=4, FILE=3, VIDEO=2
function toUploadMediaType(messageItemType: number): number {
  switch (messageItemType) {
    case MessageItemType.IMAGE: return UploadMediaType.IMAGE;
    case MessageItemType.VIDEO: return UploadMediaType.VIDEO;
    case MessageItemType.FILE: return UploadMediaType.FILE;
    case MessageItemType.VOICE: return UploadMediaType.VOICE;
    default: throw new ClawBotError("ILINK_INVALID_MEDIA", `Unsupported message item type: ${messageItemType}`, 400);
  }
}

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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  // SKRouteTag（参考 @weixin-claw/core）
  const routeTag = getRouteTag();
  if (routeTag) {
    headers["SKRouteTag"] = routeTag;
  }
  return headers;
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
    const r = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
    const duration = Date.now() - startTime;
    clearTimeout(timer);
    
    const text = await r.text();
    const status = r.status;
    
    if (!r.ok) {
      Logger.warn(`[iLink] POST ${endpoint} failed`, { 
        status, 
        response: text.slice(0, 500),
      });
      throw new ClawBotError('ILINK_HTTP_ERROR', `${endpoint} HTTP ${status}`, 502, { status, response: text });
    }
    
    try {
      const json = JSON.parse(text);
      
      const jsonKeys = Object.keys(json);
      if (jsonKeys.length === 0) {
        return json;
      }
      
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
      if (error instanceof ClawBotError) {
        throw error;
      }
      Logger.error(`[iLink] Failed to parse response`, { 
        endpoint,
        status,
        error: error.message, 
        response: text.slice(0, 500),
      });
      throw new ClawBotError('ILINK_PARSE_ERROR', 'Failed to parse response', 502, { 
        error: error.message, 
        response: text.slice(0, 500),
        endpoint,
        status,
      });
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if ((e as any)?.name === "AbortError") {
      throw e;
    }
    Logger.error(`[iLink] ${endpoint} error`, { error: (e as Error)?.message });
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
    throw new ClawBotError('ILINK_QRCODE_ERROR', `获取二维码失败: ${r.status}`, 502);
  }
  
  const data = await r.json() as any;
  if (!data.qrcode || !data.qrcode_img_content) {
    throw new ClawBotError('ILINK_QRCODE_ERROR', '返回数据无效', 502);
  }
  
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
    const r = await fetch(url, { headers: { "iLink-App-ClientVersion": "1" }, signal: ctrl.signal });
    clearTimeout(timer);
    
    if (!r.ok) {
      return { status: "wait" };
    }
    
    const data = await r.json() as any;
    const s = data?.status;
    
    const result = {
      status: s || "wait",
      bot_token: data.bot_token,
      ilink_bot_id: data.ilink_bot_id,
      baseurl: data.baseurl,
      ilink_user_id: data.ilink_user_id,
      raw: data,
    };
    
    return result;
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
    const resp = await withRetry(
      () => post(creds, "ilink/bot/getupdates", { get_updates_buf: buf }, DEFAULT_LONG_POLL_MS),
      {
        retries: 2,
        baseDelayMs: 1000,
        shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
      }
    );
    
    const result = resp as GetUpdatesResp;
    return result;
  } catch (e: any) {
    if (e?.name === "AbortError") {
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
    {
      retries: 2,
      baseDelayMs: 500,
      shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
    }
  );
  
  const responseStr = JSON.stringify(response);
  
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

  for (const chunk of chunks) {
    await sendTextMessage(creds, toUserId, contextToken, chunk);
  }

  Logger.info(`[iLink] Message chunked`, { total: text.length, chunks: chunks.length });
  return chunks.length;
}

// ========== 媒体上传（已迁移到 cdn-upload.ts）==========
// 上传流程：getuploadurl → AES-128-ECB 加密 → POST 加密文件到 CDN
// 旧实现（直接 PUT 明文 + file_type）已废弃，参见 ./cdn-upload.ts

export async function sendMediaMessage(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  item: MessageItem,
): Promise<void> {
  // 生成唯一消息ID
  const messageId = generateClientId();
  
  // 根据 weixin-ilink 官方 SDK，from_user_id 应该是空字符串
  // 参考: https://www.npmjs.com/package/weixin-ilink
  const msg: WeixinMessage = {
    message_id: parseInt(messageId) || Date.now(),
    from_user_id: "", // 空字符串，根据 iLink 协议规范
    to_user_id: toUserId,
    client_id: generateClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [item],
  };

  // 检查 media 对象结构

  try {
    const resp = await withRetry(
      () => post(creds, "ilink/bot/sendmessage", { msg }, DEFAULT_API_MS),
      {
        retries: 2,
        baseDelayMs: 500,
        shouldRetry: (error) => !(error instanceof ClawBotError && error.code === 'ILINK_SESSION_TIMEOUT')
      }
    );

    // 空对象响应在 post 函数中已被视为成功（iLink API 的静默成功模式）
    const respKeys = Object.keys(resp || {});
    // ret=-1 是错误响应，需要抛出异常
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
/**
 * 使用 uploadAndSendMedia 发送远程图片：下载 → 上传 CDN → 发送消息
 */
export async function sendImageSimple(
  creds: ILinkCredentials,
  toUserId: string,
  contextToken: string,
  imageUrl: string,
): Promise<void> {
  // 1. 下载图片
  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgResp.ok) throw new ClawBotError("ILINK_DOWNLOAD_FAILED", `Download failed: ${imgResp.status}`);
  const fileBytes = new Uint8Array(await imgResp.arrayBuffer());
  
  // 2. 使用统一的 uploadAndSendMedia 上传并发送
  await uploadAndSendMedia(creds, toUserId, contextToken, MessageItemType.IMAGE, "generated.png", fileBytes, "image/png");
}

// ========== CDN 图片下载（用于以图生图）==========
/**
 * 从 iLink CDN 下载图片（使用 encrypt_query_param 和 aes_key）
 * @returns 图片的 Uint8Array 数据，失败返回 null
 */
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ========== 高级媒体发送：先上传到 CDN，再发送 CDNMedia 引用消息 ==========
/**
 * 上传媒体到 iLink CDN 并发送消息
 * @param creds iLink 登录凭证
 * @param toUserId 目标用户 ID
 * @param contextToken 会话上下文 token
 * @param messageItemType MessageItemType 常量（IMAGE/VIDEO/FILE/VOICE）
 * @param fileName 文件名（FILE 类型时使用）
 * @param fileData 文件明文二进制
 * @param contentType 仅用于日志
 */
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

  // 计算 MD5 和提取视频时长
  const rawMd5 = md5Hex(fileBytes);
  const videoDuration = messageItemType === MessageItemType.VIDEO ? extractMp4Duration(fileBytes) : undefined;

  try {
    // 1. 上传到 iLink CDN（getuploadurl + AES 加密 + POST）
    const uploaded = await uploadMediaToCdn(creds, toUserId, fileBytes, mediaType);

    // 2. 构造 CDNMedia 引用消息体
    const item = buildMediaItem(messageItemType, uploaded, fileName, uploaded.fileSizeCiphertext, rawMd5, videoDuration);

    // 3. 发送消息
    await sendMediaMessage(creds, toUserId, contextToken, item);
  } catch (e: any) {
    Logger.error("[iLink] uploadAndSendMedia failed", { error: e?.message?.slice(0, 200), mediaType });
    throw e;
  }
}

/**
 * 构造媒体消息项（CDNMedia 格式）
 * 关键协议要点：
 *   - encrypt_type=0: 仅加密 fileid（无缩略图，最可靠）
 *   - encrypt_type=1: 打包缩略图/中图（需要单独上传缩略图，否则微信会显示"已过期或已被清理"）
 *   - mid_size: 文件大小（明文，不是加密大小）
 *   - thumb_size/width/height: 即使 0 值也需存在，否则微信解析失败
 *   - cdn_url: CDN 下载地址（微信客户端需要这个字段才能正确显示媒体）
 */
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
  // encrypt_type=1: 与 @weixin-claw/core SDK 一致
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
      image_item: {
        media,
        mid_size: fileSize,
        thumb_size: thumbSize,
        thumb_height: thumbHeight,
        thumb_width: thumbWidth,
      },
    };
  }
  if (messageItemType === MessageItemType.VIDEO) {
    const playLength = (duration && duration > 0) ? duration * 1000 : 0;
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media,
        video_size: fileSize,
        play_length: playLength,
        duration: playLength,
        video_md5: fileMd5 || "",
        thumb_size: thumbSize,
        thumb_height: thumbHeight,
        thumb_width: thumbWidth,
      },
    };
  }
  if (messageItemType === MessageItemType.FILE) {
    return {
      type: MessageItemType.FILE,
      file_item: {
        media,
        file_name: fileName,
        file_size: fileSize,
      },
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
  // iLink CDN 不接受外部 URL，必须先下载再上传
  // Agnes AI 等平台返回的 CDN URL 已是预认证 URL，无需再带 Authorization 头
  // 否则 Agnes CDN 会返回 401（它不接受额外的 Bearer 鉴权）
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
  // iLink CDN 不接受外部 URL，必须先下载再上传
  // 失败时不降级，让上层（checkPendingVideos / 消息处理）决定跨 cron 重试
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
  // 下载文件（带 API Key 认证，部分提供商的媒体 URL 需要鉴权）
  // 媒体刚生成时 CDN 可能短暂不可用（502），重试几次
  const maxRetries = 6;
  let resp: Response | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 注：Agnes 返回的视频 URL 是 Google Cloud Storage，通常公开可访问
      // 如有需要可启用 Authorization 头
      const headers: Record<string, string> = {};
      resp = await fetch(fileUrl, { headers, signal: AbortSignal.timeout(60000) });
      if (resp.ok) break;
      const errBody = await resp.text().catch(() => "");
      lastError = `HTTP ${resp.status}`;
      Logger.warn("[iLink] Download attempt failed, retrying", {
        attempt: attempt + 1,
        status: resp.status,
        url: fileUrl.substring(0, 120),
        body: errBody.slice(0, 300),
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
    throw new ClawBotError("ILINK_DOWNLOAD_FAILED", `Download failed after ${maxRetries} retries: ${lastError}`);
  }

  const buffer = new Uint8Array(await resp.arrayBuffer());
  await uploadAndSendMedia(creds, toUserId, contextToken, fileType, fileName, buffer);
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

/**
 * 从 MP4 二进制数据中提取视频时长（秒）
 * MP4 结构：moov -> mvhd -> duration / timescale
 */
function extractMp4Duration(data: Uint8Array): number | null {
  try {
    let offset = 0;
    while (offset < data.length - 8) {
      const size = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);

      if (size === 0 || size < 8) break;
      if (offset + size > data.length) break;

      if (type === "moov") {
        // 递归解析 moov 盒子找 mvhd
        const moovData = data.slice(offset + 8, offset + size);
        return parseMoovForDuration(moovData);
      }

      offset += size;
    }
  } catch (_) {}
  return null;
}

function parseMoovForDuration(moovData: Uint8Array): number | null {
  let offset = 0;
  while (offset < moovData.length - 8) {
    const size = (moovData[offset] << 24) | (moovData[offset + 1] << 16) | (moovData[offset + 2] << 8) | moovData[offset + 3];
    const type = String.fromCharCode(moovData[offset + 4], moovData[offset + 5], moovData[offset + 6], moovData[offset + 7]);

    if (size === 0 || size < 8) break;
    if (offset + size > moovData.length) break;

    if (type === "mvhd") {
      // mvhd 结构: version(1) + flags(3) + creation_time(4) + modification_time(4) + timescale(4) + duration(4) + ...
      if (moovData.length >= offset + 4 + 4 + 4 + 4 + 4) {
        const timescale = (moovData[offset + 16] << 24) | (moovData[offset + 17] << 16) | (moovData[offset + 18] << 8) | moovData[offset + 19];
        const duration = (moovData[offset + 20] << 24) | (moovData[offset + 21] << 16) | (moovData[offset + 22] << 8) | moovData[offset + 23];
        if (timescale > 0) {
          return Math.round(duration / timescale);
        }
      }
    }

    offset += size;
  }
  return null;
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return token.substring(0, 8) + "***" + token.substring(token.length - 4);
}

// 常见表情符号 → 文字描述（帮 AI 理解入站消息里的 emoji）
const EMOJI_MAP: Record<string, string> = {
  "😀": "开心", "😁": "大笑", "😂": "笑哭", "🤣": "笑到哭", "😊": "微笑",
  "😍": "爱慕", "😘": "飞吻", "😜": "调皮", "🤔": "思考", "😎": "酷",
  "🥳": "庆祝", "😢": "哭泣", "😭": "大哭", "😡": "生气", "😱": "震惊",
  "😴": "困", "👍": "赞", "👎": "踩", "👏": "鼓掌", "🙏": "感谢",
  "💪": "加油", "🤝": "握手", "❤️": "心", "💔": "心碎", "🔥": "火/热门",
  "✨": "闪耀", "🎉": "庆祝", "🎂": "生日", "🎁": "礼物", "💡": "主意",
  "❗": "注意", "❓": "疑问", "✅": "完成", "❌": "错误", "⚠️": "警告",
  "🔍": "搜索", "📤": "发送", "📥": "接收", "📎": "附件", "📌": "标记",
  "☕": "咖啡", "🍵": "茶", "🌹": "玫瑰", "🌸": "花", "🌞": "太阳/好",
  "👋": "挥手", "🤗": "拥抱", "😤": "憋气", "😓": "汗", "🙄": "翻白眼",
};

export function translateEmoji(text: string): string {
  if (!text) return text;
  let result = text;
  for (const [emoji, desc] of Object.entries(EMOJI_MAP)) {
    if (result.includes(emoji)) {
      result = result.split(emoji).join(`[${desc}]`);
    }
  }
  return result;
}

export function extractMessageText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  
  const parts: string[] = [];
  
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      if (ref?.title) {
        parts.push(`[引用: ${ref.title}]\n${translateEmoji(item.text_item.text)}`);
      } else {
        parts.push(translateEmoji(item.text_item.text));
      }
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      const playtime = item.voice_item.playtime ? `（${item.voice_item.playtime}秒）` : "";
      parts.push(`🎤 [语音转文字${playtime}]: ${translateEmoji(item.voice_item.text)}`);
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
