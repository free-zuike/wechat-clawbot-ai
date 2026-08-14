import { describe, it, expect } from "vitest";
import {
  buildMessagesWithContext,
  shouldClearContext,
  MAX_CONTEXT_MESSAGES,
  getContextFromSQLite,
  saveContextToSQLite,
  clearContextSQLite,
  getContextFromD1,
  saveContextToD1,
  clearContextD1,
} from "./context";

describe("MAX_CONTEXT_MESSAGES", () => {
  it("should be 40 (20 rounds of conversation)", () => {
    expect(MAX_CONTEXT_MESSAGES).toBe(40);
  });
});

describe("shouldClearContext", () => {
  it("should return true for '重置'", () => {
    expect(shouldClearContext("重置")).toBe(true);
  });

  it("should return true for '清空'", () => {
    expect(shouldClearContext("清空")).toBe(true);
  });

  it("should return true for 'reset'", () => {
    expect(shouldClearContext("reset")).toBe(true);
  });

  it("should return true for 'clear'", () => {
    expect(shouldClearContext("clear")).toBe(true);
  });

  it("should return true for '/reset' and '/clear'", () => {
    expect(shouldClearContext("/reset")).toBe(true);
    expect(shouldClearContext("/clear")).toBe(true);
  });

  it("should handle leading/trailing whitespace", () => {
    expect(shouldClearContext("  重置  ")).toBe(true);
    expect(shouldClearContext("  clear  ")).toBe(true);
  });

  it("should return false for normal messages", () => {
    expect(shouldClearContext("你好")).toBe(false);
    expect(shouldClearContext("今天天气怎么样")).toBe(false);
    expect(shouldClearContext("重置一下")).toBe(false);
    expect(shouldClearContext("clear_cache")).toBe(false);
  });

  it("should return false for empty and whitespace-only input", () => {
    expect(shouldClearContext("")).toBe(false);
    expect(shouldClearContext("   ")).toBe(false);
  });
});

describe("buildMessagesWithContext", () => {
  const system = "你是爪爪AI助手";

  it("should produce [system, user] when context is empty", () => {
    const result = buildMessagesWithContext(system, "你好", { userId: "u1", messages: [], lastUpdated: 0 });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "system", content: system });
    expect(result[1]).toEqual({ role: "user", content: "你好" });
  });

  it("should include context messages between system and user", () => {
    const context = {
      userId: "u1",
      messages: [
        { role: "user" as const, content: "今天天气", timestamp: 100 },
        { role: "assistant" as const, content: "晴天", timestamp: 101 },
      ],
      lastUpdated: 101,
    };
    const result = buildMessagesWithContext(system, "明天呢", context);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("system");
    expect(result[1]).toEqual({ role: "user", content: "今天天气" });
    expect(result[2]).toEqual({ role: "assistant", content: "晴天" });
    expect(result[3]).toEqual({ role: "user", content: "明天呢" });
  });

  it("should preserve message order (oldest first)", () => {
    const context = {
      userId: "u1",
      messages: [
        { role: "user" as const, content: "你好", timestamp: 1 },
        { role: "assistant" as const, content: "你好呀", timestamp: 2 },
        { role: "user" as const, content: "今天天气", timestamp: 3 },
        { role: "assistant" as const, content: "晴天", timestamp: 4 },
      ],
      lastUpdated: 4,
    };
    const result = buildMessagesWithContext(system, "明天呢", context);
    expect(result).toHaveLength(6);
    expect(result[1].content).toBe("你好");
    expect(result[2].content).toBe("你好呀");
    expect(result[3].content).toBe("今天天气");
    expect(result[4].content).toBe("晴天");
    expect(result[5].content).toBe("明天呢");
  });

  it("should drop oldest messages when total exceeds maxContextChars", () => {
    const context = {
      userId: "u1",
      messages: [
        { role: "user" as const, content: "a".repeat(5000), timestamp: 1 },
        { role: "assistant" as const, content: "b".repeat(5000), timestamp: 2 },
        { role: "user" as const, content: "c".repeat(5000), timestamp: 3 },
        { role: "assistant" as const, content: "d".repeat(5000), timestamp: 4 },
      ],
      lastUpdated: 4,
    };
    // maxContextChars=10000, so only the newest 2 messages fit
    const result = buildMessagesWithContext(system, "明天呢", context, 10000);
    // system + newest 2 messages + user = 4
    expect(result).toHaveLength(4);
    expect(result[1].content).toBe("c".repeat(5000));
    expect(result[2].content).toBe("d".repeat(5000));
    expect(result[3].content).toBe("明天呢");
  });

  it("should handle single message exceeding limit", () => {
    const context = {
      userId: "u1",
      messages: [
        { role: "user" as const, content: "x".repeat(15000), timestamp: 1 },
      ],
      lastUpdated: 1,
    };
    // 15000 > 10000, so the message is dropped
    const result = buildMessagesWithContext(system, "你好", context, 10000);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
  });

  it("should use default maxContextChars when not specified", () => {
    const context = {
      userId: "u1",
      messages: [
        { role: "user" as const, content: "你好", timestamp: 1 },
      ],
      lastUpdated: 1,
    };
    const result = buildMessagesWithContext(system, "回复", context);
    // Should not throw and produce correct structure
    expect(result).toHaveLength(3);
    expect(result[1].content).toBe("你好");
  });
});

describe("getContextFromSQLite / saveContextToSQLite / clearContextSQLite", () => {
  it("should return empty context when no rows exist", async () => {
    const mockSql = {
      exec: () => ({ one: () => null }),
    };
    const result = await getContextFromSQLite(mockSql as any, "user_1");
    expect(result.userId).toBe("user_1");
    expect(result.messages).toEqual([]);
  });

  it("should parse stored context", async () => {
    const stored = JSON.stringify([
      { role: "user", content: "你好", timestamp: 100 },
    ]);
    const mockSql = {
      exec: () => ({ one: () => ({ messages: stored, last_updated: 200 }) }),
    };
    const result = await getContextFromSQLite(mockSql as any, "user_1");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("你好");
  });

  it("should handle corrupt JSON by resetting", async () => {
    let deleted = false;
    const mockSql = {
      exec: (sql: string, ..._args: any[]) => {
        if (sql.includes("DELETE")) {
          deleted = true;
          return { one: () => null };
        }
        return { one: () => ({ messages: "{corrupt", last_updated: 200 }) };
      },
    };
    const result = await getContextFromSQLite(mockSql as any, "user_1");
    expect(result.messages).toEqual([]);
    expect(deleted).toBe(true);
  });

  it("should trim messages exceeding MAX_CONTEXT_MESSAGES on save", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg_${i}`,
      timestamp: i,
    }));
    const saved: any[] = [];
    const mockSql = {
      exec: (sql: string, ...args: any[]) => {
        if (sql.includes("INSERT")) {
          saved.push(JSON.parse(args[1]));
        }
        return { one: () => null };
      },
    };
    await saveContextToSQLite(mockSql as any, "user_1", { userId: "user_1", messages, lastUpdated: 0 });
    // Should only keep the last 40
    expect(saved[0]).toHaveLength(40);
    expect(saved[0][0].content).toBe("msg_10");
    expect(saved[0][39].content).toBe("msg_49");
  });

  it("should clear context", async () => {
    let deleted = false;
    const mockSql = {
      exec: (sql: string, ..._args: any[]) => {
        if (sql.includes("DELETE")) {
          deleted = true;
        }
        return { one: () => null };
      },
    };
    await clearContextSQLite(mockSql as any, "user_1");
    expect(deleted).toBe(true);
  });
});

describe("getContextFromD1 / saveContextToD1 / clearContextD1", () => {
  function makeMockD1(results: any[] = []) {
    const bind = () => ({
      all: () => Promise.resolve({ results }),
    });
    return {
      prepare: () => ({ bind }),
    };
  }

  it("should return empty context when no rows exist", async () => {
    const db = makeMockD1([]);
    const result = await getContextFromD1(db as any, "user_1");
    expect(result.userId).toBe("user_1");
    expect(result.messages).toEqual([]);
  });

  it("should parse stored context", async () => {
    const stored = JSON.stringify([
      { role: "user", content: "你好", timestamp: 100 },
    ]);
    const db = makeMockD1([{ messages: stored, last_updated: 200 }]);
    const result = await getContextFromD1(db as any, "user_1");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("你好");
  });

  it("should handle corrupt JSON by resetting", async () => {
    let deleted = false;
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          all: () => {
            if (sql.includes("DELETE")) return Promise.resolve({ results: [] });
            return Promise.resolve({ results: [{ messages: "{corrupt", last_updated: 200 }] });
          },
          run: () => {
            deleted = true;
            return Promise.resolve({ success: true });
          },
        }),
      }),
    };
    const result = await getContextFromD1(db as any, "user_1");
    expect(result.messages).toEqual([]);
    expect(deleted).toBe(true);
  });

  it("should trim messages exceeding MAX_CONTEXT_MESSAGES on save", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg_${i}`,
      timestamp: i,
    }));
    let saved: string = "";
    const db = {
      prepare: () => ({
        bind: (...args: any[]) => ({
          run: () => {
            saved = args[1];
            return Promise.resolve({ success: true });
          },
        }),
      }),
    };
    await saveContextToD1(db as any, "user_1", { userId: "user_1", messages, lastUpdated: 0 });
    const parsed = JSON.parse(saved);
    expect(parsed).toHaveLength(40);
    expect(parsed[0].content).toBe("msg_10");
  });

  it("should clear context", async () => {
    let deleted = false;
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: any[]) => ({
          run: () => {
            if (sql.includes("DELETE")) deleted = true;
            return Promise.resolve({ success: true });
          },
        }),
      }),
    };
    await clearContextD1(db as any, "user_1");
    expect(deleted).toBe(true);
  });
});