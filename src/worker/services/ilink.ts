// iLink 协议实现 - 统一入口（模块汇聚）
// 拆分说明：
//   ilink-constants.ts   常量（MessageType / MessageItemType / 协议常量）
//   ilink-send.ts        消息发送（post / sendText / sendMedia / CDN 下载）
//   ilink-parse.ts       消息解析（extractMessageText / translateEmoji / MP4 时长）
// 本文件：扫码登录 + 消息轮询 + 重新导出全部公开 API

import { Logger, withRetry, ClawBotError } from "../utils/error";
import { DEFAULT_BASE, DEFAULT_LONG_POLL_MS } from "./ilink-constants";
import { post } from "./ilink-send";
import type { ILinkCredentials, GetUpdatesResp } from "../types";

// ========== 重新导出 ==========
export { MessageType, MessageItemType, MessageState, TypingStatus } from "./ilink-constants";
export { uploadMediaToCdn, UploadMediaType } from "./cdn-upload";
export { getSimpleUploadUrl, uploadFileSimple } from "./cdn-upload";
export {
  sendTypingStatus, sendTextMessage, sendTextChunked, sendMediaMessage,
  sendImageSimple, sendImageMessage, sendVideoMessage, sendFileFromUrl,
  uploadAndSendMedia, downloadImageFromCdn,
} from "./ilink-send";
export { translateEmoji, extractMessageText, extractMp4Duration } from "./ilink-parse";

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
    
    if (!r.ok) return { status: "wait" };
    
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