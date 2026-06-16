// 聊天路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply } from "../services/ai";
import { configCache } from "../utils/cache";
import { resolveAIConfig } from "./config";
import type { Env } from "../index";

interface ChatResponse {
  reply: string;
  source: "shortcut" | "ai" | "error";
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch (e: unknown) {
      return json({ error: "INVALID_JSON", message: "无法解析请求体" }, 400);
    }

    const rawMessage = body.message;
    if (typeof rawMessage !== "string" || !rawMessage.trim()) {
      return json({ error: "VALIDATION_ERROR", message: "请输入消息内容" }, 400);
    }

    const trimmed = rawMessage.trim();
    Logger.info(`[chat][${requestId}] message`, { length: trimmed.length });

    const quick = tryQuickReply(trimmed);
    if (quick) return json({ reply: quick, source: "shortcut" } satisfies ChatResponse);

    const kv = await configCache.getOrLoad("config", async () => {
      let kvConfig: Record<string, unknown> = {};
      try {
        const raw = await env.CLAWBOT_KV.get("clawbot:config");
        if (raw) kvConfig = JSON.parse(raw);
      } catch (e) {
        Logger.warn("[chat] config read failed", { error: (e as Error).message });
      }
      return kvConfig;
    }, 10000);

    const aiConfig = resolveAIConfig(kv);
    const systemPrompt = (kv.aiSystemPrompt as string) || "";

    Logger.info(`[chat][${requestId}] provider`, { provider: aiConfig.provider, model: aiConfig.model || "default" });

    const reply = await callAI(env.AI, trimmed, systemPrompt, {
      provider: aiConfig.provider,
      model: aiConfig.model,
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      maxTokens: aiConfig.maxTokens,
    });

    Logger.info(`[chat][${requestId}] reply`, { length: reply.length });
    return json({ reply, source: "ai" } satisfies ChatResponse);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`[chat][${requestId}] error`, { error: msg });
    return json({ reply: "错误: " + msg, source: "error" } satisfies ChatResponse);
  }
}
