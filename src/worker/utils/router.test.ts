import { describe, it, expect, vi, afterEach } from "vitest";
import { Router } from "./router";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Router", () => {
  it("should return 404 for unknown /api path", async () => {
    const r = new Router();
    const resp = await r.route(new Request("http://localhost/api/unknown"), {});
    expect(resp.status).toBe(404);
  });

  it("should return 404 for non-api unknown path without ASSETS", async () => {
    const r = new Router();
    const resp = await r.route(new Request("http://localhost/random"), {});
    expect(resp.status).toBe(404);
  });

  it("should handle /healthz", async () => {
    const r = new Router();
    // runHealthChecks 内部可能调用环境，mock 一个合理的 env 使检查通过
    const env = {
      CLAWBOT_KV: { get: vi.fn().mockResolvedValue(null) },
      DB: { prepare: () => ({ bind: () => ({ first: vi.fn().mockResolvedValue(null) }) }) },
    } as any;
    const resp = await r.route(new Request("http://localhost/healthz"), env);
    expect([200, 503]).toContain(resp.status);
  });

  it("should proxy /api/image/:id to DO", async () => {
    const r = new Router();
    const doStub = {
      fetch: vi.fn(async () => new Response("image-bytes", { status: 200 })),
    };
    const env = {
      ILINK_CONNECTION: {
        idFromName: () => "main",
        get: () => doStub,
      },
    } as any;
    const resp = await r.route(new Request("http://localhost/api/image/img123"), env);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("image-bytes");
    expect(doStub.fetch).toHaveBeenCalled();
  });

  it("should return 500 when DO image proxy fails", async () => {
    const r = new Router();
    const env = {
      ILINK_CONNECTION: {
        idFromName: () => "main",
        get: () => ({ fetch: vi.fn(async () => { throw new Error("DO down"); }) }),
      },
    } as any;
    const resp = await r.route(new Request("http://localhost/api/image/img123"), env);
    expect(resp.status).toBe(500);
  });

  it("should serve ASSETS and fallback to index.html on 404", async () => {
    const r = new Router();
    const indexResp = new Response("<html>index</html>", { status: 200 });
    const assetFetch = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(indexResp);
    const env = { ASSETS: { fetch: assetFetch } } as any;
    const resp = await r.route(new Request("http://localhost/some/page"), env);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("<html>index</html>");
    expect(assetFetch).toHaveBeenCalledTimes(2);
  });

  it("should route method-specific endpoints correctly (wrong method → 404)", async () => {
    const r = new Router();
    // /api/qrcode 只允许 GET，POST 应 404
    const resp = await r.route(new Request("http://localhost/api/qrcode", { method: "POST" }), {});
    expect(resp.status).toBe(404);
  });
});