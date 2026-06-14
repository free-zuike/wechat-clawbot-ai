// 聊天路由 - 与 AI 对话（管理后台测试用）

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
    try {
      body = await request.json();
    } catch (e: any) {
      return json({ error: "INVALID_JSON", message: "无法解析请求体: " + e.message }, 400);
    }
    const rawMessage = body?.message;

    if (!rawMessage || typeof rawMessage !== "string" || !rawMessage.trim()) {
      return json({ error: "VALIDATION_ERROR", message: "请输入消息内容" }, 400);
    }

    const trimmed = rawMessage.trim();
    Logger.info(`[chat][${requestId}] message received`, { length: trimmed.length });

    // 快捷回复
    const quick = tryQuickReply(trimmed);
    if (quick) {
      return json({ reply: quick, source: "shortcut" });
    }

    // 加载配置
    const config = await configCache.getOrLoad(
      "config",
      async () => {
        // 先查 KV
        const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
        let kvConfig: Record<string, any> = {};
        try {
          if (configRaw) kvConfig = JSON.parse(configRaw);
        } catch {}

        // KV 无数据时查 DO
        if (!kvConfig.aiProvider && env.ILINK_CONNECTION) {
          try {
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            const resp = await doStub.fetch(new Request("http://localhost/get-config"));
            const data = await resp.json() as any;
            if (data.config) kvConfig = data.config;
          } catch {}
        }

        return {
          aiProvider: kvConfig.aiProvider || "cloudflare",
          aiModel: kvConfig.aiModel || "",
          aiBaseUrl: kvConfig.aiBaseUrl || "",
          aiApiKey: kvConfig.aiApiKey || "",
          aiMaxTokens: kvConfig.aiMaxTokens || 1024,
          aiSystemPrompt: kvConfig.aiSystemPrompt || "",
        };
      },
      10000
    );

    const systemPrompt = config.aiSystemPrompt || "";
    const aiModel = config.aiModel || "";

    Logger.info(`[chat][${requestId}] provider`, { provider: config.aiProvider, model: aiModel || "default" });

    // 调用 AI
    const reply = await callAI(env.AI, trimmed, systemPrompt, aiModel, {
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
    return json({ error: "INTERNAL_ERROR", reply: "错误: " + msg, source: "error" });
  }
}
