import { describe, it, expect, vi, afterEach } from "vitest";
import { handleStatus } from "./status";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(doStatus: any, doFail = false): any {
  const doStub = {
    fetch: vi.fn(async () => {
      if (doFail) throw new Error("DO unavailable");
      return new Response(JSON.stringify(doStatus));
    }),
  };
  return {
    ILINK_CONNECTION: { idFromName: () => "main", get: () => doStub },
  };
}

describe("handleStatus", () => {
  it("should report loggedIn false when DO returns empty", async () => {
    const env = makeEnv({});
    const resp = await handleStatus(new Request("http://localhost/api/status"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.loggedIn).toBe(false);
    expect(body.doRunning).toBe(false);
    expect(body.consecutiveErrors).toBe(0);
    expect(body.stats.polls).toBe(0);
  });

  it("should report login state from DO hasCredentials", async () => {
    const env = makeEnv({ hasCredentials: true, stats: { polls: 12, handled: 5 } });
    const resp = await handleStatus(new Request("http://localhost/api/status"), env);
    const body = await resp.json();
    expect(body.loggedIn).toBe(true);
    expect(body.hasBotCredentials).toBe(true);
    expect(body.stats.polls).toBe(12);
    expect(body.stats.handled).toBe(5);
  });

  it("should include accounts info", async () => {
    const env = makeEnv({ accounts: [{ id: "acc1" }], totalAccounts: 1, consecutiveErrors: 3 });
    const resp = await handleStatus(new Request("http://localhost/api/status"), env);
    const body = await resp.json();
    expect(body.accounts).toHaveLength(1);
    expect(body.totalAccounts).toBe(1);
    expect(body.consecutiveErrors).toBe(3);
  });

  it("should handle DO failure gracefully", async () => {
    const env = makeEnv(null, true);
    const resp = await handleStatus(new Request("http://localhost/api/status"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.loggedIn).toBe(false);
    expect(body.doRunning).toBe(false);
  });

  it("should include timestamp", async () => {
    const env = makeEnv({});
    const resp = await handleStatus(new Request("http://localhost/api/status"), env);
    const body = await resp.json();
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
  });
});