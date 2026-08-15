import { describe, it, expect, vi, afterEach } from "vitest";
import { handleCheckLogin } from "./checklogin";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(overrides: any = {}): any {
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => true),
    ...(overrides.kv || {}),
  };
  const doStub = {
    fetch: vi.fn(async () => new Response(JSON.stringify({ valid: false }))),
  };
  return {
    ADMIN_PASSWORD: "secret123",
    CLAWBOT_KV: kv,
    ILINK_CONNECTION: { idFromName: () => "main", get: () => doStub },
    kv,
    doStub,
    ...overrides,
  };
}

describe("handleCheckLogin", () => {
  it("should return loggedIn false without credentials", async () => {
    const env = makeEnv();
    const resp = await handleCheckLogin(new Request("http://localhost/api/check-login"), env);
    const body = await resp.json();
    expect(body.loggedIn).toBe(false);
    expect(body.tokenHealth).toBe("unknown");
    expect(body.hasCredentials).toBe(false);
  });

  it("should log in via valid admin password and issue session cookie", async () => {
    const env = makeEnv();
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login?pwd=secret123"),
      env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
    expect(body.tokenHealth).toBe("valid");
    // 应写入 session KV 并设置 cookie
    expect(env.kv.put).toHaveBeenCalled();
    const setCookie = resp.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain("clawbot_session=");
  });

  it("should log in via Basic auth header", async () => {
    const env = makeEnv();
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login", {
        headers: { Authorization: "Basic " + btoa("admin:secret123") },
      }),
      env
    );
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
  });

  it("should log in via POST body password", async () => {
    const env = makeEnv();
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login", {
        method: "POST",
        body: JSON.stringify({ password: "secret123" }),
        headers: { "Content-Type": "application/json" },
      }),
      env
    );
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
  });

  it("should log in via valid session cookie (KV hit)", async () => {
    const env = makeEnv({ kv: { get: vi.fn(async () => "valid"), put: vi.fn(async () => true) } });
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login", { headers: { Cookie: "clawbot_session=tok1" } }),
      env
    );
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
  });

  it("should log in via DO session check when KV misses", async () => {
    const env = makeEnv();
    env.doStub.fetch.mockResolvedValue(new Response(JSON.stringify({ valid: true })));
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login", { headers: { Cookie: "clawbot_session=tok1" } }),
      env
    );
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
  });

  it("should reject wrong password", async () => {
    const env = makeEnv();
    const resp = await handleCheckLogin(
      new Request("http://localhost/api/check-login?pwd=wrong"),
      env
    );
    const body = await resp.json();
    expect(body.loggedIn).toBe(false);
  });
});