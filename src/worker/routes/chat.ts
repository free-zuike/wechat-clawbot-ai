// 聊天路由 - KV 读配置

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply } from "../services/ai";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

  try {
    let body: any;
    try { body = await request.json(); } catch (e: any) {
      return json({ error: "INVALID_JSON", message: "无法解析请求体: " + e.message }, 400);
    }
    const rawMessage = body?.message;
    if (!rawMessage || typeof rawMessage !== "string" || !rawMessage.trim()) {
      return json({ error: "VALIDATION_ERROR", message: "请输入消息内容" }, 400);
    }

    const trimmed = rawMessage.trim();
    Logger.info(`[chat][${requestId}] message received`, { length: trimmed.length });

    const quick = tryQuickReply(trimmed);
    if (quick) return json({ reply: quick, source: "shortcut" });

    const config = await configCache.getOrLoad("config", async () => {
      let kvConfig: Record<string, any> = {};
      try {
        const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
        if (configRaw) kvConfig = JSON.parse(configRaw);
      } catch (_e) {}
      return {
        aiProvider: kvConfig.aiProvider || "cloudflare",
        aiModel: kvConfig.aiModel || "",
        aiBaseUrl: kvConfig.aiBaseUrl || "",
        aiApiKey: kvConfig.aiApiKey || "",
        aiMaxTokens: kvConfig.aiMaxTokens || 1024,
        aiSystemPrompt: kvConfig.aiSystemPrompt || "",
      };
    }, 10000);

    Logger.info(`[chat][${requestId}] provider`, { provider: config.aiProvider, model: config.aiModel || "default" });

    const reply = await callAI(env.AI, trimmed, config.aiSystemPrompt, config.aiModel, {
      provider: config.aiProvider,
      baseUrl: config.aiBaseUrl,
      apiKey: config.aiApiKey,
      maxTokens: config.aiMaxTokens,
    });

    Logger.info(`[chat][${requestId}] reply generated`, { replyLength: reply.length });
    return json({ reply, source: "ai" });
  } catch (e: any) {
    const msg = e?.message || String(e);
    Logger.error(`[chat][${requestId}] error`, { error: msg });
    return json({ reply: "错误: " + msg, source: "error" });
  }
}
