import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  buildMeta,
  isModernError,
  parseToolCalls,
  mcpToolsToOpenAI,
  fetchToolsFromServer,
  type MCPServerConfig,
  type MCPToolDefinition,
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

describe("parseToolCalls", () => {
  const allTools: MCPToolDefinition[] = [
    { name: "mcp_abc_get_balance", description: "查余额", inputSchema: {}, serverId: "abc", rawName: "get_balance" },
    { name: "mcp_abc_create_tx", description: "记账", inputSchema: {}, serverId: "abc", rawName: "create_tx" },
  ];

  it("should map tool name to rawName and serverId", () => {
    const calls = parseToolCalls(
      [{ id: "call_1", function: { name: "mcp_abc_get_balance", arguments: "{}" } }],
      allTools
    );
    expect(calls).toEqual([
      { name: "mcp_abc_get_balance", arguments: {}, callId: "call_1", rawName: "get_balance", serverId: "abc" },
    ]);
  });

  it("should parse arguments JSON into object", () => {
    const calls = parseToolCalls(
      [{ id: "c1", function: { name: "mcp_abc_create_tx", arguments: '{"amount":100,"note":"午餐"}' } }],
      allTools
    );
    expect(calls[0].arguments).toEqual({ amount: 100, note: "午餐" });
  });

  it("should fall back to {} for invalid arguments JSON", () => {
    const calls = parseToolCalls(
      [{ id: "c1", function: { name: "mcp_abc_get_balance", arguments: "not-json{" } }],
      allTools
    );
    expect(calls[0].arguments).toEqual({});
  });

  it("should use prefixed name as rawName when tool definition is unknown", () => {
    const calls = parseToolCalls(
      [{ id: "c1", function: { name: "unknown_tool", arguments: "{}" } }],
      allTools
    );
    expect(calls[0]).toEqual({ name: "unknown_tool", arguments: {}, callId: "c1", rawName: "unknown_tool", serverId: "" });
  });

  it("should handle multiple tool calls in one response", () => {
    const calls = parseToolCalls(
      [
        { id: "a", function: { name: "mcp_abc_get_balance", arguments: "{}" } },
        { id: "b", function: { name: "mcp_abc_create_tx", arguments: '{"amount":1}' } },
      ],
      allTools
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].callId).toBe("a");
    expect(calls[1].callId).toBe("b");
  });
});

describe("mcpToolsToOpenAI", () => {
  it("should convert MCP tool definitions to OpenAI function format", () => {
    const tools: MCPToolDefinition[] = [
      {
        name: "mcp_srv_get_balance",
        description: "[服务] 查询账户余额",
        inputSchema: { type: "object", properties: { account: { type: "string", description: "账户名" } }, required: ["account"] },
        serverId: "srv",
        rawName: "get_balance",
      },
    ];
    const result = mcpToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("mcp_srv_get_balance");
    expect(result[0].function.parameters).toEqual(tools[0].inputSchema);
    // 描述应追加参数说明
    expect(result[0].function.description).toContain("account");
    expect(result[0].function.description).toContain("必填");
  });

  it("should append action hint for list-type tools", () => {
    const tools: MCPToolDefinition[] = [
      { name: "mcp_srv_list_memos", description: "[服务] 备忘录列表", inputSchema: {}, serverId: "srv", rawName: "list_memos" },
    ];
    const result = mcpToolsToOpenAI(tools);
    expect(result[0].function.description).toContain("【列表】");
  });

  it("should return empty array for empty input", () => {
    expect(mcpToolsToOpenAI([])).toEqual([]);
  });
});

describe("fetchToolsFromServer era detection & fallback", () => {
  // 最小 D1 mock：支持 prepare/bind/all/run，内存 map 存储会话
  const sessions = new Map<string, any>();
  const db = {
    prepare(sql: string) {
      const self: any = { args: [] as any[], sql };
      self.bind = (...args: any[]) => { self.args = args; return self; };
      self.all = async () => {
        if (self.sql.includes("SELECT") && self.sql.includes("mcp_sessions")) {
          const row = sessions.get(self.args[0]);
          return { results: row ? [row] : [] };
        }
        return { results: [] };
      };
      self.run = async () => {
        if (self.sql.includes("INSERT") || self.sql.includes("UPDATE")) {
          sessions.set(self.args[0], { session_id: self.args[1], protocol_version: self.args[2], server_capabilities: self.args[3], expires_at: self.args[4] });
        }
        if (self.sql.includes("DELETE")) sessions.delete(self.args[0]);
        return { success: true, meta: {} };
      };
      return self;
    },
  } as unknown as D1Database;

  afterEach(() => {
    vi.unstubAllGlobals();
    sessions.clear();
  });

  const jsonResponse = (body: any, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("should detect modern server and fetch tools via tools/list", async () => {
    let discoverCalled = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.method === "server/discover") {
        discoverCalled = true;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-07-28", capabilities: { tools: {} } } });
      }
      if (body.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ping", description: "测试工具", inputSchema: { type: "object" } }] } });
      }
      return new Response("not found", { status: 404 });
    }));

    const server: MCPServerConfig = { id: "srv_modern", name: "Modern", url: "https://example.com/mcp", enabled: true };
    const tools = await fetchToolsFromServer(db, server);

    expect(discoverCalled).toBe(true);
    expect(server.era).toBe("modern");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: "ping",
      description: "测试工具",
      inputSchema: { type: "object" },
      serverId: "srv_modern",
    });
  });

  it("should treat 400-without-modern-error as legacy and fetch statelessly when initialize unsupported", async () => {
    let statelessToolsList = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      // 无状态裸请求：tools/list 且没有 _meta（现代检测请求带 _meta 字段）
      if (body.method === "tools/list" && !body._meta) {
        statelessToolsList = true;
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "legacy_tool", description: "旧版工具", inputSchema: {} }] } });
      }
      // 旧版服务器：discover / 现代 tools/list / initialize 都返回 HTTP 404
      return new Response("not found", { status: 404 });
    }));

    const server: MCPServerConfig = { id: "srv_legacy", name: "Legacy", url: "https://legacy.example.com/mcp", enabled: true };
    const tools = await fetchToolsFromServer(db, server);

    expect(server.era).toBe("legacy");
    expect(statelessToolsList).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("legacy_tool");
  });

  it("should distinguish modern from legacy via server/discover", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init?.body || "{}");
      if (body.method === "server/discover") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-07-28" } });
      }
      return new Response("not found", { status: 404 });
    }));

    const server: MCPServerConfig = { id: "srv_detect", name: "Detect", url: "https://detect.example.com/mcp", enabled: true };
    await fetchToolsFromServer(db, server);
    expect(server.era).toBe("modern");
  });
});