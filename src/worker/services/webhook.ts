// Webhook 推送服务 - 消息到达时推送到 bee-swarm

import { Logger } from "../utils/error";

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  title?: string;
}

export async function sendWebhook(config: WebhookConfig, data: {
  fromUserId: string;
  content: string;
  replyContent?: string;
  timestamp: string;
}): Promise<void> {
  if (!config.enabled || !config.url) return;

  const title = config.title || "🦞 ClawBot AI 消息";
  const body = [
    `来自: ${data.fromUserId}`,
    `内容: ${data.content}`,
    data.replyContent ? `回复: ${data.replyContent}` : null,
    `时间: ${data.timestamp}`,
  ].filter(Boolean).join("\n");

  try {
    const resp = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      Logger.warn("[Webhook] push failed", { status: resp.status });
    } else {
      Logger.info("[Webhook] push sent", { to: data.fromUserId });
    }
  } catch (e) {
    Logger.warn("[Webhook] push error", { error: (e as Error).message });
  }
}
