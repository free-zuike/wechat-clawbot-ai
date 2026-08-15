import { describe, it, expect, vi, afterEach } from "vitest";
import {
  initSQLite,
  ensurePendingVideosColumns,
  ensureGenerationLogsColumns,
  loadCredentials,
  saveCredentials,
  clearCredentials,
  loadAllCredentials,
} from "./ilink-db";

afterEach(() => {
  vi.restoreAllMocks();
});

// SqlStorage mock：exec 记录 SQL 字符串，可配置返回
function makeSql(stubs: Record<string, any> = {}) {
  const execCalls: string[] = [];
  const sql = {
    exec: vi.fn((sqlStr: string, ...args: any[]) => {
      execCalls.push(args.length > 0 ? `${sqlStr} :: ${JSON.stringify(args)}` : sqlStr);
      const stub = stubs[sqlStr.trim()];
      if (stub !== undefined) return stub;
      if (sqlStr.startsWith("PRAGMA")) {
        return { toArray: () => [] };
      }
      if (sqlStr.trim().startsWith("SELECT")) {
        return { toArray: () => [] };
      }
      return { toArray: () => [] };
    }),
  };
  return { sql, execCalls };
}

describe("initSQLite", () => {
  it("should create all 5 tables", async () => {
    const { sql, execCalls } = makeSql();
    await initSQLite(sql as any);
    const all = execCalls.join("\n");
    for (const table of ["credentials", "contexts", "processed_messages", "pending_videos", "generation_logs"]) {
      expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});

describe("ensurePendingVideosColumns", () => {
  it("should add missing columns", async () => {
    const existingCols = ["task_id", "prompt", "model", "provider", "base_url", "api_key", "status", "created_at"];
    const addCalls: string[] = [];
    const sql = {
      exec: vi.fn((sqlStr: string) => {
        if (sqlStr.startsWith("PRAGMA")) {
          return { toArray: () => existingCols.map((name) => ({ name })) };
        }
        if (sqlStr.startsWith("ALTER TABLE")) {
          addCalls.push(sqlStr);
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      }),
    };
    await ensurePendingVideosColumns(sql as any);
    // 9 个目标列中 8 个缺失（task_id 等基础列已存在，to_user_id 等缺失）
    expect(addCalls.length).toBe(9);
    expect(addCalls[0]).toContain("to_user_id");
    expect(addCalls.every((s) => s.startsWith("ALTER TABLE pending_videos ADD COLUMN"))).toBe(true);
  });

  it("should not add existing columns", async () => {
    const allCols = ["to_user_id", "context_token", "account_id", "video_id", "source", "error_message", "retry_count", "key_index", "provider_name"];
    const addCalls: string[] = [];
    const sql = {
      exec: vi.fn((sqlStr: string) => {
        if (sqlStr.startsWith("PRAGMA")) {
          return { toArray: () => allCols.map((name) => ({ name })) };
        }
        if (sqlStr.startsWith("ALTER TABLE")) addCalls.push(sqlStr);
        return { toArray: () => [] };
      }),
    };
    await ensurePendingVideosColumns(sql as any);
    expect(addCalls.length).toBe(0);
  });
});

describe("ensureGenerationLogsColumns", () => {
  it("should add key_index and provider_name when missing", async () => {
    const addCalls: string[] = [];
    const sql = {
      exec: vi.fn((sqlStr: string) => {
        if (sqlStr.startsWith("PRAGMA")) {
          return { toArray: () => [{ name: "id" }, { name: "type" }] };
        }
        if (sqlStr.startsWith("ALTER TABLE")) {
          addCalls.push(sqlStr);
          return { toArray: () => [] };
        }
        return { toArray: () => [] };
      }),
    };
    await ensureGenerationLogsColumns(sql as any);
    expect(addCalls.length).toBe(2);
    expect(addCalls[0]).toContain("key_index");
    expect(addCalls[1]).toContain("provider_name");
  });
});

describe("loadCredentials / saveCredentials / clearCredentials / loadAllCredentials", () => {
  it("loadCredentials should return null when no rows", async () => {
    const { sql } = makeSql();
    const result = await loadCredentials(sql as any);
    expect(result).toBeNull();
  });

  it("loadCredentials should parse row", async () => {
    const { sql } = makeSql({});
    sql.exec.mockReturnValue({
      toArray: () => [{ bot_token: "bt", account_id: "acc", base_url: "https://x", user_id: "u", sync_buf: "buf" }],
    });
    const result = await loadCredentials(sql as any);
    expect(result).toEqual({ bot_token: "bt", account_id: "acc", base_url: "https://x", user_id: "u", sync_buf: "buf" });
  });

  it("saveCredentials should run upsert with correct params", async () => {
    const { sql, execCalls } = makeSql();
    await saveCredentials(sql as any, { botToken: "bt", accountId: "acc", baseUrl: "https://x", userId: "u", syncBuf: "buf" });
    expect(execCalls.length).toBe(1);
    const call = execCalls[0]!;
    expect(call).toContain("INSERT INTO credentials");
    expect(call).toContain("ON CONFLICT(id) DO UPDATE");
    expect(call).toContain('"bt"');
    expect(call).toContain('"acc"');
  });

  it("clearCredentials should run delete", async () => {
    const { sql, execCalls } = makeSql();
    await clearCredentials(sql as any);
    expect(execCalls[0]).toContain("DELETE FROM credentials WHERE id = 1");
  });

  it("loadAllCredentials should return empty when no rows", async () => {
    const { sql } = makeSql();
    const result = await loadAllCredentials(sql as any);
    expect(result).toEqual([]);
  });

  it("loadAllCredentials should map all rows", async () => {
    const { sql } = makeSql({});
    sql.exec.mockReturnValue({
      toArray: () => [
        { bot_token: "bt1", account_id: "a1", base_url: "u1", user_id: "u1", sync_buf: "" },
        { bot_token: "bt2", account_id: "a2", base_url: "u2", user_id: "u2", sync_buf: "buf2" },
      ],
    });
    const result = await loadAllCredentials(sql as any);
    expect(result).toHaveLength(2);
    expect(result[1]!.sync_buf).toBe("buf2");
  });
});