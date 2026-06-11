import { json } from "../utils";
import { callAI, tryQuickReply } from "../services/ai";
import type { Env } from "../index";

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.log(`[chat][${requestId}] handleChat called`);
  
  try {
    const body: any = await request.json();
    const message = body?.message;
    if (!message) return json({ error: "missing message" }, 400);

    console.log(`[chat][${requestId}] message:`, message);

    // 1. 尝试快捷回复
    const quick = tryQuickReply(message);
    if (quick) {
      console.log(`[chat][${requestId}] shortcut reply`);
      return json({ reply: quick, source: "shortcut" });
    }

    // 2. 检查 AI 绑定是否存在
    console.log(`[chat][${requestId}] AI binding:`, env.AI ? "exists" : "NOT FOUND");
    if (!env.AI) {
      console.error(`[chat][${requestId}] AI binding not found`);
      return json({ reply: "抱歉，AI 服务暂不可用，请联系管理员配置 Cloudflare AI。", source: "error" });
    }

    // 3. 从 KV 加载配置
    const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
    let kvConfig: any = {};
    try {
      if (configRaw) kvConfig = JSON.parse(configRaw);
    } catch {}

    const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
    const aiModel = env.AI_MODEL || kvConfig.aiModel || "";
    
    console.log(`[chat][${requestId}] model:`, aiModel || "default");

    // 4. 调用 AI
    const reply = await callAI(env.AI, message, systemPrompt, aiModel);
    console.log(`[chat][${requestId}] reply:`, reply.slice(0, 100));
    return json({ reply, source: "ai" });
  } catch (e: any) {
    console.error(`[chat][${requestId}] error:`, e);
    return json({ reply: "抱歉，我刚刚脑子卡了一下 😅 能换个说法再问一遍吗？", source: "error" });
  }
}
