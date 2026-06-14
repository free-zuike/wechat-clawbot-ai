// 聊天路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply } from "../services/ai";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

interface ChatConfig {
  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiMaxTokens: number;
  aiSystemPrompt: string;
}

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

    const config: ChatConfig = await configCache.getOrLoad("config", async () => {
      let kv: Record<string, unknown> = {};
      try {
        const raw = await env.CLAWBOT_KV.get("clawbot:config");
        if (raw) kv = JSON.parse(raw);
      } catch (e) {
        Logger.warn("[chat] config read failed", { error: (e as Error).message });
      }
      return {
        aiProvider: (kv.aiProvider as string) || "cloudflare",
        aiModel: (kv.aiModel as string) || "",
        aiBaseUrl: (kv.aiBaseUrl as string) || "",
        aiApiKey: (kv.aiApiKey as string) || "",
        aiMaxTokens: (kv.aiMaxTokens as number) || 1024,
        aiSystemPrompt: (kv.aiSystemPrompt as string) || "",
      };
    }, 10000);

    Logger.info(`[chat][${requestId}] provider`, { provider: config.aiProvider, model: config.aiModel || "default" });

    const reply = await callAI(env.AI, trimmed, config.aiSystemPrompt, config.aiModel, {
      provider: config.aiProvider,
      baseUrl: config.aiBaseUrl,
      apiKey: config.aiApiKey,
      maxTokens: config.aiMaxTokens,
    });

    Logger.info(`[chat][${requestId}] reply`, { length: reply.length });
    return json({ reply, source: "ai" } satisfies ChatResponse);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`[chat][${requestId}] error`, { error: msg });
    return json({ reply: "错误: " + msg, source: "error" } satisfies ChatResponse);
  }
}
