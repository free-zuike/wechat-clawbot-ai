import { describe, it, expect, vi, afterEach } from "vitest";
import { sendWebhook } from "./webhook";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendWebhook", () => {
  const baseData = {
    fromUserId: "user_1",
    content: "你好",
    replyContent: "你好呀",
    timestamp: "2026-08-14T00:00:00.000Z",
  };

  it("should do nothing when disabled", async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await sendWebhook({ enabled: false, url: "https://hooks.example.com" }, baseData);
    expect(fn).not.toHaveBeenCalled();
  });

  it("should do nothing when url empty", async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await sendWebhook({ enabled: true, url: "" }, baseData);
    expect(fn).not.toHaveBeenCalled();
  });

  it("should POST payload with title, content, channels", async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await sendWebhook({ enabled: true, url: "https://hooks.example.com", title: "My Bot" }, baseData);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe("https://hooks.example.com");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.title).toBe("My Bot");
    expect(body.content).toContain("From: user_1");
    expect(body.content).toContain("Content: 你好");
    expect(body.content).toContain("Reply: 你好呀");
    expect(body.channels).toEqual([]);
  });

  it("should include X-API-Key when configured", async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await sendWebhook({ enabled: true, url: "https://hooks.example.com", apiKey: "secret-key" }, baseData);
    const [, init] = fn.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ "X-API-Key": "secret-key" });
  });

  it("should retry on 500 and succeed on later attempt", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockResolvedValueOnce(new Response("fail", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    const promise = sendWebhook({ enabled: true, url: "https://hooks.example.com" }, baseData);
    await vi.runAllTimersAsync();
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should give up after 3 failed attempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => new Response("fail", { status: 500 }));
    vi.stubGlobal("fetch", fn);
    const promise = sendWebhook({ enabled: true, url: "https://hooks.example.com" }, baseData);
    await vi.runAllTimersAsync();
    await promise;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should retry on network error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fn);
    const promise = sendWebhook({ enabled: true, url: "https://hooks.example.com" }, baseData);
    await vi.runAllTimersAsync();
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});