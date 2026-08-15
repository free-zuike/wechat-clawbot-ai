import { describe, it, expect, vi, afterEach } from "vitest";
import { handleChatMessages } from "./chat-messages";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeD1(initial: any[] = []) {
  const rows = [...initial];
  const db = {
    exec: vi.fn(async () => {}),
    prepare: vi.fn((sql: string) => {
      const matchDelete = /DELETE/i.test(sql);
      const matchInsert = /INSERT/i.test(sql);
      const matchSelect = /SELECT/i.test(sql);
      return {
        bind: (...args: any[]) => ({
          all: async () => {
            if (matchSelect) return { results: rows.map((r, i) => ({ role: r.role, text: r.text, created_at: i })) };
            return { results: [] };
          },
          run: async () => {
            if (matchDelete) rows.length = 0;
            if (matchInsert) rows.push({ role: args[0], text: args[1] });
            return { success: true };
          },
        }),
      };
    }),
  };
  return { db, rows };
}

function makeEnv(rows: any[] = []) {
  const { db, rows: store } = makeD1(rows);
  return {
    env: {
      ADMIN_PASSWORD: "secret123",
      DB: db,
    } as any,
    db,
    store,
  };
}

const AUTH = { Authorization: "Basic " + btoa("admin:secret123") };

describe("handleChatMessages", () => {
  it("should return 401 without auth", async () => {
    const { env } = makeEnv();
    const resp = await handleChatMessages(new Request("http://localhost/api/chat-messages"), env);
    expect(resp.status).toBe(401);
  });

  it("should return empty messages on GET", async () => {
    const { env } = makeEnv();
    const resp = await handleChatMessages(
      new Request("http://localhost/api/chat-messages", { headers: AUTH }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.messages).toEqual([]);
  });

  it("should store messages on POST", async () => {
    const { env, db } = makeEnv();
    const resp = await handleChatMessages(
      new Request("http://localhost/api/chat-messages", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", text: "你好" }, { role: "assistant", text: "你好呀" }] }),
      }), env
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.ok).toBe(true);
    expect(body.count).toBe(2);
    // 应执行 DELETE（exec）+ 2 次 INSERT（prepare）
    const execs = db.exec.mock.calls.map(([s]: any) => String(s));
    expect(execs.some((s: string) => s.startsWith("DELETE"))).toBe(true);
    const sqls = db.prepare.mock.calls.map(([s]: any) => String(s));
    expect(sqls.filter((s: string) => s.startsWith("INSERT")).length).toBe(2);
  });

  it("should reject invalid messages format", async () => {
    const { env } = makeEnv();
    const resp = await handleChatMessages(
      new Request("http://localhost/api/chat-messages", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: "not array" }),
      }), env
    );
    expect(resp.status).toBe(400);
  });

  it("should trim to MAX_MESSAGES (100)", async () => {
    const { env, db } = makeEnv();
    const many = Array.from({ length: 150 }, (_, i) => ({ role: "user" as const, text: `msg${i}` }));
    const resp = await handleChatMessages(
      new Request("http://localhost/api/chat-messages", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: many }),
      }), env
    );
    const body = await resp.json() as any;
    expect(body.count).toBe(100);
    const inserts = db.prepare.mock.calls.filter(([s]: any) => String(s).startsWith("INSERT"));
    expect(inserts.length).toBe(100);
  });

  it("should return 405 for unsupported method", async () => {
    const { env } = makeEnv();
    const resp = await handleChatMessages(
      new Request("http://localhost/api/chat-messages", { method: "PUT", headers: AUTH }), env
    );
    expect(resp.status).toBe(405);
  });
});