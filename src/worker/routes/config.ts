// 配置路由 - 读取/保存 AI 配置（支持 Cloudflare AI + OpenAI 兼容 API）

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";
const CACHE_KEY = "config";

// 配置字段白名单
const CONFIG_FIELDS = ["aiProvider", "aiModel", "aiBaseUrl", "aiApiKey", "aiMaxTokens", "aiSystemPrompt"];

export async function handleConfig(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const v = await verifyAdmin(request, env);
    if (!v.ok) return json({ error: v.error }, 401);

    const result = await configCache.getOrLoad(CACHE_KEY, async () => {
      // 先查 KV
      const configRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
      let kvConfig: Record<string, any> = {};
      try {
        if (configRaw) kvConfig = JSON.parse(configRaw);
      } catch {}

      // KV 无配置时查 DO storage
      if (Object.keys(kvConfig).length === 0 && env.ILINK_CONNECTION) {
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
      try {
        body = await request.json();
      } catch (e: any) {
        return json({ error: "INVALID_JSON", message: "无效的 JSON 请求体" }, 400);
      }

      if (typeof body !== "object" || body === null) {
        return json({ error: "VALIDATION_ERROR", message: "请求体必须是 JSON 对象" }, 400);
      }

      // 读取当前配置
      const currentRaw = await env.CLAWBOT_KV.get(KV_CONFIG_KEY);
      let current: Record<string, any> = {};
      try {
        if (currentRaw) current = JSON.parse(currentRaw);
      } catch {}

      // 应用变更（只更新传入的字段）
      const updated: Record<string, any> = { ...current };

      for (const field of CONFIG_FIELDS) {
        if (field in body) {
          const val = body[field];
          if (typeof val === "string") {
            updated[field] = val.trim();
          } else if (typeof val === "number") {
            updated[field] = val;
          }
        }
      }

      // 验证 aiProvider
      if (updated.aiProvider && !["cloudflare", "openai"].includes(updated.aiProvider)) {
        return json({ error: "VALIDATION_ERROR", message: "aiProvider 必须是 cloudflare 或 openai" }, 400);
      }

      // 验证 aiBaseUrl（OpenAI 模式必填）
      if (updated.aiProvider === "openai" && !updated.aiBaseUrl) {
        return json({ error: "VALIDATION_ERROR", message: "使用 OpenAI 兼容 API 时，API 地址为必填" }, 400);
      }

      // 验证 aiApiKey（OpenAI 模式必填）
      if (updated.aiProvider === "openai" && !updated.aiApiKey) {
        return json({ error: "VALIDATION_ERROR", message: "使用 OpenAI 兼容 API 时，API 密钥为必填" }, 400);
      }

      // 验证 max_tokens
      if (updated.aiMaxTokens !== undefined) {
        const n = Number(updated.aiMaxTokens);
        if (isNaN(n) || n < 1 || n > 32000) {
          return json({ error: "VALIDATION_ERROR", message: "max_tokens 必须在 1-32000 之间" }, 400);
        }
        updated.aiMaxTokens = n;
      }

      // 如果前端传的是掩码，不覆盖原密钥
      if (updated.aiApiKey && updated.aiApiKey.includes("***")) {
        updated.aiApiKey = current.aiApiKey || "";
      }

      // 清理空字段
      for (const field of CONFIG_FIELDS) {
        if (updated[field] === "" || updated[field] === undefined) {
          if (field !== "aiProvider" && field !== "aiMaxTokens") {
            delete updated[field];
          }
        }
      }

      // 保存到 KV（失败则保存到 DO storage 备用）
      let savedToKV = false;
      try {
        await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));
        savedToKV = true;
      } catch (e: any) {
        Logger.warn("[config] KV put failed, saving to DO storage", { error: e.message });
      }

      if (!savedToKV && env.ILINK_CONNECTION) {
        try {
          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);
          await doStub.fetch(new Request("http://localhost/save-config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updated),
          }));
          // 尝试删除 KV 旧数据，避免 GET 读到旧配置
          try { await env.CLAWBOT_KV.delete(KV_CONFIG_KEY); } catch {}
        } catch (e: any) {
          Logger.error("[config] DO save also failed", { error: e.message });
          return json({ error: "KV 和 DO 保存均失败: " + e.message }, 500);
        }
      }

      configCache.invalidate(CACHE_KEY);

      Logger.info("[config] updated", { provider: updated.aiProvider, model: updated.aiModel });

      return json({
        ok: true,
        message: "配置已保存",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      Logger.error("[config] update error", { error: msg });
      return json({ error: msg }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "***" + key.slice(-4);
}
