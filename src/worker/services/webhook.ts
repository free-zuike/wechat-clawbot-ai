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

  const title = config.title || "ClawBot AI";
  const content = [
    `From: ${data.fromUserId}`,
    `Content: ${data.content}`,
    data.replyContent ? `Reply: ${data.replyContent}` : null,
    `Time: ${data.timestamp}`,
  ].filter(Boolean).join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey;
  }

  const body = JSON.stringify({ title, content, channels: config.channels || [] });

  // 重试 3 次：立即 → 1秒 → 3秒
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        Logger.info("[Webhook] push sent", { to: data.fromUserId, attempt: attempt + 1 });
        return;
      }
      const bodyText = await resp.text().catch(() => "");
      Logger.warn("[Webhook] push failed", { status: resp.status, body: bodyText.slice(0, 200), attempt: attempt + 1 });
      if (attempt < 2) await new Promise(r => setTimeout(r, [0, 1000, 3000][attempt]));
    } catch (e) {
      Logger.warn("[Webhook] push error", { error: (e as Error).message, attempt: attempt + 1 });
      if (attempt < 2) await new Promise(r => setTimeout(r, [0, 1000, 3000][attempt]));
    }
  }
}
