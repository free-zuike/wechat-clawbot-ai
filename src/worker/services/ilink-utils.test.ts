import { describe, it, expect, vi, afterEach } from "vitest";
import { hashText, generateMessageId } from "./ilink-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hashText", () => {
  it("should produce stable 8-char hex hash", () => {
    expect(hashText("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("should be deterministic", () => {
    expect(hashText("same input")).toBe(hashText("same input"));
  });

  it("should differ for different inputs", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("should handle empty string", () => {
    expect(hashText("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("should handle Chinese text", () => {
    const h1 = hashText("今天天气不错");
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(hashText("今天天气不错")).toBe(h1);
  });
});

describe("generateMessageId", () => {
  it("should use primary fields when present", () => {
    const msg = {
      from_user_id: "user1",
      context_token: "token1",
      message_id: 42,
      create_time_ms: 123456789,
      seq: 5,
    } as any;
    const id = generateMessageId(msg, "text");
    expect(id).toContain("user1");
    expect(id).toContain("token1");
    expect(id).toContain("42");
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it("should handle missing fields gracefully", () => {
    const msg = { from_user_id: "u", context_token: "t" } as any;
    const id = generateMessageId(msg, "text");
    expect(id).toBe("u:t");
  });

  it("should fall back to hash when all primary fields missing", () => {
    const msg = {} as any;
    const id1 = generateMessageId(msg, "same text");
    const id2 = generateMessageId(msg, "same text");
    expect(id1).toBe(id2);
    expect(id1).toContain("unknown");
    // 不同文本应生成不同 ID
    expect(generateMessageId({} as any, "other")).not.toBe(id1);
  });

  it("should produce stable ID across calls for same message", () => {
    const msg = { from_user_id: "u1", context_token: "c1", message_id: 7 } as any;
    expect(generateMessageId(msg, "x")).toBe(generateMessageId(msg, "x"));
  });
});