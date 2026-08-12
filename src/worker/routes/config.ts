// 配置路由
// 数据模型：
//   aiProvider: 当前选中的提供商 ID ("cloudflare" 或 "custom_xxx")
//   aiCustomProviders: 自定义提供商元数据 [{id, name, icon}]
//   aiPresets: 每个提供商的独立配置 [{id, model, baseUrl, apiKey, maxTokens}]
//   aiModel/aiBaseUrl/aiApiKey/aiMaxTokens: 当前提供商配置的回显副本

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { configCache } from "../utils/cache";
import type { Env } from "../index";

const KV_CONFIG_KEY = "clawbot:config";
const CONFIG_FIELDS = ["aiProvider", "aiModel", "aiBaseUrl", "aiApiKey", "aiMaxTokens", "aiSystemPrompt", "webhookUrl", "webhookEnabled", "webhookTitle", "webhookApiKey", "webhookChannels", "aiPresets", "aiCustomProviders", "aiMaxRetries", "aiThinking", "newsnowBaseUrl", "searchBaseUrl", "searchToken"] as const;

// 读取 KV 配置时自动修复所有掩码密钥
// 旧数据中 apiKey 可能被掩码保存（如 sk-r***yu3C），需要还原为真实值
function fixMaskedKeys(kvConfig: Record<string, unknown>): void {
  // 修复顶层 aiApiKey
  if (typeof kvConfig.aiApiKey === "string" && kvConfig.aiApiKey.includes("***")) {
    kvConfig.aiApiKey = "";  // 清空，让前端重新配置
  }
  // 修复预设中的 apiKey
  const presets = kvConfig.aiPresets as any[] | undefined;
  if (Array.isArray(presets)) {
    for (const p of presets) {
      if (typeof p.apiKey === "string" && p.apiKey.includes("***")) {
        p.apiKey = "";
      }
    }
  }
}

type Preset = {
  id: string;
  model?: string;
  imageModel?: string;
  videoModel?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeys?: string[];
  maxTokens?: number;
  maxContextChars?: number;
  responseConfig?: Record<string, any>;
};

function maskKey(key: string): string {
  if (!key) return "";
  return key.length <= 8 ? "***" : key.slice(0, 4) + "***" + key.slice(-4);
}

function unmaskKey(newVal: unknown, oldVal: unknown): string {
  // 如果新值匹配掩码格式，说明是前端回显的掩码值，保留原值
  if (typeof newVal === "string" && isMaskedKey(newVal)) {
    return (oldVal as string) || "";
  }
  return (newVal as string) || "";
}

function isMaskedKey(val: string): boolean {
  if (!val) return false;
  // 检测掩码格式：包含 *** 的字符串就是掩码值
  return val.includes("***");
}

function findPreset(presets: Preset[], id: string): Preset | undefined {
  return presets.find((p) => p.id === id);
}

function getConfigResponse(kvConfig: Record<string, unknown>) {
  const currentProvider = (kvConfig.aiProvider as string) || "cloudflare";
  const rawPresets = (kvConfig.aiPresets as Preset[]) || [];

  // 从预设中获取当前提供商的配置作为顶层回显字段
  let currentModel = (kvConfig.aiModel as string) || "";
  let currentImageModel = (kvConfig.aiImageModel as string) || "";
  let currentVideoModel = (kvConfig.aiVideoModel as string) || "";
  let currentBaseUrl = (kvConfig.aiBaseUrl as string) || "";
  let currentApiKey = (kvConfig.aiApiKey as string) || "";
  let currentMaxTokens = (kvConfig.aiMaxTokens as number) || 1024;

  const activePreset = findPreset(rawPresets, currentProvider);
  if (activePreset) {
    currentModel = activePreset.model || currentModel;
    currentImageModel = activePreset.imageModel || currentImageModel;
    if (activePreset.videoModel !== undefined) currentVideoModel = activePreset.videoModel;
    currentBaseUrl = activePreset.baseUrl || currentBaseUrl;
    currentApiKey = activePreset.apiKey || currentApiKey;
    currentMaxTokens = activePreset.maxTokens || currentMaxTokens;
  }

  // 掩码化预设中的 API key
  const maskedPresets: Preset[] = rawPresets.map((p) => ({
    id: p.id,
    model: p.model || "",
    imageModel: p.imageModel || "",
    videoModel: p.videoModel || "",
    baseUrl: p.baseUrl || "",
    apiKey: p.apiKey ? maskKey(p.apiKey) : "",
    apiKeys: (p.apiKeys || []).map(k => maskKey(k)),
    maxTokens: p.maxTokens || 1024,
    maxContextChars: p.maxContextChars || 12000,
    responseConfig: p.responseConfig || undefined,
  }));

  return {
    version: (kvConfig._version as number) || 0,
    aiProvider: currentProvider,
    aiModel: currentModel,
    aiImageModel: currentImageModel,
    aiVideoModel: currentVideoModel,
    aiBaseUrl: currentBaseUrl,
    aiApiKey: maskKey(currentApiKey),
    aiMaxTokens: currentMaxTokens,
    aiSystemPrompt: (kvConfig.aiSystemPrompt as string) || "",
    webhookUrl: (kvConfig.webhookUrl as string) || "",
    webhookEnabled: (kvConfig.webhookEnabled as boolean) || false,
    webhookTitle: (kvConfig.webhookTitle as string) || "",
    webhookApiKey: typeof kvConfig.webhookApiKey === "string" && kvConfig.webhookApiKey ? maskKey(kvConfig.webhookApiKey as string) : "",
    webhookChannels: (kvConfig.webhookChannels as string[]) || [],
    aiPresets: maskedPresets,
    aiCustomProviders: (kvConfig.aiCustomProviders as any[]) || [],
    aiMaxRetries: (kvConfig.aiMaxRetries as number) ?? 2,
    aiThinking: (kvConfig.aiThinking as boolean) || false,
    newsnowBaseUrl: (kvConfig.newsnowBaseUrl as string) || "",
    searchBaseUrl: (kvConfig.searchBaseUrl as string) || "",
    searchToken: (kvConfig.searchToken as string) || "",
  };
}

// 从配置中解析出实际的 AI 调用配置（供 chat / trigger 使用）
// 自动修复旧数据中预设 apiKey 被掩码的问题
export function resolveAIConfig(kvConfig: Record<string, unknown>) {
  const provider = (kvConfig.aiProvider as string) || "cloudflare";
  const topApiKey = (kvConfig.aiApiKey as string) || "";
  const maxRetries = (kvConfig.aiMaxRetries as number) || 2;
  const presets = (kvConfig.aiPresets as Preset[]) || [];
  const active = findPreset(presets, provider);

  if (active && provider !== "cloudflare") {
    let apiKey = active.apiKey || "";
    if (isMaskedKey(apiKey)) {
      apiKey = topApiKey;
    }
    let baseUrl = active.baseUrl || "";
    if (!baseUrl) {
      baseUrl = (kvConfig.aiBaseUrl as string) || "";
    }
    const backupKeys = (active.apiKeys || []).filter(k => k && !isMaskedKey(k));
    return {
      provider,
      model: active.model || "",
      baseUrl,
      apiKey,
      allKeys: [apiKey, ...backupKeys].filter(Boolean),
      maxTokens: active.maxTokens || 1024,
      maxContextChars: active.maxContextChars || 12000,
      maxRetries,
      thinking: active.thinking || false,
      responseConfig: active.responseConfig || {},
    };
  }

  return {
    provider,
    model: (kvConfig.aiModel as string) || "",
    baseUrl: (kvConfig.aiBaseUrl as string) || "",
    apiKey: (kvConfig.aiApiKey as string) || "",
    allKeys: [(kvConfig.aiApiKey as string) || ""].filter(Boolean),
    maxTokens: (kvConfig.aiMaxTokens as number) || 1024,
    maxRetries,
    thinking: (kvConfig.aiThinking as boolean) || false,
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
      fixMaskedKeys(kvConfig);
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
      fixMaskedKeys(current);

      // 版本号乐观锁：防止并发修改覆盖
      const currentVersion = (current._version as number) || 0;
      const clientVersion = (body._version as number) ?? undefined;
      if (clientVersion !== undefined && clientVersion !== currentVersion) {
        return json({ error: "CONFLICT", message: "配置已被其他人修改，请刷新后重试", currentVersion }, 409);
      }

      const updated: Record<string, unknown> = { ...current };
      updated._version = currentVersion + 1;

      // 处理简单字段
      for (const field of CONFIG_FIELDS) {
        if (field in body) {
          const val = body[field];
          if (typeof val === "string") updated[field] = val.trim();
          else if (typeof val === "number") updated[field] = val;
          else if (typeof val === "boolean") updated[field] = val;
          else if (Array.isArray(val)) updated[field] = val;
        }
      }

      // 验证 aiProvider
      const provider = (updated.aiProvider as string) || "cloudflare";
      if (provider !== "cloudflare" && !provider.startsWith("custom_")) {
        return json({ error: "VALIDATION_ERROR", message: "aiProvider 必须是 cloudflare 或 custom_* 格式" }, 400);
      }

      // 处理 aiPresets - 需要对掩码的 apiKey 解密
      const bodyPresets = body.aiPresets as Preset[] | undefined;
      if (Array.isArray(bodyPresets)) {
        const currentPresets = (current.aiPresets as Preset[]) || [];
        const savedPresets: Preset[] = bodyPresets.map((bp) => {
          const oldPreset = findPreset(currentPresets, bp.id);
          return {
            id: bp.id,
            model: (bp.model as string) || "",
            imageModel: (bp.imageModel as string) || "",
            videoModel: (bp.videoModel as string) || "",
            baseUrl: (bp.baseUrl as string) || "",
            apiKey: unmaskKey(bp.apiKey, oldPreset?.apiKey),
            apiKeys: Array.isArray(bp.apiKeys) ? bp.apiKeys.map((k: string, i: number) => unmaskKey(k, oldPreset?.apiKeys?.[i])) : (oldPreset?.apiKeys || []),
            maxTokens: Number(bp.maxTokens) || 1024,
          };
        });
        updated.aiPresets = savedPresets;

        // 对于非 cloudflare 提供商，需要验证其预设的必填字段
        if (provider !== "cloudflare") {
          const activePreset = findPreset(savedPresets, provider);
          if (activePreset) {
            if (!activePreset.baseUrl) {
              return json({ error: "VALIDATION_ERROR", message: "使用自定义提供商时，API 地址为必填" }, 400);
            }
            if (!activePreset.apiKey) {
              return json({ error: "VALIDATION_ERROR", message: "使用自定义提供商时，API 密钥为必填" }, 400);
            }
          }
        }
      }
      // 处理顶层 aiApiKey 掩码
      if (typeof updated.aiApiKey === "string" && isMaskedKey(updated.aiApiKey)) {
        updated.aiApiKey = current.aiApiKey || "";
      }
      if (typeof updated.webhookApiKey === "string" && isMaskedKey(updated.webhookApiKey)) {
        updated.webhookApiKey = current.webhookApiKey || "";
      }

      // maxTokens 验证
      if (updated.aiMaxTokens !== undefined) {
        const n = Number(updated.aiMaxTokens);
        if (isNaN(n) || n < 1 || n > 32000) return json({ error: "VALIDATION_ERROR", message: "max_tokens 必须在 1-32000 之间" }, 400);
        updated.aiMaxTokens = n;
      }

      // 清理 undefined 字段
      for (const field of CONFIG_FIELDS) {
        if (updated[field] === undefined && field !== "aiProvider" && field !== "aiMaxTokens") {
          delete updated[field];
        }
      }

      await env.CLAWBOT_KV.put(KV_CONFIG_KEY, JSON.stringify(updated));
      configCache.invalidate("config");

      Logger.info("[config] updated", { provider, customProviders: (updated.aiCustomProviders as any[])?.length || 0 });
      return json({ ok: true, message: "配置已保存" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Logger.error("[config] update error", { error: msg });
      return json({ error: msg }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
