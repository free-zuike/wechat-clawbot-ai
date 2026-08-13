import { describe, it, expect } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  buildMeta,
  isModernError,
} from "./mcp";

describe("MCP_PROTOCOL_VERSION", () => {
  it("should be 2026-07-28", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2026-07-28");
  });
});

describe("LEGACY_PROTOCOL_VERSION", () => {
  it("should be 2025-06-18", () => {
    expect(LEGACY_PROTOCOL_VERSION).toBe("2025-06-18");
  });
});

describe("buildMeta", () => {
  it("should include protocol version", () => {
    const meta = buildMeta();
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("should include client capabilities with tools", () => {
    const meta = buildMeta();
    expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({
      tools: {},
      resources: {},
      prompts: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    });
  });

  it("should include client info", () => {
    const meta = buildMeta();
    expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({
      name: "clawbot-mcp-client",
      version: "2.0.0",
    });
  });
});

describe("isModernError", () => {
  it("should return true for UnsupportedProtocolVersionError (-32022)", () => {
    expect(isModernError({ code: -32022, message: "Unsupported protocol version" })).toBe(true);
  });

  it("should return true for HeaderMismatchError (-32020)", () => {
    expect(isModernError({ code: -32020, message: "Header mismatch" })).toBe(true);
  });

  it("should return true for MissingRequiredClientCapabilityError (-32021)", () => {
    expect(isModernError({ code: -32021, message: "Missing capability" })).toBe(true);
  });

  it("should return false for HTTP 400", () => {
    expect(isModernError({ code: 400, message: "Bad Request" })).toBe(false);
  });

  it("should return false for HTTP 404", () => {
    expect(isModernError({ code: 404, message: "Not found" })).toBe(false);
  });

  it("should return false for JSON-RPC method not found (-32601)", () => {
    expect(isModernError({ code: -32601, message: "Method not found" })).toBe(false);
  });

  it("should return false for null/undefined", () => {
    expect(isModernError(null)).toBe(false);
    expect(isModernError(undefined)).toBe(false);
  });

  it("should return false for empty error", () => {
    expect(isModernError({})).toBe(false);
  });

  it("should NOT match on protocol version text in message body", () => {
    // EdgeEvery 的 400 错误体里可能包含 "Unsupported protocol version" 文本
    // 但错误码是 400（HTTP 状态码），不是 -32022（JSON-RPC 错误码）
    // 所以应该返回 false
    expect(isModernError({ code: 400, message: "Unsupported protocol version" })).toBe(false);
  });
});