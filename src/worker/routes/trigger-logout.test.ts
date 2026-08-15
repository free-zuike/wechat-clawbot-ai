import { describe, it, expect, vi, afterEach } from "vitest";
import { handleTriggerPoll } from "./trigger";
import { handleLogout } from "./logout";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTriggerPoll", () => {
  it("should forward DO poll response", async () => {
    const doStub = {
      fetch: vi.fn(async (_req: Request) => new Response(JSON.stringify({ ok: true, handled: 2 }))),
    };
    const env = { ILINK_CONNECTION: { idFromName: () => "main", get: () => doStub } } as any;
    const resp = await handleTriggerPoll(new Request("http://localhost/api/trigger-poll", { method: "POST" }), env);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body).toEqual({ ok: true, handled: 2 });
    // 应请求 DO /poll
    expect((doStub.fetch.mock.calls[0]![0] as Request).url).toContain("/poll");
  });
});

describe("handleLogout", () => {
  function makeEnv(kvDelete = vi.fn()) {
    return {
      ADMIN_PASSWORD: "secret123",
      CLAWBOT_KV: { delete: kvDelete },
    } as any;
  }

  it("should return 401 without auth", async () => {
    const env = makeEnv();
    const resp = await handleLogout(new Request("http://localhost/api/logout", { method: "POST" }), env);
    expect(resp.status).toBe(401);
  });

  it("should clear session kv and set clear cookie", async () => {
    const kvDelete = vi.fn(async () => true);
    const env = makeEnv(kvDelete);
    const basic = "Basic " + btoa("admin:secret123");
    const resp = await handleLogout(
      new Request("http://localhost/api/logout", {
        method: "POST",
        headers: { Authorization: basic, Cookie: "clawbot_session=abcd1234" },
      }),
      env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(kvDelete).toHaveBeenCalledWith("clawbot:session:abcd1234");
    // Set-Cookie 应过期 session
    const setCookie = resp.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain("Max-Age=0");
  });
});