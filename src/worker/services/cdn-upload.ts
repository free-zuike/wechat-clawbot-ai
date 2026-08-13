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
const DEFAULT_UPLOAD_MS = 60000; // 增加到 60 秒，大文件需要更长时间
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
 * AES-128-ECB + PKCS#7 padding 加密（Cloudflare Workers SubtleCrypto 兼容）
 * 注意：Web Crypto API 中的 AES-ECB 不是所有运行时都支持。Cloudflare Workers 支持。
 * 如果 AES-ECB 不可用，会降级到用 AES-CBC + 每块独立 IV=0（等效 ECB）
 */
export async function encryptAesEcb(
  plaintext: Uint8Array,
  keyHex: string,
): Promise<Uint8Array> {
  if (keyHex.length !== 32) {
    throw new Error(`AES-128 key must be 32 hex chars (16 bytes), got ${keyHex.length}`);
  }
  const keyBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    keyBytes[i] = parseInt(keyHex.substr(i * 2, 2), 16);
  }

  // PKCS#7 padding
  const padLen = 16 - (plaintext.length % 16);
  const padded = new Uint8Array(plaintext.length + padLen);
  padded.set(plaintext);
  for (let i = plaintext.length; i < padded.length; i++) padded[i] = padLen;

  // 方案 1：尝试原生 AES-ECB
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "AES-ECB" } as any, false, ["encrypt"]
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-ECB" } as any, cryptoKey, padded
    );
    return new Uint8Array(encrypted);
  } catch (errA: any) {
    // 方案 2：逐块使用 AES-CBC + 零 IV（ECB 等价）
    Logger.info("[iLink] AES-ECB not supported, falling back to per-block AES-CBC", { error: errA?.message });
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]
    );
    const zeroIv = new Uint8Array(16);
    const totalBlocks = padded.length / 16;
    const out = new Uint8Array(padded.length);
    for (let block = 0; block < totalBlocks; block++) {
      const singleBlock = padded.slice(block * 16, (block + 1) * 16);
      const encBlock = await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: zeroIv }, cryptoKey, singleBlock
      );
      const encBytes = new Uint8Array(encBlock);
      out.set(encBytes.subarray(0, 16), block * 16);
    }
    return out;
  }
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
// 注意：官方 SDK 字段是 media_type（1=IMAGE, 2=VIDEO, 3=FILE）
// 关键区别：旧的非法 API 用的是 file_type/file_name/file_size
// 当前实现按官方逆向协议实现

interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
}

interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  // 兼容字段：服务器可能返回字段不统一
  [key: string]: any;
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
    Logger.info(`[iLink] POST ${endpoint} — HTTP ${r.status} bytes=${text.length} body=${text.slice(0, 600)}`);
    if (!r.ok) {
      Logger.error(`[iLink] POST ${endpoint} HTTP ${r.status} FAIL — ${text.slice(0, 500)}`);
      throw new ClawBotError("ILINK_HTTP_ERROR", `${endpoint} HTTP ${r.status}: ${text.slice(0, 200)}`, 502, { status: r.status, response: text });
    }
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new ClawBotError("ILINK_PARSE_ERROR", `Failed to parse JSON: ${e?.message}, raw: ${text.slice(0, 300)}`, 502, { error: e?.message });
    }
  } catch (e: any) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if (e?.name === "AbortError") {
      throw new ClawBotError("ILINK_TIMEOUT", `${endpoint} timeout`, 504);
    }
    throw new ClawBotError("ILINK_NETWORK_ERROR", `Network error: ${e?.message}`, 503, { error: e?.message });
  }
}

/**
 * 从 getuploadurl 响应中提取 upload_param（兼容多种响应格式）
 * 可能的响应结构：
 *   { upload_param: "..." }                       // 官方 SDK 期望
 *   { ret: 0, upload_param: "..." }                // 带返回码
 *   { data: { upload_param: "..." } }              // 嵌套 data
 *   { result: { upload_param: "..." } }            // 嵌套 result
 *   { resp: { upload_param: "..." } }              // 嵌套 resp
 *   { uploadUrl: "..." }                           // 字段名变体
 *   { upload_url: "..." }                          // 字段名变体
 */
function extractUploadParam(obj: any): { upload_param?: string; thumb_upload_param?: string; allKeys: string[] } {
  const keys: string[] = [];
  try {
    if (typeof obj === "object" && obj !== null) {
      keys.push(...Object.keys(obj));
    }
  } catch (_) {}

  const candidates: string[] = [
    "upload_param",
    "uploadUrl",
    "upload_url",
    "cdn_upload_param",
    "cdnUrl",
    "cdn_url",
    "upload_param_string",
  ];

  // Search top-level
  for (const k of candidates) {
    if (obj && typeof obj[k] === "string" && (obj[k] as string).length > 0) {
      return { upload_param: obj[k], thumb_upload_param: obj.thumb_upload_param, allKeys: keys };
    }
  }

  // Search nested objects
  const nestedKeys = ["data", "result", "resp", "response", "payload", "body"];
  for (const nk of nestedKeys) {
    if (obj && typeof obj[nk] === "object" && obj[nk] !== null) {
      for (const k of candidates) {
        if (typeof obj[nk][k] === "string" && (obj[nk][k] as string).length > 0) {
          return { upload_param: obj[nk][k], thumb_upload_param: obj[nk].thumb_upload_param, allKeys: keys };
        }
      }
    }
  }

  // Search any string value that looks like a CDN URL or base64 param
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) {
      const val = (obj as any)[key];
      if (typeof val === "string" && val.length > 20) {
        if (val.startsWith("http://") || val.startsWith("https://") ||
            val.includes("cdn") || val.includes("upload") ||
            (val.match(/^[A-Za-z0-9+/=]+$/) && val.length > 32)) {
          return { upload_param: val, allKeys: keys };
        }
      }
    }
  }

  return { upload_param: undefined, allKeys: keys };
}

/**
 * 调用 iLink getuploadurl 接口（真实协议：返回 upload_full_url）
 * @param creds iLink 登录凭证
 * @param req 必要参数
 * @returns { uploadFullUrl: 完整的 CDN 上传 URL (含 encrypted_query_param) }
 */
export async function getUploadUrl(
  creds: ILinkCredentials,
  req: GetUploadUrlReq,
): Promise<{ uploadFullUrl: string; thumbUploadParam?: string; thumbSize?: number; thumbWidth?: number; thumbHeight?: number }> {
  // 使用传入的 no_need_thumb 参数，不再强制覆盖
  const reqWithThumb = { ...req };

  Logger.info("[iLink] [Step 2/4] Calling getuploadurl API (raw request)", {
    filekey: reqWithThumb.filekey.substring(0, 16),
    media_type: reqWithThumb.media_type,
    rawsize: reqWithThumb.rawsize,
    filesize: reqWithThumb.filesize,
    to_user_id: reqWithThumb.to_user_id.slice(0, 24),
    aeskey_len: reqWithThumb.aeskey.length,
    rawfilemd5: reqWithThumb.rawfilemd5,
    no_need_thumb: reqWithThumb.no_need_thumb,
  });

  const resp = await postJson(
    creds.baseUrl, "ilink/bot/getuploadurl", creds.botToken,
    reqWithThumb as unknown as Record<string, unknown>, DEFAULT_API_MS
  ) as GetUploadUrlResp;

  const respText = JSON.stringify(resp);

  // 检查错误码
  if (resp.errcode !== undefined && resp.errcode !== 0) {
    Logger.error(`[iLink] getuploadurl API error — errcode=${resp.errcode} errmsg=${resp.errmsg} raw=${respText.slice(0, 500)}`);
    throw new ClawBotError("ILINK_API_ERROR", `getuploadurl error ${resp.errcode}: ${resp.errmsg}`, 502, { errcode: resp.errcode, errmsg: resp.errmsg });
  }
  if (resp.ret !== undefined && resp.ret !== 0) {
    Logger.error(`[iLink] getuploadurl ret=${resp.ret} raw=${respText.slice(0, 500)}`);
    throw new ClawBotError("ILINK_API_ERROR", `getuploadurl ret=${resp.ret}`, 502, { ret: resp.ret });
  }

  // 提取 upload_full_url（这是真实协议的字段）
  // 可能的字段名：upload_full_url / uploadUrl / upload_url / upload_param
  let uploadFullUrl: string | undefined;
  const fieldCandidates = ["upload_full_url", "uploadUrl", "upload_url", "upload_param", "cdn_upload_url"];
  const respObj = resp as any;
  for (const k of fieldCandidates) {
    if (typeof respObj[k] === "string" && respObj[k].length > 0) {
      uploadFullUrl = respObj[k];
      break;
    }
  }

  if (!uploadFullUrl) {
    const keys = Object.keys(resp);
    const valueSummary: string[] = [];
    for (const k of keys) {
      const v = respObj[k];
      if (typeof v === "string") valueSummary.push(`${k}="${v.slice(0, 60)}"`);
      else if (typeof v === "number" || typeof v === "boolean") valueSummary.push(`${k}=${v}`);
      else if (typeof v === "object" && v !== null) valueSummary.push(`${k}=[${Object.keys(v).join(",")}]`);
    }
    Logger.error(
      `[iLink] getuploadurl NO upload_full_url — ALL_KEYS=[${keys.join(",")}] VALUES={${valueSummary.join(" | ")}} FULL_RAW=${respText.slice(0, 600)}`
    );
    throw new ClawBotError(
      "ILINK_UPLOAD_PARAM_MISSING",
      `getuploadurl missing upload_full_url. Keys: [${keys.join(",")}]`,
      502,
      { resp: respText.slice(0, 1000) }
    );
  }

  Logger.info(`[iLink] getuploadurl success — url=${uploadFullUrl.slice(0, 120)}...`);
  
  // 提取缩略图信息（如果 API 返回的话）
  const thumbUploadParam = respObj["thumb_upload_param"] || respObj["thumbUploadParam"] || respObj["thumb_param"];
  const thumbSize = respObj["thumb_size"] || respObj["thumbSize"] || 0;
  const thumbWidth = respObj["thumb_width"] || respObj["thumbWidth"] || 0;
  const thumbHeight = respObj["thumb_height"] || respObj["thumbHeight"] || 0;
  
  Logger.info(`[iLink] getuploadurl thumb info — hasThumbParam=${!!thumbUploadParam} thumbParamLen=${thumbUploadParam ? (thumbUploadParam as string).length : 0} thumbSize=${thumbSize} thumbWidth=${thumbWidth} thumbHeight=${thumbHeight}`);
  
  return { uploadFullUrl, thumbUploadParam, thumbSize, thumbWidth, thumbHeight };
}

// ========== 简单上传方式（参考 weixin-ilink SDK）==========
/**
 * 简单获取上传 URL（SDK 方式）
 * 返回 { upload_url, cdn_url } 格式
 */
export async function getSimpleUploadUrl(
  creds: ILinkCredentials,
  fileName: string,
  fileType: string,
  fileSize: number,
): Promise<{ upload_url: string; cdn_url: string }> {
  Logger.info("[iLink] Simple getuploadurl", { fileName, fileType, fileSize });
  
  const resp = await postJson(
    creds.baseUrl, "ilink/bot/getuploadurl", creds.botToken,
    { file_name: fileName, file_type: fileType, file_size: fileSize } as any,
    DEFAULT_API_MS
  ) as any;
  
  Logger.info("[iLink] Simple getuploadurl response", { keys: Object.keys(resp || {}) });
  
  // 尝试多种字段名
  const uploadUrl = resp.upload_url || resp.uploadUrl || resp.upload_full_url;
  const cdnUrl = resp.cdn_url || resp.download_url || uploadUrl;
  
  if (!uploadUrl) {
    throw new ClawBotError("ILINK_UPLOAD_MISSING", "getuploadurl missing upload_url", 502);
  }
  
  return { upload_url: uploadUrl, cdn_url: cdnUrl || uploadUrl };
}

/**
 * 简单上传文件（SDK 方式：PUT 到预签名 URL）
 */
export async function uploadFileSimple(
  uploadUrl: string,
  fileData: ArrayBuffer | Uint8Array,
  contentType: string = "application/octet-stream",
): Promise<void> {
  Logger.info("[iLink] Simple upload", { url: uploadUrl.substring(0, 80), size: fileData.byteLength, contentType });
  
  // TS 5.9: Uint8Array 默认是 Uint8Array<ArrayBufferLike>，与 BodyInit 不兼容，显式归一化
  const body = fileData instanceof Uint8Array ? fileData.buffer as ArrayBuffer : fileData;
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
    signal: AbortSignal.timeout(DEFAULT_UPLOAD_MS),
  });
  
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new ClawBotError("ILINK_UPLOAD_FAILED", `Upload failed: ${resp.status} ${errText}`, 502);
  }
  
  Logger.info("[iLink] Simple upload succeeded");
}

// ========== 原有复杂上传方式（保留兼容）==========
// 注：upload_full_url 是 getuploadurl 返回的完整 URL，已包含 encrypted_query_param
// 直接 POST 加密文件到该 URL 即可，响应头 x-encrypted-param 即为 CDNMedia 的下载 param

/**
 * 上传加密文件到 upload_full_url
 * @param uploadFullUrl getuploadurl 返回的完整 CDN URL
 * @param filekey 文件标识（日志用）
 * @param ciphertext AES-128-ECB+PKCS#7 加密数据
 * @param timeoutMs 单次超时
 */
export async function uploadEncryptedToCdn(
  uploadFullUrl: string,
  filekey: string,
  ciphertext: Uint8Array,
  timeoutMs: number = DEFAULT_UPLOAD_MS,
): Promise<string> {
  Logger.info(`[iLink] [Step 4/4] POST encrypted file to CDN`, {
    urlDomain: uploadFullUrl.substring(0, 80) + "...",
    filekey: filekey.substring(0, 16),
    ciphertextSize: ciphertext.length,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(uploadFullUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext.buffer as ArrayBuffer,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const errMsg = resp.headers.get("x-error-message") || "";
    const respText = await resp.text().catch(() => "");

    Logger.info(`[iLink] CDN upload response — HTTP ${resp.status} x-error-message="${errMsg.slice(0, 200)}" body=${respText.slice(0, 300)}`);

    if (!resp.ok) {
      throw new ClawBotError(
        "ILINK_CDN_HTTP_ERROR",
        `CDN upload HTTP ${resp.status}: ${errMsg || respText.slice(0, 200)}`,
        502,
        { status: resp.status, errMsg, body: respText }
      );
    }

    // 从响应头获取下载 param（标准协议：x-encrypted-param）
    const downloadParam = resp.headers.get("x-encrypted-param");
    const contentDisposition = resp.headers.get("content-disposition");

    Logger.info(`[iLink] CDN response headers analysis`, {
      headerNames: Array.from(resp.headers as any).join(","),
      xEncryptedParam: downloadParam ? `present(len=${downloadParam.length})` : "MISSING",
      contentDisposition: contentDisposition || "none",
      status: resp.status,
    });

    if (downloadParam && downloadParam.length > 0) {
      Logger.info(`[iLink] CDN upload OK — got x-encrypted-param (len=${downloadParam.length})`);
      return downloadParam;
    }

    // Fallback: 从响应体 JSON 中查找 download_param / encrypted_param
    try {
      const respBody = JSON.parse(respText);
      const fbKeys = ["download_param", "downloadParam", "encrypted_param", "encryptedParam", "download_encrypted_query_param", "query_param"];
      for (const k of fbKeys) {
        if (typeof respBody[k] === "string" && respBody[k].length > 0) {
          Logger.info(`[iLink] CDN upload OK — got ${k} from response body (len=${respBody[k].length})`);
          return respBody[k];
        }
      }
      // Fallback: 搜索响应体中任何看起来像 param 的字符串
      for (const [k, v] of Object.entries(respBody)) {
        if (typeof v === "string" && v.length > 20 && v !== uploadFullUrl) {
          Logger.info(`[iLink] CDN upload OK — using ${k} as download param (len=${v.length})`);
          return v;
        }
      }
    } catch (_) {
      // 不是 JSON，忽略
    }

    // 终极 fallback：从上传 URL 中提取 encrypted_query_param
    try {
      const url = new URL(uploadFullUrl);
      const paramFromUrl = url.searchParams.get("encrypted_query_param");
      if (paramFromUrl && paramFromUrl.length > 0) {
        Logger.info(`[iLink] CDN upload OK — using URL query encrypted_query_param as download param (len=${paramFromUrl.length})`);
        return paramFromUrl;
      }
    } catch (_) {}

    const headersDump: string[] = [];
    try { resp.headers.forEach((v: string, k: string) => headersDump.push(`${k}=${v.slice(0, 80)}`)); } catch (_) {}
    throw new ClawBotError(
      "ILINK_CDN_MISSING_PARAM",
      `CDN response has no x-encrypted-param. Headers: ${headersDump.join(" | ").substring(0, 400)}`,
      502
    );
  } catch (e: any) {
    clearTimeout(timer);
    if (e instanceof ClawBotError) throw e;
    if (e?.name === "AbortError") {
      throw new ClawBotError("ILINK_CDN_TIMEOUT", "CDN upload timeout", 504);
    }
    throw new ClawBotError("ILINK_CDN_ERROR", `CDN upload error: ${e?.message}`, 502, { error: e?.message });
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
  /** 缩略图大小 */
  thumbSize: number;
  /** 缩略图宽度 */
  thumbWidth: number;
  /** 缩略图高度 */
  thumbHeight: number;
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
  const startTime = Date.now();

  // 1. 计算参数
  const rawsize = fileData.length;
  const rawfilemd5 = md5Hex(fileData);
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = generateFilekeyHex();
  const aeskeyHex = generateAesKeyHex();

  Logger.info("[iLink] [Step 1/4] Preparing upload params", {
    filekey: filekey.substring(0, 16),
    mediaType,
    toUserId: toUserId.slice(0, 20),
    rawsize,
    filesize,
    md5: rawfilemd5,
  });

  // 2. 调用 getuploadurl - 需要提供缩略图信息
  Logger.info("[iLink] [Step 2/4] Calling getuploadurl API", { baseUrl: creds.baseUrl.substring(0, 80) });
  const getUploadStart = Date.now();
  
  // 根据 @weixin-claw/core 文档，缩略图信息是必需的
  // 对于图片，使用原图的前 64KB 作为缩略图
  const thumbData = fileData.slice(0, Math.min(fileData.length, 1024 * 64));
  const thumbRawsize = thumbData.length;
  const thumbRawfilemd5 = md5Hex(thumbData);
  const thumbFilesize = aesEcbPaddedSize(thumbRawsize);
  
  const { uploadFullUrl, thumbUploadParam, thumbSize, thumbWidth, thumbHeight } = await getUploadUrl(creds, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: false, // 需要缩略图
    aeskey: aeskeyHex,
    thumb_rawsize: thumbRawsize,
    thumb_rawfilemd5: thumbRawfilemd5,
    thumb_filesize: thumbFilesize,
  });
  Logger.info("[iLink] [Step 2/4] getuploadurl succeeded", {
    uploadFullUrlLen: uploadFullUrl.length,
    uploadFullUrlPrefix: uploadFullUrl.substring(0, 120),
    uploadFullUrlContainsCdn: uploadFullUrl.includes("cdn") || uploadFullUrl.includes("weixin"),
    elapsedMs: Date.now() - getUploadStart,
    hasThumb: !!thumbUploadParam,
    thumbSize,
    thumbWidth,
    thumbHeight,
  });

  // 3. AES-128-ECB 加密文件
  Logger.info("[iLink] [Step 3/4] Encrypting file", { plaintextSize: rawsize });
  const encryptStart = Date.now();
  const ciphertext = await encryptAesEcb(fileData, aeskeyHex);
  Logger.info("[iLink] [Step 3/4] File encrypted", {
    ciphertextSize: ciphertext.length,
    paddedSize: filesize,
    sizesMatch: ciphertext.length === filesize,
    elapsedMs: Date.now() - encryptStart,
  });

  // 3b. 加密缩略图
  const thumbCiphertext = await encryptAesEcb(thumbData, aeskeyHex);
  Logger.info("[iLink] [Step 3b/4] Thumbnail encrypted", {
    thumbCiphertextSize: thumbCiphertext.length,
    thumbPaddedSize: thumbFilesize,
  });

  // 4. 上传主文件到 CDN
  const cdnStart = Date.now();
  const downloadEncryptedQueryParam = await uploadEncryptedToCdn(uploadFullUrl, filekey, ciphertext);
  Logger.info("[iLink] [Step 4/4] Main file CDN upload completed", {
    downloadParamLen: downloadEncryptedQueryParam.length,
    elapsedMs: Date.now() - cdnStart,
  });

  // 4b. 上传缩略图到 CDN（如果有 thumbUploadParam）
  let thumbDownloadParam = "";
  if (thumbUploadParam && typeof thumbUploadParam === "string" && thumbUploadParam.length > 0) {
    try {
      // 构建缩略图上传 URL
      let thumbUploadUrl = thumbUploadParam;
      if (!thumbUploadParam.startsWith("http")) {
        const cdnBaseUrl = uploadFullUrl.split("?")[0];
        thumbUploadUrl = `${cdnBaseUrl}?${thumbUploadParam}`;
      }
      thumbDownloadParam = await uploadEncryptedToCdn(thumbUploadUrl, filekey + "_thumb", thumbCiphertext);
      Logger.info("[iLink] [Step 4b/4] Thumbnail CDN upload completed", {
        thumbDownloadParamLen: thumbDownloadParam.length,
      });
    } catch (thumbErr) {
      Logger.warn("[iLink] [Step 4b/4] Thumbnail upload failed, continuing without thumb", {
        error: thumbErr.message,
      });
    }
  }

  Logger.info("[iLink] Full upload pipeline completed", { totalMs: Date.now() - startTime });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskeyHex,
    // 与 @weixin-claw/core SDK 一致: Buffer.from(hexString).toString("base64")
    // 即把 hex 字符串当 UTF-8 文本做 base64 编码，而非 hex→binary→base64
    aeskeyBase64: btoa(aeskeyHex),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
    thumbSize,
    thumbWidth,
    thumbHeight,
  };
}
