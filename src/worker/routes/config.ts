// 配置路由 - KV 读写

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";
const CACHE_KEY = "config";

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    const result = await configCache.getOrLoad(CACHE_KEY, async () => {
      let kvConfig: Record<string, any> = {};
      try {
        const configRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
        if (configRaw) kvConfig = JSON.parse(configRaw);
      } catch (_e) {}

      return {
        aiProvider: kvConfig.aiProvider || "cloudflare",
        aiModel: kvConfig.aiModel || "",
        aiBaseUrl: kvConfig.aiBaseUrl || "",
        aiApiKey: kvConfig.aiApiKey ? maskKey(kvConfig.aiApiKey) : "",
        aiMaxTokens: kvConfig.aiMaxTokens || 1024,
        aiSystemPrompt: kvConfig.aiSystemPrompt || "",
        hasEnvOverride: !!(env.AI_MODEL || env.AI_SYSTEM_PROMPT),
      };
    }, 10000);

    return json(result);
  }

  if (request.method === "POST") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    Logger.info("[config] POST update requested");

    try {
      let body: any;
      try { body = await request.json(); } catch (e: any) {
        return json({ error: "INVALID_JSON", message: "无效的 JSON 请求体" }, 400);
      }

      if (typeof body !== "object" || body === null) {
        return json({ error: "VALIDATION_ERROR", message: "请求体必须是 JSON 对象" }, 400);
      }

      // 读取当前配置
      let current: Record<string, any> = {};
      try {
        const currentRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
        if (currentRaw) current = JSON.parse(currentRaw);
      } catch (_e) {}

      const updated: Record<string, any> = { ...current };
      const CONFIG_FIELDS = ["aiProvider", "aiModel", "aiBaseUrl", "aiApiKey", "aiMaxTokens", "aiSystemPrompt"];

      for (const field of CONFIG_FIELDS) {
        if (field in body) {
          const val = body[field];
          if (typeof val === "string") updated[field] = val.trim();
          else if (typeof val === "number") updated[field] = val;
        }
      }

      if (updated.aiProvider && !["cloudflare", "openai"].includes(updated.aiProvider)) {
        return json({ error: "VALIDATION_ERROR", message: "aiProvider 必须是 cloudflare 或 openai" }, 400);
      }
      if (updated.aiProvider === "openai" && !updated.aiBaseUrl) {
        return json({ error: "VALIDATION_ERROR", message: "使用 OpenAI 兼容 API 时，API 地址为必填" }, 400);
      }
      if (updated.aiProvider === "openai" && !updated.aiApiKey) {
        return json({ error: "VALIDATION_ERROR", message: "使用 OpenAI 兼容 API 时，API 密钥为必填" }, 400);
      }
      if (updated.aiMaxTokens !== undefined) {
        const n = Number(updated.aiMaxTokens);
        if (isNaN(n) || n < 1 || n > 32000) return json({ error: "VALIDATION_ERROR", message: "max_tokens 必须在 1-32000 之间" }, 400);
        updated.aiMaxTokens = n;
      }
      if (updated.aiApiKey && updated.aiApiKey.includes("***")) {
        updated.aiApiKey = current.aiApiKey || "";
      }

      for (const field of CONFIG_FIELDS) {
        if ((updated[field] === "" || updated[field] === undefined) && field !== "aiProvider" && field !== "aiMaxTokens") {
          delete updated[field];
        }
      }

      await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));
      configCache.invalidate(CACHE_KEY);

      Logger.info("[config] updated", { provider: updated.aiProvider, model: updated.aiModel });
      return json({ ok: true, message: "配置已保存" });
    } catch (e: any) {
      Logger.error("[config] update error", { error: e?.message || String(e) });
      return json({ error: e?.message || String(e) }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
