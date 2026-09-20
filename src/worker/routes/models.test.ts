import { describe, it, expect, vi, afterEach } from "vitest";
import { handleAIModels } from "./models";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(overrides: any = {}): any {
  return { ACCOUNT_ID: "", CF_API_TOKEN: "", ...overrides };
}

describe("handleAIModels", () => {
  it("should return 401 when not admin", async () => {
    const env = makeEnv({ ADMIN_PASSWORD: null }) as any;
    const resp = await handleAIModels(new Request("http://localhost/api/ai-models"), env);
    expect(resp.status).toBe(401);
  });

  it("should return static model list without CF credentials", async () => {
    const env = makeEnv({ ADMIN_PASSWORD: "secret" }) as any;
    const basic = "Basic " + btoa("admin:secret");
    const resp = await handleAIModels(
      new Request("http://localhost/api/ai-models", { headers: { Authorization: basic } }),
      env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.source).toBe("static");
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(10);
    // 应有免费和付费模型
    expect(body.models.some((m: any) => m.tier === "free")).toBe(true);
    expect(body.models.some((m: any) => m.provider === "cloudflare")).toBe(true);
  });

  it("should fetch models from CF API when credentials present", async () => {
    const apiModels = [
      { id: "@cf/model-a", name: "Model A", task: { name: "text-generation" }, pricing: { paid: false } },
      { id: "@cf/model-b", name: "Model B", task: { name: "image-generation" }, pricing: { paid: true } },
    ];
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ result: apiModels }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const env = makeEnv({
      ADMIN_PASSWORD: "secret",
      ACCOUNT_ID: "acct123",
      CF_API_TOKEN: "token123",
    }) as any;
    const basic = "Basic " + btoa("admin:secret");
    const resp = await handleAIModels(
      new Request("http://localhost/api/ai-models", { headers: { Authorization: basic } }),
      env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.source).toBe("api");
    expect(body.models).toHaveLength(2);
    expect(body.models[0].id).toBe("@cf/model-a");
    expect(body.models[0].tier).toBe("free");
    expect(body.models[1].tier).toBe("paid");
    // 应调用 CF API
    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).toContain("/ai/models/search");
  });

  it("should fallback to static when CF API fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fail", { status: 500 })));
    const env = makeEnv({
      ADMIN_PASSWORD: "secret",
      ACCOUNT_ID: "acct123",
      CF_API_TOKEN: "token123",
    }) as any;
    const basic = "Basic " + btoa("admin:secret");
    const resp = await handleAIModels(
      new Request("http://localhost/api/ai-models", { headers: { Authorization: basic } }),
      env
    );
    const body = await resp.json() as any;
    expect(body.source).toBe("static");
  });

  it("should return Agnes model list when provider is agnes", async () => {
    const env = makeEnv({ ADMIN_PASSWORD: "secret" }) as any;
    const basic = "Basic " + btoa("admin:secret");
    const resp = await handleAIModels(
      new Request("http://localhost/api/ai-models?provider=agnes-ai&baseUrl=https%3A%2F%2Fapihub.agnes-ai.com%2Fv1", {
        headers: { Authorization: basic },
      }),
      env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.source).toBe("agnes-static");
    expect(body.models.some((m: any) => m.id === "agnes-3.0-flash")).toBe(true);
    expect(body.models.some((m: any) => m.id === "agnes-2.5-pro")).toBe(true);
    expect(body.models.some((m: any) => m.id === "agnes-image-2.5-flash")).toBe(true);
    expect(body.models.some((m: any) => m.id === "agnes-video-2.5-flash")).toBe(true);
  });
});