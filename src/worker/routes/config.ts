import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";

// 轻量级 IP 频率限制（60 秒 10 次）
const configRateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkConfigRateLimit(request: Request): { allowed: boolean; retryAfter: number } {
  const ip = request.headers.get('CF-Connecting-IP') ||
             request.headers.get('X-Forwarded-For') ||
             request.headers.get('X-Real-IP') || 'unknown';
  const now = Date.now();
  const existing = configRateLimiter.get(ip);
  if (existing && now >= existing.resetAt) {
    configRateLimiter.delete(ip);
  }
  const current = configRateLimiter.get(ip) || { count: 0, resetAt: now + 60000 };
  current.count++;
  configRateLimiter.set(ip, current);

  const allowed = current.count <= 10;
  const retryAfter = Math.ceil((current.resetAt - now) / 1000);

  // 清理过期 key
  if (configRateLimiter.size > 1000) {
    for (const [k, v] of configRateLimiter.entries()) {
      if (now >= v.resetAt) configRateLimiter.delete(k);
    }
  }

  return { allowed, retryAfter };
}

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  // GET - 读取配置（需要认证）
  if (request.method === "GET") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

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

  // POST - 保存配置（需要认证 + 频率限制）
  if (request.method === "POST") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    const rl = checkConfigRateLimit(request);
    if (!rl.allowed) {
      Logger.warn('[config] POST rate limited');
      return json({ error: "RATE_LIMITED", message: "请求过于频繁，请稍后重试", retryAfter: rl.retryAfter }, 429);
    }

    Logger.info('[config] POST update requested');

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
      Logger.info('[config] updated', { hasAiModel: !!updated.aiModel, hasPrompt: !!updated.aiSystemPrompt });
      return json({ ok: true, config: updated });
    } catch (e: any) {
      Logger.error('[config] update error', { error: e?.message || String(e) });
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
