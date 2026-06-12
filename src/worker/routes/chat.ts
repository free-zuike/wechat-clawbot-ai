// 聊天路由 - 与 AI 对话（管理后台测试用）
// 优化：消息验证 + 响应缓存（配置）

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply } from "../services/ai";
import { validateChatMessage } from "../utils/validation";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

  try {
    const body: any = await request.json();
    const rawMessage = body?.message;

    // 验证消息
    if (typeof rawMessage !== "string") {
      return json({ error: "VALIDATION_ERROR", message: "message 必须是字符串" }, 400);
    }

    const trimmed = rawMessage.trim();
    const validation = validateChatMessage(trimmed);
    if (!validation.valid) {
      return json(
        { error: "VALIDATION_ERROR", message: "消息无效", errors: validation.errors },
        400
      );
    }

    Logger.info(`[chat][${requestId}] message received`, {
      length: trimmed.length,
    });

    // 1. 尝试快捷回复
    const quick = tryQuickReply(trimmed);
    if (quick) {
      Logger.info(`[chat][${requestId}] shortcut reply`);
      return json({ reply: quick, source: "shortcut" });
    }

    // 2. 检查 AI 绑定是否存在
    Logger.info(`[chat][${requestId}] AI binding: ${env.AI ? "exists" : "NOT FOUND"}`);
    if (!env.AI) {
      Logger.error(`[chat][${requestId}] AI binding not found`);
      return json(
        {
          error: "AI_SERVICE_UNAVAILABLE",
          reply: "抱歉，AI 服务暂不可用，请联系管理员配置 Cloudflare AI。",
          source: "error",
        },
        503
      );
    }

    // 3. 从缓存 + KV 加载配置
    const config = await configCache.getOrLoad(
      "config",
      async () => {
        const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
        let kvConfig: Record<string, string> = {};
        try {
          if (configRaw) kvConfig = JSON.parse(configRaw);
        } catch {
          Logger.warn(`[chat][${requestId}] failed to parse config`);
        }
        return {
          aiModel: env.AI_MODEL || kvConfig.aiModel || "",
          aiSystemPrompt: env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "",
        };
      },
      10000
    );

    const systemPrompt = config.aiSystemPrompt || "";
    const aiModel = config.aiModel || "";

    Logger.info(`[chat][${requestId}] model`, { aiModel: aiModel || "default" });

    // 4. 调用 AI
    const reply = await callAI(env.AI, trimmed, systemPrompt, aiModel);
    Logger.info(`[chat][${requestId}] reply generated`, {
      replyLength: reply.length,
      preview: reply.slice(0, 100),
    });
    return json({ reply, source: "ai" });
  } catch (e: any) {
    // 捕获 JSON 解析等非预期错误
    const msg = e?.message || String(e);
    if (msg.includes("JSON")) {
      return json(
        { error: "INVALID_JSON", message: "无效的 JSON 请求体", reply: "请使用正确的 JSON 格式发送消息" },
        400
      );
    }

    Logger.error(
      `[chat][${requestId}] error`,
      { error: msg },
      e instanceof Error ? e : undefined
    );
    return json(
      {
        error: "INTERNAL_ERROR",
        reply: "抱歉，我刚刚脑子卡了一下 😅 能换个说法再问一遍吗？",
        source: "error",
      },
      500
    );
  }
}
