import { describe, it, expect, vi, afterEach } from "vitest";
import { json, html, generateSessionToken, createSessionCookie, clearSessionCookie, verifyAdmin } from "./utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("json", () => {
  it("should serialize data with 2-space indent and correct headers", async () => {
    const resp = json({ ok: true });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    const body = await resp.json() as any;
    expect(body).toEqual({ ok: true });
  });

  it("should respect custom status and extra headers", () => {
    const resp = json({ error: "x" }, 400, { "X-Custom": "yes" });
    expect(resp.status).toBe(400);
    expect(resp.headers.get("X-Custom")).toBe("yes");
  });
});

describe("html", () => {
  it("should return text/html with proper headers", async () => {
    const resp = html("<p>hi</p>");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    expect(await resp.text()).toBe("<p>hi</p>");
  });
});

describe("session functions", () => {
  it("generateSessionToken should produce 32-char hex (no dashes)", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("createSessionCookie should set cookie with max-age 1 day", () => {
    const cookie = createSessionCookie("tok123");
    expect(cookie).toContain("clawbot_session=tok123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=" + 24 * 60 * 60);
  });

  it("clearSessionCookie should expire cookie", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("clawbot_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("verifyAdmin", () => {
  it("should return error when ADMIN_PASSWORD not configured", async () => {
    const env = {} as any;
    const result = await verifyAdmin(new Request("http://localhost/x"), env);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ADMIN_PASSWORD");
  });

  it("should accept valid Basic auth password", async () => {
    const env = { ADMIN_PASSWORD: "secret123" } as any;
    const basic = "Basic " + btoa("admin:secret123");
    const req = new Request("http://localhost/x", { headers: { Authorization: basic } });
    const result = await verifyAdmin(req, env);
    expect(result.ok).toBe(true);
  });

  it("should reject wrong Basic auth password", async () => {
    const env = { ADMIN_PASSWORD: "secret123" } as any;
    const basic = "Basic " + btoa("admin:wrong");
    const req = new Request("http://localhost/x", { headers: { Authorization: basic } });
    const result = await verifyAdmin(req, env);
    expect(result.ok).toBe(false);
  });

  it("should validate session cookie via KV", async () => {
    const env = {
      ADMIN_PASSWORD: "secret123",
      CLAWBOT_KV: { get: vi.fn(async () => "valid") },
    } as any;
    const req = new Request("http://localhost/x", { headers: { Cookie: "clawbot_session=tok123" } });
    const result = await verifyAdmin(req, env);
    expect(result.ok).toBe(true);
    expect(env.CLAWBOT_KV.get).toHaveBeenCalledWith("clawbot:session:tok123");
  });

  it("should validate session via DO when KV misses", async () => {
    const doStub = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ valid: true }))),
    };
    const env = {
      ADMIN_PASSWORD: "secret123",
      CLAWBOT_KV: { get: vi.fn(async () => null) },
      ILINK_CONNECTION: {
        idFromName: () => "id",
        get: () => doStub,
      },
    } as any;
    const req = new Request("http://localhost/x", { headers: { Cookie: "clawbot_session=tok123" } });
    const result = await verifyAdmin(req, env);
    expect(result.ok).toBe(true);
    expect(doStub.fetch).toHaveBeenCalled();
  });

  it("should reject when session invalid everywhere", async () => {
    const env = {
      ADMIN_PASSWORD: "secret123",
      CLAWBOT_KV: { get: vi.fn(async () => null) },
      ILINK_CONNECTION: {
        idFromName: () => "id",
        get: () => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ valid: false }))) }),
      },
    } as any;
    const req = new Request("http://localhost/x", { headers: { Cookie: "clawbot_session=tok123" } });
    const result = await verifyAdmin(req, env);
    expect(result.ok).toBe(false);
  });
});