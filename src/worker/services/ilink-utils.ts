// iLink DO - 纯工具函数（消息 ID 生成）
// 从 ilink-do.ts 拆出：hashText / generateMessageId，无 DO 状态依赖

import type { WeixinMessage } from "../types";

// FNV-1a 哈希，生成稳定的短哈希（hex）
export function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

// 从消息字段生成稳定 messageId（跨重复轮询去重用）
export function generateMessageId(msg: WeixinMessage, text: string = ""): string {
  const parts = [
    msg.from_user_id || "",
    msg.context_token || "",
    msg.message_id ?? "",
    msg.create_time_ms ?? "",
    msg.seq ?? ""
  ];
  const primary = parts.filter(Boolean).join(":");

  if (primary) {
    return primary.slice(0, 128);
  }

  // 兜底：某些历史消息字段不完整时，使用发送者 + 上下文 + 文本哈希生成稳定 ID
  return [
    msg.from_user_id || "unknown",
    msg.context_token || "",
    hashText(text || JSON.stringify(msg.item_list || [])),
  ].join(":").slice(0, 128);
}