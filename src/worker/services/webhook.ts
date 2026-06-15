// Webhook 推送服务 - 消息到达时推送到 bee-swarm

import { Logger } from "../utils/error";

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  apiKey?: string;
  channels?: string[];
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
  const content = [
    `来自: ${data.fromUserId}`,
    `内容: ${data.content}`,
    data.replyContent ? `回复: ${data.replyContent}` : null,
    `时间: ${data.timestamp}`,
  ].filter(Boolean).join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  try {
    const resp = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, content, channels: config.channels || [] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      Logger.warn("[Webhook] push failed", { status: resp.status, body: body.slice(0, 200) });
    } else {
      Logger.info("[Webhook] push sent", { to: data.fromUserId });
    }
  } catch (e) {
    Logger.warn("[Webhook] push error", { error: (e as Error).message });
  }
}
