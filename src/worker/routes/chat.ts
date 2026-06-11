import { json } from "../utils";
import { callAI, tryQuickReply } from "../services/ai";
import type { Env } from "../index";

export async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const message = body?.message;
    if (!message) return json({ error: "missing message" }, 400);

    // 1. 尝试快捷回复
    const quick = tryQuickReply(message);
    if (quick) return json({ reply: quick, source: "shortcut" });

    // 2. 检查 AI 绑定是否存在
    if (!env.AI) {
      console.error("[chat] AI binding not found");
      return json({ reply: "抱歉，AI 服务暂不可用，请稍后重试。", source: "error" });
    }

    // 3. 从 KV 加载配置
    const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
    let kvConfig: any = {};
    try {
      if (configRaw) kvConfig = JSON.parse(configRaw);
    } catch {}

    const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
    const aiModel = env.AI_MODEL || kvConfig.aiModel || "";

    // 4. 调用 AI
    const reply = await callAI(env.AI, message, systemPrompt, aiModel);
    return json({ reply, source: "ai" });
  } catch (e: any) {
    console.error("[chat] error:", e);
    return json({ reply: "抱歉，我刚刚脑子卡了一下 😅 能换个说法再问一遍吗？", source: "error" });
  }
}
