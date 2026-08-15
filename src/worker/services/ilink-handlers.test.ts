import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleCheckSession,
  handleSaveSession,
  handleStoreImage,
  handleGetImage,
  handleFlush,
  handleGetCreds,
  handleStatus,
  handleStorePendingVideo,
  handlePendingVideos,
} from "./ilink-handlers";
import type { DOContext } from "./ilink-handlers";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx(overrides: Partial<DOContext> = {}) {
  const storage = new Map<string, string>();
  const ctx: any = {
    env: { DB: null },
    doState: {
      storage: {
        put: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
        get: vi.fn(async (k: string) => storage.get(k) ?? null),
        delete: vi.fn(async (k: string) => { storage.delete(k); }),
      },
    },
    websockets: new Set(),
    accounts: new Map(),
    ilinkCreds: null,
    state: { syncBuf: "", lastPollAt: "", consecutiveErrors: 0, isRunning: false, pendingMessages: [] },
    cache: { credentials: null, credentialsLoadedAt: 0, config: null, configLoadedAt: 0 },
    runtimeStats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastLatencyMs: 0 },
    kv: null,
    sqliteInitialized: false,
    broadcastToWebSockets: vi.fn(),
    logGeneration: vi.fn(),
    getConfigCached: vi.fn(async () => ({})),
    initSQLite: vi.fn(async () => {}),
    saveAccounts: vi.fn(async () => {}),
    triggerImmediatePoll: vi.fn(),
    detectImageMime: (data: Uint8Array) => (data[0] === 0xFF ? "image/jpeg" : "image/png"),
    ...overrides,
  };
  return { ctx, storage };
}

// D1 mock：记录 rows，支持 SELECT/INSERT/UPDATE/DELETE
// 注意：无过滤器时 handlePendingVideos 直接调 stmt.all()（不经 bind），
// 所以 prepare 返回的对象必须同时暴露 all/run 和 bind
function makeD1() {
  const rows: any[] = [];
  function buildExecutable(sql: string, boundArgs: any[] | null) {
    const isUpdate = /UPDATE/i.test(sql);
    const isInsert = /INSERT/i.test(sql);
    const isSelect = /SELECT/i.test(sql);
    const args = boundArgs || [];
    return {
      bind: (...newArgs: any[]) => buildExecutable(String(sql), newArgs),
      all: async () => (isSelect ? { results: rows } : { results: [] }),
      run: async () => {
        if (isInsert) rows.push({ task_id: args[0], status: "queued" });
        if (isUpdate) {
          const row = rows.find((r) => r.task_id === args[2]);
          if (row) {
            row.status = args[0];
            if (args[1] !== undefined) row.video_url = args[1];
          }
        }
        return { success: true };
      },
    };
  }
  const db = {
    exec: vi.fn(async () => {}),
    prepare: vi.fn((sql: string) => buildExecutable(String(sql), null)),
  };
  return { db, rows };
}

describe("handleSaveSession / handleCheckSession", () => {
  it("should save session with token", async () => {
    const { ctx, storage } = makeCtx();
    const resp = await handleSaveSession(ctx, new Request("http://localhost/save-session", {
      method: "POST", body: JSON.stringify({ token: "tok1" }),
    }));
    expect(resp.status).toBe(200);
    expect(storage.has("session:tok1")).toBe(true);
  });

  it("should reject missing token", async () => {
    const { ctx } = makeCtx();
    const resp = await handleSaveSession(ctx, new Request("http://localhost/save-session", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(resp.status).toBe(400);
  });

  it("should validate valid session", async () => {
    const { ctx } = makeCtx();
    await ctx.doState.storage.put("session:tok2", JSON.stringify({ valid: true, createdAt: Date.now() }));
    const resp = await handleCheckSession(ctx, new URL("http://localhost/check-session?token=tok2"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.valid).toBe(true);
  });

  it("should reject missing token", async () => {
    const { ctx } = makeCtx();
    const resp = await handleCheckSession(ctx, new URL("http://localhost/check-session"));
    const body = await resp.json() as any;
    expect(body.valid).toBe(false);
  });

  it("should reject expired session and delete it", async () => {
    const { ctx } = makeCtx();
    await ctx.doState.storage.put("session:old", JSON.stringify({ valid: true, createdAt: Date.now() - 48 * 60 * 60 * 1000 }));
    const resp = await handleCheckSession(ctx, new URL("http://localhost/check-session?token=old"));
    const body = await resp.json() as any;
    expect(body.valid).toBe(false);
    expect(await ctx.doState.storage.get("session:old")).toBeNull();
  });
});

describe("handleStoreImage / handleGetImage", () => {
  it("should store image by id", async () => {
    const { ctx, storage } = makeCtx();
    const resp = await handleStoreImage(ctx, new Request("http://localhost/store-image", {
      method: "POST", body: JSON.stringify({ id: "img1", data: "dGVzdA==" }),
    }));
    expect(resp.status).toBe(200);
    expect(storage.get("image:img1")).toBe("dGVzdA==");
  });

  it("should reject missing id or data", async () => {
    const { ctx } = makeCtx();
    const resp = await handleStoreImage(ctx, new Request("http://localhost/store-image", {
      method: "POST", body: JSON.stringify({}),
    }));
    expect(resp.status).toBe(400);
  });

  it("should reject missing image id", async () => {
    const { ctx } = makeCtx();
    const resp = await handleGetImage(ctx, new URL("http://localhost/get-image/"));
    expect(resp.status).toBe(400);
  });

  it("should return 404 for missing image", async () => {
    const { ctx } = makeCtx();
    const resp = await handleGetImage(ctx, new URL("http://localhost/get-image/nope"));
    expect(resp.status).toBe(404);
  });

  it("should return image bytes with detected mime", async () => {
    const { ctx } = makeCtx();
    await ctx.doState.storage.put("image:jpeg1", btoa("\xFF\xD8\xFF\xE0test"));
    const resp = await handleGetImage(ctx, new URL("http://localhost/get-image/jpeg1"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/jpeg");
    expect(resp.headers.get("Cache-Control")).toContain("max-age");
  });
});

describe("handleFlush", () => {
  it("should clear pending messages and sync buf", async () => {
    const { ctx } = makeCtx();
    ctx.state.pendingMessages = [{ a: 1 }];
    ctx.state.syncBuf = "abc";
    const resp = await handleFlush(ctx);
    expect(resp.status).toBe(200);
    expect(ctx.state.pendingMessages).toEqual([]);
    expect(ctx.state.syncBuf).toBe("");
  });
});

describe("handleGetCreds", () => {
  it("should return error when no creds", async () => {
    const { ctx } = makeCtx();
    const resp = await handleGetCreds(ctx);
    const body = await resp.json() as any;
    expect(body.error).toBe("未登录");
  });

  it("should return creds from storage", async () => {
    const { ctx } = makeCtx();
    await ctx.doState.storage.put("credentials", JSON.stringify({ botToken: "bt" }));
    const resp = await handleGetCreds(ctx);
    const body = await resp.json() as any;
    expect(body.creds).toContain("botToken");
  });

  it("should fall back to ilinkCreds", async () => {
    const { ctx } = makeCtx();
    ctx.ilinkCreds = { botToken: "x", accountId: "a", baseUrl: "https://x", userId: "u" } as any;
    const resp = await handleGetCreds(ctx);
    const body = await resp.json() as any;
    expect(body.creds).toContain("x");
  });
});

describe("handleStatus", () => {
  it("should report no credentials initially", async () => {
    const { ctx } = makeCtx();
    const resp = await handleStatus(ctx);
    const body = await resp.json() as any;
    expect(body.hasCredentials).toBe(false);
    expect(body.needsReLogin).toBe(true);
    expect(body.accounts).toEqual([]);
  });

  it("should report account info when logged in", async () => {
    const { ctx } = makeCtx();
    ctx.accounts.set("acc1", {
      creds: { botToken: "bt", accountId: "acc1", baseUrl: "https://x", userId: "u1" },
      syncBuf: "", consecutiveErrors: 0, lastPollAt: "time", pollLoopRunning: true,
    });
    const resp = await handleStatus(ctx);
    const body = await resp.json() as any;
    expect(body.hasCredentials).toBe(true);
    expect(body.isRunning).toBe(true);
    expect(body.totalAccounts).toBe(1);
    expect(body.accounts[0].accountId).toBe("acc1");
  });

  it("should add legacy storage creds as account", async () => {
    const { ctx } = makeCtx();
    await ctx.doState.storage.put("credentials", JSON.stringify({ botToken: "bt", accountId: "old1", baseUrl: "https://y", userId: "u2" }));
    const resp = await handleStatus(ctx);
    const body = await resp.json() as any;
    expect(body.accounts.length).toBe(1);
    expect(body.accounts[0].accountId).toBe("old1");
  });
});

describe("handleStorePendingVideo / handlePendingVideos", () => {
  it("should insert pending video when new", async () => {
    const { ctx } = makeCtx();
    const d1mock = makeD1();
    ctx.env = { DB: d1mock.db };
    const resp = await handleStorePendingVideo(ctx, new Request("http://localhost/store-pending-video", {
      method: "POST", body: JSON.stringify({ taskId: "t1", prompt: "p", model: "m", provider: "pr", baseUrl: "b", apiKey: "k", toUserId: "u" }),
    }));
    expect(resp.status).toBe(200);
    const sqls = d1mock.db.prepare.mock.calls.map(([s]: any) => String(s));
    expect(sqls.some((s: string) => s.startsWith("INSERT"))).toBe(true);
  });

  it("should update status when status present", async () => {
    const { ctx } = makeCtx();
    const d1mock = makeD1();
    d1mock.rows.push({ task_id: "t1", status: "queued" });
    ctx.env = { DB: d1mock.db };
    const resp = await handleStorePendingVideo(ctx, new Request("http://localhost/store-pending-video", {
      method: "POST", body: JSON.stringify({ taskId: "t1", status: "completed", videoUrl: "https://v.mp4" }),
    }));
    expect(resp.status).toBe(200);
    const sqls = d1mock.db.prepare.mock.calls.map(([s]: any) => String(s));
    expect(sqls.some((s: string) => s.startsWith("UPDATE"))).toBe(true);
  });

  it("should list pending videos", async () => {
    const { ctx } = makeCtx();
    const d1mock = makeD1();
    d1mock.rows.push({ task_id: "t1", status: "queued", prompt: "p" });
    ctx.env = { DB: d1mock.db };
    const resp = await handlePendingVideos(ctx, new Request("http://localhost/pending-videos"));
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
  });

  it("should return 500 when D1 not configured", async () => {
    const { ctx } = makeCtx();
    const resp = await handlePendingVideos(ctx, new Request("http://localhost/pending-videos"));
    expect(resp.status).toBe(500);
  });
});