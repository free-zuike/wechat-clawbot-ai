// iLink 协议 - 消息解析与文本提取
// 从 ilink.ts 拆出：extractMessageText / translateEmoji / MP4 时长解析

import { Logger } from "../utils/error";
import { MessageItemType } from "./ilink-constants";
import type { WeixinMessage } from "../types";

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

export function extractMessageText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  
  const parts: string[] = [];
  
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      // 记录引用消息的原始结构，便于诊断
      if (ref) {
        Logger.info("[iLink] Received quoted message", { refKeys: Object.keys(ref), title: ref.title, hasMessageItem: !!ref.message_item, itemKeys: ref.message_item ? Object.keys(ref.message_item) : [] });
      }
      // 提取被引用消息的内容（可能在 ref.message_item 里，而不只是 ref.title）
      let quoted = "";
      if (ref?.message_item) {
        const q = ref.message_item;
        if (q.text_item?.text) quoted = q.text_item.text;
        else if (q.image_item) quoted = q.image_item.url || "图片";
        else if (q.file_item) quoted = q.file_item.file_name || "文件";
        else if (q.video_item) quoted = q.video_item.url || "视频";
        else if (q.voice_item?.text) quoted = q.voice_item.text;
      }
      const refText = quoted || ref?.title || "";
      if (refText) {
        parts.push(`[引用: ${translateEmoji(refText)}]\n${translateEmoji(item.text_item.text)}`);
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

/**
 * 从 MP4 二进制数据中提取视频时长（秒）
 * MP4 结构：moov -> mvhd -> duration / timescale
 */
export function extractMp4Duration(data: Uint8Array): number | null {
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