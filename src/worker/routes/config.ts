// 配置路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";
const CONFIG_FIELDS = ["aiProvider", "aiModel", "aiBaseUrl", "aiApiKey", "aiMaxTokens", "aiSystemPrompt", "webhookUrl", "webhookEnabled", "webhookTitle", "webhookApiKey", "webhookChannels", "aiPresets", "aiActivePresetId", "aiCustomProviders"] as const;
type ConfigField = (typeof CONFIG_FIELDS)[number];

function maskKey(key: string): string {
  return key.length <= 8 ? "***" : key.slice(0, 4) + "***" + key.slice(-4);
}

function getConfigResponse(kvConfig: Record<string, unknown>) {
  return {
    aiProvider: (kvConfig.aiProvider as string) || "cloudflare",
    aiModel: (kvConfig.aiModel as string) || "",
    aiBaseUrl: (kvConfig.aiBaseUrl as string) || "",
    aiApiKey: typeof kvConfig.aiApiKey === "string" && kvConfig.aiApiKey ? maskKey(kvConfig.aiApiKey as string) : "",
    aiMaxTokens: (kvConfig.aiMaxTokens as number) || 1024,
    aiSystemPrompt: (kvConfig.aiSystemPrompt as string) || "",
    webhookUrl: (kvConfig.webhookUrl as string) || "",
    webhookEnabled: (kvConfig.webhookEnabled as boolean) || false,
    webhookTitle: (kvConfig.webhookTitle as string) || "",
    webhookApiKey: typeof kvConfig.webhookApiKey === "string" && kvConfig.webhookApiKey ? maskKey(kvConfig.webhookApiKey as string) : "",
    webhookChannels: (kvConfig.webhookChannels as string[]) || [],
    aiPresets: (kvConfig.aiPresets as any[]) || [],
    aiActivePresetId: (kvConfig.aiActivePresetId as string) || "cloudflare",
    aiCustomProviders: (kvConfig.aiCustomProviders as any[]) || [],
  };
}

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    const result = await configCache.getOrLoad("config", async () => {
      let kvConfig: Record<string, unknown> = {};
      try {
        const raw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
        if (raw) kvConfig = JSON.parse(raw);
      } catch (e) {
        Logger.warn("[config] KV read failed", { error: (e as Error).message });
      }
      return { ...getConfigResponse(kvConfig), hasEnvOverride: !!(env.AI_MODEL || env.AI_SYSTEM_PROMPT) };
    }, 10000);

    return json(result);
  }

  if (request.method === "POST") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    Logger.info("[config] POST update");

    try {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return json({ error: "INVALID_JSON", message: "无效的 JSON 请求体" }, 400);
      }

      if (typeof body !== "object" || body === null) {
        return json({ error: "VALIDATION_ERROR", message: "请求体必须是 JSON 对象" }, 400);
      }

      let current: Record<string, unknown> = {};
      try {
        const raw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
        if (raw) current = JSON.parse(raw);
      } catch (e) {
        Logger.warn("[config] KV read failed", { error: (e as Error).message });
      }

      const updated: Record<string, unknown> = { ...current };

      for (const field of CONFIG_FIELDS) {
        if (field in body) {
          const val = body[field];
          if (typeof val === "string") updated[field] = val.trim();
          else if (typeof val === "number") updated[field] = val;
          else if (typeof val === "boolean") updated[field] = val;
          else if (Array.isArray(val)) updated[field] = val;
        }
      }

      if (updated.aiProvider && !["cloudflare", "openai"].includes(updated.aiProvider as string)) {
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
      if (typeof updated.aiApiKey === "string" && updated.aiApiKey.includes("***")) {
        updated.aiApiKey = current.aiApiKey || "";
      }
      if (typeof updated.webhookApiKey === "string" && updated.webhookApiKey.includes("***")) {
        updated.webhookApiKey = current.webhookApiKey || "";
      }

      for (const field of CONFIG_FIELDS) {
        if (updated[field] === undefined && field !== "aiProvider" && field !== "aiMaxTokens") {
          delete updated[field];
        }
      }

      await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));
      configCache.invalidate("config");

      Logger.info("[config] updated", { provider: updated.aiProvider, model: updated.aiModel });
      return json({ ok: true, message: "配置已保存" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error("[config] update error", { error: msg });
      return json({ error: msg }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
