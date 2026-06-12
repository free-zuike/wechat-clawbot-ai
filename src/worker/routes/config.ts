// 配置路由 - 读取/保存 AI 模型和人设提示词
// 优化：请求验证 + 响应缓存 + 更清晰的错误

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { validateModelName, validatePrompt, validateObject } from "../utils/validation";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";
const CACHE_KEY = "config";

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

    // 使用缓存 - 避免每次都读 KV
    const result = await configCache.getOrLoad(CACHE_KEY, async () => {
      const configRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
      let kvConfig: Record<string, string> = {};
      try {
        if (configRaw) kvConfig = JSON.parse(configRaw);
      } catch {
        Logger.warn('[config] failed to parse cached config, using empty');
      }
      return {
        aiModel: env.AI_MODEL || kvConfig.aiModel || "",
        aiSystemPrompt: env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "",
        hasEnvOverride: !!(env.AI_MODEL || env.AI_SYSTEM_PROMPT),
      };
    }, 10000); // 10 秒缓存

    return json(result);
  }

  // POST - 保存配置（需要认证 + 频率限制）
  if (request.method === "POST") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    const rl = checkConfigRateLimit(request);
    if (!rl.allowed) {
      Logger.warn('[config] POST rate limited');
      return json({
        error: "RATE_LIMITED",
        message: "请求过于频繁，请稍后重试",
        retryAfter: rl.retryAfter
      }, 429);
    }

    Logger.info('[config] POST update requested');

    try {
      const body = await request.json() as Record<string, unknown>;

      // 验证 body 结构
      const schemaCheck = validateObject(body, {
        aiModel: { type: "string", maxLength: 128 },
        aiSystemPrompt: { type: "string", maxLength: 4096 },
      });
      if (!schemaCheck.valid) {
        return json({ error: "VALIDATION_ERROR", errors: schemaCheck.errors }, 400);
      }

      // 逐项验证
      const allErrors: string[] = [];
      if (body.aiModel !== undefined && body.aiModel !== "") {
        const r = validateModelName(String(body.aiModel));
        if (!r.valid) allErrors.push(...r.errors);
      }
      if (body.aiSystemPrompt !== undefined && body.aiSystemPrompt !== "") {
        const r = validatePrompt(String(body.aiSystemPrompt));
        if (!r.valid) allErrors.push(...r.errors);
      }
      if (allErrors.length > 0) {
        Logger.warn('[config] validation failed', { errors: allErrors });
        return json({ error: "VALIDATION_ERROR", errors: allErrors }, 400);
      }

      // 读取当前配置
      const currentRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
      let current: Record<string, string> = {};
      try {
        if (currentRaw) current = JSON.parse(currentRaw);
      } catch { /* ignore */ }

      // 应用变更 - 空字符串视为清空该字段
      const updated: Record<string, string> = {
        ...current,
        aiModel: typeof body.aiModel === "string" ? body.aiModel.trim() : current.aiModel,
        aiSystemPrompt: typeof body.aiSystemPrompt === "string" ? body.aiSystemPrompt.trim() : current.aiSystemPrompt,
      };

      // 移除空字段（让环境变量或默认值生效）
      if (!updated.aiModel) delete updated.aiModel;
      if (!updated.aiSystemPrompt) delete updated.aiSystemPrompt;

      await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));

      // 清空缓存
      configCache.invalidate(CACHE_KEY);

      Logger.info('[config] updated', {
        hasAiModel: !!updated.aiModel,
        hasPrompt: !!updated.aiSystemPrompt,
      });

      return json({
        ok: true,
        config: updated,
        message: "配置已保存，将在下次消息处理时生效",
      });
    } catch (e: any) {
      // JSON 解析错误等非预期情况
      const msg = e?.message || String(e);
      if (msg.includes("JSON")) {
        return json({ error: "INVALID_JSON", message: "无效的 JSON 请求体" }, 400);
      }
      Logger.error('[config] update error', { error: msg });
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
