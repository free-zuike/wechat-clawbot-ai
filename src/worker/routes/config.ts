import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  // GET - 读取配置
  if (request.method === "GET") {
    const configRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
    let kvConfig: any = {};
    try {
      if (configRaw) kvConfig = JSON.parse(configRaw);
    } catch {}
    return json({
      aiModel: env.AI_MODEL || kvConfig.aiModel || "",
      aiSystemPrompt: env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "",
    });
  }

  // POST - 保存配置
  if (request.method === "POST") {
    const v = verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);
    try {
      const body: any = await request.json();
      const currentRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
      let current: any = {};
      try {
        if (currentRaw) current = JSON.parse(currentRaw);
      } catch {}
      const updated = {
        ...current,
        aiModel: body.aiModel || undefined,
        aiSystemPrompt: body.aiSystemPrompt || undefined,
      };
      await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));
      return json({ ok: true, config: updated });
    } catch (e: any) {
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
