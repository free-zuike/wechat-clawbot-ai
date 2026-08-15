import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryCache } from "./cache";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MemoryCache", () => {
  it("should return null for missing key", () => {
    const cache = new MemoryCache();
    expect(cache.get("missing")).toBeNull();
  });

  it("should set and get values", () => {
    const cache = new MemoryCache();
    cache.set("key", { a: 1 });
    expect(cache.get("key")).toEqual({ a: 1 });
  });

  it("should respect custom ttl", () => {
    const cache = new MemoryCache({ defaultTtlMs: 1000 });
    cache.set("key", "value", 50);
    expect(cache.get("key")).toBe("value");
    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    expect(cache.get("key")).toBeNull();
    vi.useRealTimers();
  });

  it("should expire entries after default ttl", () => {
    const cache = new MemoryCache({ defaultTtlMs: 100 });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(cache.get("key")).toBeNull();
    vi.useRealTimers();
  });

  it("should evict oldest entries when over maxEntries", () => {
    const cache = new MemoryCache({ defaultTtlMs: 10000, maxEntries: 5 });
    for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);
    expect(cache.size()).toBe(5);
    // 添加第 6 个，应清理 20% = 1 个
    cache.set("k5", 5);
    expect(cache.size()).toBe(5);
    // 最早插入的 k0 应被清除
    expect(cache.get("k0")).toBeNull();
  });

  it("getOrLoad should load and cache values", async () => {
    const cache = new MemoryCache();
    const loader = vi.fn(async () => "loaded");
    const v1 = await cache.getOrLoad("key", loader);
    const v2 = await cache.getOrLoad("key", loader);
    expect(v1).toBe("loaded");
    expect(v2).toBe("loaded");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("getOrLoad should not cache null/undefined", async () => {
    const cache = new MemoryCache();
    const loader = vi.fn(async () => null as any);
    await cache.getOrLoad("key", loader);
    await cache.getOrLoad("key", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("getOrLoad should share inflight promise for concurrent calls", async () => {
    const cache = new MemoryCache();
    let resolveFn: (v: string) => void;
    const loader = vi.fn(() => new Promise<string>((resolve) => { resolveFn = resolve; }));
    const p1 = cache.getOrLoad("key", loader);
    const p2 = cache.getOrLoad("key", loader);
    resolveFn!("done");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("done");
    expect(r2).toBe("done");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("getOrLoad should propagate loader errors and not cache", async () => {
    const cache = new MemoryCache();
    const loader = vi.fn(async () => { throw new Error("load failed"); });
    await expect(cache.getOrLoad("key", loader)).rejects.toThrow("load failed");
    // 错误后 inflight 已清理，可再次调用
    const loader2 = vi.fn(async () => "ok");
    expect(await cache.getOrLoad("key", loader2)).toBe("ok");
  });

  it("invalidate should remove specific key", () => {
    const cache = new MemoryCache();
    cache.set("a", 1);
    cache.set("b", 2);
    cache.invalidate("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe(2);
  });

  it("invalidatePrefix should remove keys with prefix", () => {
    const cache = new MemoryCache();
    cache.set("user:1", 1);
    cache.set("user:2", 2);
    cache.set("config", 3);
    cache.invalidatePrefix("user:");
    expect(cache.get("user:1")).toBeNull();
    expect(cache.get("user:2")).toBeNull();
    expect(cache.get("config")).toBe(3);
  });

  it("clear should empty cache", () => {
    const cache = new MemoryCache();
    cache.set("a", 1);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});