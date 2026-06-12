import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply } from "../services/ai";
import type { Env } from "../index";

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

  try {
    const body: any = await request.json();
    const message = body?.message;
    if (!message) return json({ error: "missing message" }, 400);

    Logger.info(`[chat][${requestId}] message received`, { length: message.length });

    // 1. 尝试快捷回复
    const quick = tryQuickReply(message);
    if (quick) {
      Logger.info(`[chat][${requestId}] shortcut reply`);
      return json({ reply: quick, source: "shortcut" });
    }

    // 2. 检查 AI 绑定是否存在
    Logger.info(`[chat][${requestId}] AI binding: ${env.AI ? "exists" : "NOT FOUND"}`);
    if (!env.AI) {
      Logger.error(`[chat][${requestId}] AI binding not found`);
      return json({ error: "AI_SERVICE_UNAVAILABLE", reply: "抱歉，AI 服务暂不可用，请联系管理员配置 Cloudflare AI。", source: "error" }, 503);
    }

    // 3. 从 KV 加载配置
    const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
    let kvConfig: any = {};
    try {
      if (configRaw) kvConfig = JSON.parse(configRaw);
    } catch {}

    const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
    const aiModel = env.AI_MODEL || kvConfig.aiModel || "";

    Logger.info(`[chat][${requestId}] model`, { aiModel: aiModel || "default" });

    // 4. 调用 AI
    const reply = await callAI(env.AI, message, systemPrompt, aiModel);
    Logger.info(`[chat][${requestId}] reply generated`, { replyLength: reply.length, preview: reply.slice(0, 100) });
    return json({ reply, source: "ai" });
  } catch (e: any) {
    Logger.error(`[chat][${requestId}] error`, { error: e?.message || String(e) }, e instanceof Error ? e : undefined);
    return json({ error: "INTERNAL_ERROR", reply: "抱歉，我刚刚脑子卡了一下 😅 能换个说法再问一遍吗？", source: "error" }, 500);
  }
}
