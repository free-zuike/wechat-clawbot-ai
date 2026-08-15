import { describe, it, expect, vi, afterEach } from "vitest";
import { loadAIConfigFromKV } from "./ilink-config";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeKV(storedConfig: any | null) {
  return {
    get: vi.fn(async (key: string) => (key === "clawbot:config" && storedConfig ? JSON.stringify(storedConfig) : null)),
  } as any;
}

// loadAIConfigFromKV 内部动态 import mcp 的 ensureMCPServersTable/loadAllMCPServers，
// mock 这些模块让测试不需要真实 D1
vi.mock("../services/mcp", async () => {
  const actual = await vi.importActual("../services/mcp");
  return {
    ...actual,
    ensureMCPServersTable: vi.fn(async () => {}),
    ensureMCPSessionsTable: vi.fn(async () => {}),
    loadAllMCPServers: vi.fn(async () => []),
  };
});

describe("loadAIConfigFromKV", () => {
  it("should return cloudflare defaults when no config", async () => {
    const env = { AI_SYSTEM_PROMPT: "", AI_MODEL: "@cf/meta/llama-3.2-3b-instruct", DB: {} } as any;
    const cfg = await loadAIConfigFromKV(env, makeKV(null));
    expect(cfg.aiProvider).toBe("cloudflare");
    expect(cfg.aiApiKey).toBe("");
    expect(cfg.aiMaxTokens).toBe(1024);
    expect(cfg.aiMaxContextChars).toBe(12000);
    expect(cfg.aiImageModel).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(cfg.webhook.enabled).toBe(false);
    expect(cfg.allowlist).toBe("");
  });

  it("should use top-level fields for cloudflare config", async () => {
    const env = { AI_SYSTEM_PROMPT: "", DB: {} } as any;
    const kv = makeKV({
      aiProvider: "cloudflare",
      aiModel: "custom-model",
      aiBaseUrl: "",
      aiApiKey: "top-key",
      aiMaxTokens: 2048,
      webhookEnabled: true,
      webhookUrl: "https://hooks.example.com",
      webhookApiKey: "hk",
      webhookChannels: ["wework"],
      newsnowBaseUrl: "https://news.example",
      searchBaseUrl: "https://search.example",
      searchToken: "st",
      allowlist: "user1\nuser2",
    });
    const cfg = await loadAIConfigFromKV(env, kv);
    expect(cfg.aiProvider).toBe("cloudflare");
    expect(cfg.aiModel).toBe("custom-model");
    expect(cfg.aiApiKey).toBe("top-key");
    expect(cfg.aiMaxTokens).toBe(2048);
    expect(cfg.webhook.enabled).toBe(true);
    expect(cfg.webhook.url).toBe("https://hooks.example.com");
    expect(cfg.webhook.channels).toEqual(["wework"]);
    expect(cfg.newsnowBaseUrl).toBe("https://news.example");
    expect(cfg.allowlist).toBe("user1\nuser2");
  });

  it("should use preset when activeProvider is not cloudflare", async () => {
    const env = { AI_SYSTEM_PROMPT: "", DB: {} } as any;
    const kv = makeKV({
      aiProvider: "custom_zhipu",
      aiApiKey: "fallback-key",
      aiPresets: [{
        id: "custom_zhipu",
        model: "glm-4",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        apiKey: "zhipu-key",
        maxTokens: 4096,
        maxContextChars: 16000,
        imageModel: "cogview-3",
        videoModel: "seedance",
        apiKeys: ["backup-2"],
      }],
    });
    const cfg = await loadAIConfigFromKV(env, kv);
    expect(cfg.aiProvider).toBe("custom_zhipu");
    expect(cfg.aiModel).toBe("glm-4");
    expect(cfg.aiBaseUrl).toContain("bigmodel.cn");
    expect(cfg.aiApiKey).toBe("zhipu-key");
    expect(cfg.aiMaxTokens).toBe(4096);
    expect(cfg.aiImageModel).toBe("cogview-3");
    expect(cfg.aiVideoModel).toBe("seedance");
    expect(cfg.allKeys).toEqual(["zhipu-key", "backup-2"]);
  });

  it("should unquote masked preset apiKey with top-level key", async () => {
    const env = { AI_SYSTEM_PROMPT: "", DB: {} } as any;
    const kv = makeKV({
      aiProvider: "custom_x",
      aiApiKey: "real-top-key",
      aiPresets: [{ id: "custom_x", model: "m", apiKey: "***masked***" }],
    });
    const cfg = await loadAIConfigFromKV(env, kv);
    expect(cfg.aiApiKey).toBe("real-top-key");
  });

  it("should read aiSystemPrompt from env when KV empty", async () => {
    const env = { AI_SYSTEM_PROMPT: "自定义系统提示词", DB: {} } as any;
    const cfg = await loadAIConfigFromKV(env, makeKV({}));
    expect(cfg.aiSystemPrompt).toBe("自定义系统提示词");
  });
});