import { describe, it, expect, vi, afterEach } from "vitest";
import { handleDOPoll, handleDOSend, handleDOStatus, handleDOFlush, handleDOPendingVideos, handleDOGenerationLogs } from "./do";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(doResponseBody: any, status = 200, fail = false): { env: any; doStub: any } {
  const doStub = {
    fetch: vi.fn(async () => {
      if (fail) throw new Error("DO error");
      return new Response(JSON.stringify(doResponseBody), { status });
    }),
  };
  const env = {
    ADMIN_PASSWORD: "secret123",
    ILINK_CONNECTION: { idFromName: () => "main", get: () => doStub },
  } as any;
  return { env, doStub };
}

const AUTH = { Authorization: "Basic " + btoa("admin:secret123") };

describe("DO proxy handlers", () => {
  it("should return 401 without auth for poll", async () => {
    const { env } = makeEnv({});
    const resp = await handleDOPoll(new Request("http://localhost/api/do/poll"), env);
    expect(resp.status).toBe(401);
  });

  it("handleDOPoll should forward to DO /poll", async () => {
    const { env, doStub } = makeEnv({ ok: true, handled: 3 });
    const resp = await handleDOPoll(new Request("http://localhost/api/do/poll", { headers: AUTH }), env);
    expect(resp.status).toBe(200);
    expect(await resp.json() as any).toEqual({ ok: true, handled: 3 });
    expect((doStub.fetch.mock.calls[0]![0] as Request).url).toContain("/poll");
  });

  it("handleDOSend should validate required params", async () => {
    const { env } = makeEnv({});
    const resp = await handleDOSend(
      new Request("http://localhost/api/do/send", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "no-user-id" }),
      }), env
    );
    expect(resp.status).toBe(400);
  });

  it("handleDOSend should forward text to DO /send", async () => {
    const { env, doStub } = makeEnv({ ok: true });
    const resp = await handleDOSend(
      new Request("http://localhost/api/do/send", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ toUserId: "u1", contextToken: "t1", text: "hello" }),
      }), env
    );
    expect(resp.status).toBe(200);
    expect((doStub.fetch.mock.calls[0]![0] as Request).url).toContain("/send");
  });

  it("handleDOStatus should return DO status", async () => {
    const { env } = makeEnv({ isRunning: true });
    const resp = await handleDOStatus(new Request("http://localhost/api/do/status", { headers: AUTH }), env);
    const body = await resp.json() as any;
    expect(body.isRunning).toBe(true);
  });

  it("handleDOFlush should forward to DO /flush", async () => {
    const { env, doStub } = makeEnv({ ok: true });
    const resp = await handleDOFlush(
      new Request("http://localhost/api/do/flush", { method: "POST", headers: AUTH }), env
    );
    expect(resp.status).toBe(200);
    expect((doStub.fetch.mock.calls[0]![0] as Request).url).toContain("/flush");
  });

  it("handleDOPendingVideos should forward query params", async () => {
    const { env, doStub } = makeEnv({ tasks: [] });
    const resp = await handleDOPendingVideos(
      new Request("http://localhost/api/admin/pending-videos?status=completed", { headers: AUTH }), env
    );
    expect(resp.status).toBe(200);
    const reqUrl = (doStub.fetch.mock.calls[0]![0] as Request).url;
    expect(reqUrl).toContain("/pending-videos");
    expect(reqUrl).toContain("status=completed");
  });

  it("handleDOGenerationLogs should forward method", async () => {
    const { env, doStub } = makeEnv({ logs: [] });
    const resp = await handleDOGenerationLogs(
      new Request("http://localhost/api/admin/generation-logs", { method: "GET", headers: AUTH }), env
    );
    expect(resp.status).toBe(200);
    expect((doStub.fetch.mock.calls[0]![0] as Request).url).toContain("/generation-logs");
  });

  it("should return 500 when DO fails", async () => {
    const { env } = makeEnv({}, 200, true);
    const resp = await handleDOStatus(new Request("http://localhost/api/do/status", { headers: AUTH }), env);
    expect(resp.status).toBe(500);
  });
});