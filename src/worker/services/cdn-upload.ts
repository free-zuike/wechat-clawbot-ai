// iLink CDN 上传模块 - 实现 @tencent-weixin/openclaw-weixin 的 CDN 协议
// 关键流程：
//   1. 计算文件 rawsize / rawfilemd5 / filesize（AES-128-ECB 密文大小）
//   2. 生成 filekey + aeskey
//   3. 调用 getuploadurl 获取 upload_param
//   4. POST 加密文件到 CDN（响应头 x-encrypted-param 即为下载参数）
//   5. 返回 CDNMedia 引用信息，供 sendMessage 构造消息体

import { Logger, ClawBotError } from "../utils/error";
import { md5Hex } from "../utils/md5";
import type { ILinkCredentials } from "../types";

// iLink 媒体类型（与 MessageItemType 不同！）
//   IMAGE = 1, VIDEO = 2, FILE = 3
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_API_MS = 15000;
const DEFAULT_UPLOAD_MS = 30000;
const CHANNEL_VERSION = "weixin-ilink/0.1.0";

// ========== 工具 ==========

function randomWechatUin(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const u32 = (arr[0]! << 24 | arr[1]! << 16 | arr[2]! << 8 | arr[3]!) >>> 0;
  // base64(String(u32))
  const bin = String(u32);
  let binary = "";
  for (let i = 0; i < bin.length; i++) binary += String.fromCharCode(bin.charCodeAt(i));
  return btoa(binary);
}

function buildHeaders(token: string, bodyBytes: number): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Content-Length": String(bodyBytes),
    "Authorization": `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

/** AES-128-ECB 加密后填充到 16 字节倍数（PKCS#7） */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * AES-128-ECB + PKCS#7 加密（Cloudflare Workers SubtleCrypto 兼容）
 * ECB 模式不会自动填充，需要手动添加 PKCS#7 padding
 */
export async function encryptAesEcb(plaintext: Uint8Array, keyHex: string): Promise<Uint8Array> {
  // 解析 hex key
  if (keyHex.length !== 32) {
    throw new Error(`AES-128 key must be 32 hex chars (16 bytes), got ${keyHex.length}`);
  }
  const keyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    keyBytes[i] = parseInt(keyHex.substr(i * 2, 2), 16);
  }

  // 手动添加 PKCS#7 padding
  const padLen = 16 - (plaintext.length % 16);
  const padded = new Uint8Array(plaintext.length + padLen);
  padded.set(plaintext);
  for (let i = plaintext.length; i < padded.length; i++) padded[i] = padLen;

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "AES-ECB" }, false, ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-ECB" }, cryptoKey, padded
  );
  return new Uint8Array(encrypted);
}

/** 生成 16 字节随机 AES key，返回 hex 字符串 */
export function generateAesKeyHex(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 生成 16 字节随机 filekey，返回 hex 字符串 */
export function generateFilekeyHex(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** hex 字符串转 base64 字符串（用于消息体 aes_key 字段） */
export function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

// ========== iLink getuploadurl API ==========

interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
}

async function postJson(
  baseUrl: string,
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const url = base + endpoint;
  const bodyWithBaseInfo = { ...body, base_info: { channel_version: CHANNEL_VERSION } };
  const jsonStr = JSON.stringify(bodyWithBaseInfo);
  const headers = buildHeaders(token, new TextEncoder().encode(jsonStr).length);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, { method: "POST", headers, body: jsonStr, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await r.text();
    if (!r.ok) {
      Logger.warn(`[iLink] POST ${endpoint} failed`, { status: r.status, response: text.slice(0, 300) });
      throw new ClawBotError("ILINK_HTTP_ERROR", `${endpoint} HTTP ${r.status}`, 502, { status: r.status, response: text });
    }
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new ClawBotError("ILINK_PARSE_ERROR", "Failed to parse response", 502, { error: e?.message });
    }
  } catch (e: any) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if (e?.name === "AbortError") {
      throw new ClawBotError("ILINK_TIMEOUT", `${endpoint} timeout`, 504);
    }
    throw new ClawBotError("ILINK_NETWORK_ERROR", `Network error: ${e?.message}`, 503);
  }
}

/**
 * 调用 iLink getuploadurl 接口
 * @param creds iLink 登录凭证
 * @param req 必要参数
 */
export async function getUploadUrl(
  creds: ILinkCredentials,
  req: GetUploadUrlReq,
): Promise<{ upload_param: string; thumb_upload_param?: string }> {
  const resp = await postJson(
    creds.baseUrl, "ilink/bot/getuploadurl", creds.botToken, req as unknown as Record<string, unknown>, DEFAULT_API_MS
  ) as GetUploadUrlResp;

  if (resp.errcode !== undefined && resp.errcode !== 0) {
    Logger.error("[iLink] getuploadurl returned error", { errcode: resp.errcode, errmsg: resp.errmsg, resp: JSON.stringify(resp).slice(0, 500) });
    throw new ClawBotError("ILINK_API_ERROR", `getuploadurl error ${resp.errcode}: ${resp.errmsg}`, 502, { errcode: resp.errcode, errmsg: resp.errmsg });
  }

  if (!resp.upload_param) {
    Logger.error("[iLink] getuploadurl returned no upload_param", { resp: JSON.stringify(resp).slice(0, 500) });
    throw new ClawBotError("ILINK_UPLOAD_PARAM_MISSING", "getuploadurl did not return upload_param", 502, { resp });
  }

  Logger.info("[iLink] getuploadurl success", {
    filekey: req.filekey,
    media_type: req.media_type,
    upload_param_len: resp.upload_param.length,
    has_thumb: !!resp.thumb_upload_param,
  });
  return { upload_param: resp.upload_param, thumb_upload_param: resp.thumb_upload_param };
}

// ========== CDN 上传（POST 加密文件）==========

/**
 * 上传加密文件到 Weixin CDN
 * 响应头 x-encrypted-param 即为下载参数（downloadEncryptedQueryParam）
 */
export async function uploadEncryptedToCdn(
  uploadParam: string,
  filekey: string,
  ciphertext: Uint8Array,
  timeoutMs: number = DEFAULT_UPLOAD_MS,
): Promise<string> {
  const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (resp.status >= 400 && resp.status < 500) {
      const errMsg = resp.headers.get("x-error-message") || (await resp.text().catch(() => ""));
      Logger.error("[iLink] CDN upload client error", { status: resp.status, errMsg });
      throw new ClawBotError("ILINK_CDN_CLIENT_ERROR", `CDN ${resp.status}: ${errMsg}`, 502, { status: resp.status, errMsg });
    }
    if (resp.status !== 200) {
      const errMsg = resp.headers.get("x-error-message") || `status ${resp.status}`;
      Logger.error("[iLink] CDN upload server error", { status: resp.status, errMsg });
      throw new ClawBotError("ILINK_CDN_SERVER_ERROR", `CDN ${resp.status}: ${errMsg}`, 502);
    }

    const downloadParam = resp.headers.get("x-encrypted-param");
    if (!downloadParam) {
      Logger.error("[iLink] CDN response missing x-encrypted-param header");
      throw new ClawBotError("ILINK_CDN_MISSING_PARAM", "CDN response missing x-encrypted-param header", 502);
    }

    Logger.info("[iLink] CDN upload success", { filekey, downloadParamLen: downloadParam.length });
    return downloadParam;
  } catch (e: any) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if (e?.name === "AbortError") {
      throw new ClawBotError("ILINK_CDN_TIMEOUT", "CDN upload timeout", 504);
    }
    throw new ClawBotError("ILINK_CDN_ERROR", `CDN upload error: ${e?.message}`, 502);
  }
}

// ========== 一站式上传 ==========

export interface UploadedMediaInfo {
  filekey: string;
  /** CDN 下载参数（放入 image_item.media.encrypt_query_param） */
  downloadEncryptedQueryParam: string;
  /** AES-128 key，hex 字符串 */
  aeskeyHex: string;
  /** AES-128 key，base64 字符串（用于消息体 aes_key 字段） */
  aeskeyBase64: string;
  /** 明文大小 */
  fileSize: number;
  /** 密文大小（AES-128-ECB + PKCS#7 填充） */
  fileSizeCiphertext: number;
}

/**
 * 完整的上传流程：getuploadurl → AES 加密 → CDN POST → 返回 CDNMedia 引用信息
 * @param creds iLink 登录凭证
 * @param toUserId 目标用户 ID（iLink 需要这个来关联 CDN 上传到会话）
 * @param fileData 文件明文
 * @param mediaType 1=IMAGE, 2=VIDEO, 3=FILE
 */
export async function uploadMediaToCdn(
  creds: ILinkCredentials,
  toUserId: string,
  fileData: Uint8Array,
  mediaType: number,
): Promise<UploadedMediaInfo> {
  // 1. 计算参数
  const rawsize = fileData.length;
  const rawfilemd5 = md5Hex(fileData);
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = generateFilekeyHex();
  const aeskeyHex = generateAesKeyHex();

  Logger.info("[iLink] Uploading media to CDN", {
    filekey, mediaType, toUserId, rawsize, filesize, rawfilemd5,
  });

  // 2. 调用 getuploadurl
  const { upload_param } = await getUploadUrl(creds, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
  });

  // 3. AES-128-ECB 加密文件
  const ciphertext = await encryptAesEcb(fileData, aeskeyHex);

  // 4. 上传到 CDN
  const downloadEncryptedQueryParam = await uploadEncryptedToCdn(upload_param, filekey, ciphertext);

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskeyHex,
    aeskeyBase64: hexToBase64(aeskeyHex),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
