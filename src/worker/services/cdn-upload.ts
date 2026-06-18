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
    Logger.info(`[iLink] POST ${endpoint}`, { status: r.status, respLen: text.length, respPreview: text.slice(0, 500) });
    if (!r.ok) {
      Logger.warn(`[iLink] POST ${endpoint} failed`, { status: r.status, response: text.slice(0, 500) });
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
// CDN 主机名尝试列表（不同微信环境可能不同）
const CDN_HOST_CANDIDATES = [
  "https://ilinkai.weixin.qq.com/c2c",
  "https://novac2c.cdn.weixin.qq.com/c2c",
  "https://ilink.cdn.weixin.qq.com/c2c",
  "https://cdn.ilink.weixin.qq.com/c2c",
];

/**
 * 上传加密文件到 Weixin CDN
 * 响应头 x-encrypted-param 即为下载参数（downloadEncryptedQueryParam）
 */
export async function uploadEncryptedToCdn(
  uploadParam: string,
  filekey: string,
  ciphertext: Uint8Array,
  timeoutMs: number = DEFAULT_UPLOAD_MS,
  baseUrlCandidates: string[] = CDN_HOST_CANDIDATES,
): Promise<string> {
  let lastError: ClawBotError | null = null;

  for (let i = 0; i < baseUrlCandidates.length; i++) {
    const cdnBaseUrl = baseUrlCandidates[i]!;
    const cdnUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    Logger.info(`[iLink] CDN upload attempt ${i + 1}/${baseUrlCandidates.length}`, {
      cdnUrl: cdnUrl.substring(0, 120),
      filekey,
      ciphertextSize: ciphertext.length,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const resp = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const errMsg = resp.headers.get("x-error-message") || "";
      const respText = await resp.text().catch(() => "");

      Logger.info(`[iLink] CDN upload response`, {
        host: cdnBaseUrl,
        status: resp.status,
        xErrorMessage: errMsg.slice(0, 200),
        bodyLen: respText.length,
        body: respText.slice(0, 300),
      });

      if (resp.status >= 400 && resp.status < 500) {
        lastError = new ClawBotError(
          "ILINK_CDN_CLIENT_ERROR",
          `CDN ${resp.status}: ${errMsg || respText.slice(0, 200)}`,
          502,
          { status: resp.status, errMsg, body: respText }
        );
        continue;
      }
      if (resp.status !== 200) {
        lastError = new ClawBotError(
          "ILINK_CDN_SERVER_ERROR",
          `CDN ${resp.status}: ${errMsg}`,
          502
        );
        continue;
      }

      const downloadParam = resp.headers.get("x-encrypted-param");
      if (!downloadParam) {
        const headersList: string[] = [];
        try { resp.headers.forEach((v: string, k: string) => headersList.push(`${k}: ${v.slice(0, 50)}`)); } catch (_) {}
        Logger.error("[iLink] CDN response missing x-encrypted-param header", { headers: headersList });
        lastError = new ClawBotError(
          "ILINK_CDN_MISSING_PARAM",
          "CDN response missing x-encrypted-param header",
          502
        );
        continue;
      }

      Logger.info("[iLink] CDN upload success", {
        host: cdnBaseUrl,
        filekey,
        downloadParamLen: downloadParam.length,
      });
      return downloadParam;
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        lastError = new ClawBotError("ILINK_CDN_TIMEOUT", `CDN upload timeout (${cdnBaseUrl})`, 504);
      } else {
        lastError = new ClawBotError(
          "ILINK_CDN_ERROR",
          `CDN upload error (${cdnBaseUrl}): ${e?.message}`,
          502,
          { error: e?.message }
        );
      }
      Logger.warn("[iLink] CDN upload attempt failed", {
        host: cdnBaseUrl,
        attempt: i + 1,
        error: e?.message,
      });
      // 下次尝试前短暂等待
      if (i < baseUrlCandidates.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // 所有主机都失败
  throw lastError || new ClawBotError("ILINK_CDN_ERROR", "All CDN upload attempts failed", 502);
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

  // 2. 调用 getuploadurl
  Logger.info("[iLink] [Step 2/4] Calling getuploadurl API", { baseUrl: creds.baseUrl.substring(0, 80) });
  const getUploadStart = Date.now();
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
  Logger.info("[iLink] [Step 2/4] getuploadurl succeeded", {
    uploadParamLen: upload_param.length,
    elapsedMs: Date.now() - getUploadStart,
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

  // 4. 上传到 CDN
  Logger.info("[iLink] [Step 4/4] Uploading encrypted file to CDN");
  const cdnStart = Date.now();
  const downloadEncryptedQueryParam = await uploadEncryptedToCdn(upload_param, filekey, ciphertext);
  Logger.info("[iLink] [Step 4/4] CDN upload completed", {
    downloadParamLen: downloadEncryptedQueryParam.length,
    elapsedMs: Date.now() - cdnStart,
  });

  Logger.info("[iLink] Full upload pipeline completed", { totalMs: Date.now() - startTime });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskeyHex,
    aeskeyBase64: hexToBase64(aeskeyHex),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
