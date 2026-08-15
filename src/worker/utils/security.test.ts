import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RateLimiter,
  createRateLimiter,
  getClientIdentifier,
  addAdminIP,
  removeAdminIP,
  isAdminIP,
  isPublicPath,
} from "./security";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getClientIdentifier", () => {
  function makeRequest(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/test", { headers });
  }

  it("should use CF-Connecting-IP when present", () => {
    const req = makeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(getClientIdentifier(req)).toBe("203.0.113.9");
  });

  it("should use X-Forwarded-For first IP", () => {
    const req = makeRequest({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" });
    expect(getClientIdentifier(req)).toBe("203.0.113.9");
  });

  it("should use X-Real-IP when others missing", () => {
    const req = makeRequest({ "X-Real-IP": "198.51.100.7" });
    expect(getClientIdentifier(req)).toBe("198.51.100.7");
  });

  it("should return unknown when no IP headers", () => {
    const req = makeRequest({});
    expect(getClientIdentifier(req)).toBe("unknown");
  });

  it("should sanitize special characters and cap at 50 chars", () => {
    const req = makeRequest({ "CF-Connecting-IP": "a!b@c#d".repeat(20) });
    const result = getClientIdentifier(req);
    expect(result).not.toMatch(/[^a-zA-Z0-9.:_-]/);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("RateLimiter", () => {
  it("should allow first request and count down remaining", () => {
    const limiter = new RateLimiter("test", { windowMs: 60000, maxRequests: 3, enabled: true });
    const r1 = limiter.check({} as any, "ip1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    const r2 = limiter.check({} as any, "ip1");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    const r3 = limiter.check({} as any, "ip1");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("should block when limit reached", () => {
    const limiter = new RateLimiter("test", { windowMs: 60000, maxRequests: 2, enabled: true });
    limiter.check({} as any, "ip1");
    limiter.check({} as any, "ip1");
    const r3 = limiter.check({} as any, "ip1");
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("should track identifiers independently", () => {
    const limiter = new RateLimiter("test", { windowMs: 60000, maxRequests: 1, enabled: true });
    expect(limiter.check({} as any, "ipA").allowed).toBe(true);
    // ipB 有自己的配额
    expect(limiter.check({} as any, "ipB").allowed).toBe(true);
  });

  it("should reset window for identifier", () => {
    const limiter = new RateLimiter("test", { windowMs: 60000, maxRequests: 1, enabled: true });
    limiter.check({} as any, "ip1");
    expect(limiter.check({} as any, "ip1").allowed).toBe(false);
    limiter.reset({} as any, "ip1");
    expect(limiter.check({} as any, "ip1").allowed).toBe(true);
  });

  it("should always allow when disabled", () => {
    const limiter = new RateLimiter("test", { windowMs: 60000, maxRequests: 2, enabled: false });
    for (let i = 0; i < 5; i++) {
      expect(limiter.check({} as any, "ip1").allowed).toBe(true);
    }
  });

  it("createRateLimiter should build from defaults", () => {
    const limiter = createRateLimiter("myapp", "global");
    const r = limiter.check({} as any, "id");
    expect(typeof r.allowed).toBe("boolean");
    expect(r.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe("rateLimiters singleton", () => {
  it("should have all five limiters", async () => {
    const { rateLimiters } = await import("./security");
    expect(Object.keys(rateLimiters)).toEqual(["global", "ip", "login", "qrcode", "send"]);
  });
});

describe("IP whitelist", () => {
  it("isAdminIP should start empty", () => {
    expect(isAdminIP("1.2.3.4")).toBe(false);
  });

  it("addAdminIP then isAdminIP returns true", () => {
    addAdminIP("1.2.3.4");
    expect(isAdminIP("1.2.3.4")).toBe(true);
    removeAdminIP("1.2.3.4");
    expect(isAdminIP("1.2.3.4")).toBe(false);
  });

  it("isPublicPath should recognize public paths", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/qrcode")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/admin")).toBe(false);
  });
});