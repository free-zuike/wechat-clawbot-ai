// MCP (Model Context Protocol) 服务 - 标准 Streamable HTTP 传输
// 遵循 MCP 2025-06-18 规范：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

import { Logger } from "../utils/error";

// ========== 类型定义 ==========

export interface MCPServerConfig {
  id: string;
  name: string;
  /** MCP Server 端点 URL（如 https://example.com/mcp） */
  url: string;
  /** 可选：API Key 用于认证 */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 工具名称前缀 */
  toolPrefix?: string;
  /** 工具定义列表（已缓存） */
  tools?: MCPToolDefinition[];
  /** 最近一次获取工具的时间戳 */
  toolsFetchedAt?: number;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  serverId: string;
  rawName?: string;
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
  callId: string;
  rawName: string;
  serverId: string;
}

export interface MCPToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

// ========== 会话管理 ==========

// 确保 mcp_sessions 表存在
export async function ensureMCPSessionsTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS mcp_sessions (
        server_id TEXT PRIMARY KEY,
        session_id TEXT,
        protocol_version TEXT,
        server_capabilities TEXT,
        expires_at INTEGER,
        updated_at TEXT NOT NULL
      )`
    ).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to ensure mcp_sessions table", { error: e?.message });
    throw e;
  }
}

interface MCPSession {
  sessionId: string | null;
  protocolVersion: string;
  serverCapabilities: Record<string, any>;
  expiresAt: number;
}

async function loadSession(db: D1Database, serverId: string): Promise<MCPSession | null> {
  try {
    const { results } = await db.prepare(
      `SELECT session_id, protocol_version, server_capabilities, expires_at FROM mcp_sessions WHERE server_id = ?`
    ).bind(serverId).all();
    const row = (results as any[])?.[0];
    if (!row) return null;
    // 检查是否过期
    if (row.expires_at && row.expires_at < Date.now()) {
      await db.prepare(`DELETE FROM mcp_sessions WHERE server_id = ?`).bind(serverId).run();
      return null;
    }
    return {
      sessionId: row.session_id || null,
      protocolVersion: row.protocol_version || "2025-06-18",
      serverCapabilities: row.server_capabilities ? JSON.parse(row.server_capabilities) : {},
      expiresAt: row.expires_at || 0,
    };
  } catch {
    return null;
  }
}

async function saveSession(db: D1Database, serverId: string, session: MCPSession): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO mcp_sessions (server_id, session_id, protocol_version, server_capabilities, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET
         session_id = excluded.session_id,
         protocol_version = excluded.protocol_version,
         server_capabilities = excluded.server_capabilities,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    ).bind(
      serverId,
      session.sessionId || "",
      session.protocolVersion,
      JSON.stringify(session.serverCapabilities),
      session.expiresAt,
      new Date().toISOString()
    ).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to save session", { error: e?.message, serverId });
  }
}

async function clearSession(db: D1Database, serverId: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM mcp_sessions WHERE server_id = ?`).bind(serverId).run();
  } catch {}
}

// ========== 标准 MCP 传输层 ==========

const MCP_PROTOCOL_VERSION = "2025-06-18";

// 发送 JSON-RPC 请求到 MCP Server，返回 result 或 error
async function mcpRequest(
  db: D1Database,
  server: MCPServerConfig,
  method: string,
  params?: any,
  options?: { noSession?: boolean; id?: number }
): Promise<{ result?: any; error?: any; sessionId?: string | null }> {
  const endpoint = server.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (server.apiKey) {
    headers["Authorization"] = `Bearer ${server.apiKey}`;
  }

  // 非初始化请求需要会话和协议版本
  if (!options?.noSession) {
    const session = await loadSession(db, server.id);
    if (session?.sessionId) {
      headers["Mcp-Session-Id"] = session.sessionId;
    }
    headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
  }

  const requestId = options?.id ?? Date.now();
  const body: any = { jsonrpc: "2.0", id: requestId, method };
  if (params !== undefined) body.params = params;

  const resp = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });

  // 会话过期 → 通知调用方重新初始化
  if (resp.status === 404 && !options?.noSession) {
    return { error: { code: -32000, message: "SESSION_EXPIRED" }, sessionId: null };
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { error: { code: resp.status, message: errBody.slice(0, 500) } };
  }

  // 提取会话 ID（从响应头）
  const sessionId = resp.headers.get("Mcp-Session-Id");

  // 解析响应体
  const contentType = resp.headers.get("Content-Type") || "";
  const rawBody = await resp.text();

  // SSE 流式响应
  if (contentType.includes("text/event-stream")) {
    return parseSSEResponse(rawBody, requestId, sessionId);
  }

  // JSON Lines
  if (contentType.includes("application/jsonl")) {
    return parseJSONLResponse(rawBody, requestId, sessionId);
  }

  // 单 JSON 响应
  try {
    const data = JSON.parse(rawBody);
    if (data.error) return { error: data.error, sessionId };
    return { result: data.result, sessionId };
  } catch {
    return { error: { code: -32700, message: "Parse error: invalid JSON" } };
  }
}

// 解析 SSE 事件流，找到匹配 requestId 的响应
function parseSSEResponse(body: string, requestId: number, sessionId: string | null): { result?: any; error?: any; sessionId?: string | null } {
  let lastResult: any = null;
  let lastError: any = null;

  // SSE 格式: "event: message\ndata: {...}\n\n"
  const events = body.split("\n\n");
  for (const event of events) {
    if (!event.trim()) continue;
    let dataStr = "";
    for (const line of event.split("\n")) {
      if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
        break;
      }
    }
    if (!dataStr) continue;
    try {
      const msg = JSON.parse(dataStr);
      if (msg.id === requestId) {
        if (msg.error) lastError = msg.error;
        else lastResult = msg.result;
      }
    } catch {}
  }

  if (lastResult) return { result: lastResult, sessionId };
  if (lastError) return { error: lastError, sessionId };
  return { error: { code: -32000, message: "No matching response in SSE stream" }, sessionId };
}

// 解析 JSON Lines 响应
function parseJSONLResponse(body: string, requestId: number, sessionId: string | null): { result?: any; error?: any; sessionId?: string | null } {
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === requestId) {
        if (msg.error) return { error: msg.error, sessionId };
        return { result: msg.result, sessionId };
      }
    } catch {}
  }
  return { error: { code: -32000, message: "No matching response in JSONL stream" }, sessionId };
}

// ========== 会话初始化 ==========

async function initializeSession(db: D1Database, server: MCPServerConfig): Promise<void> {
  Logger.info("[mcp] Initializing session", { server: server.name });

  const { result, sessionId, error } = await mcpRequest(db, server, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "clawbot-mcp-client", version: "1.0.0" },
  }, { noSession: true, id: 1 });

  if (error) {
    // 如果不支持 initialize（可能是旧版 MCP 服务器），记录但不阻塞
    if (error.code === -32601 || error.code === 404 || error.code === 405) {
      Logger.warn(`[mcp] Server ${server.name} does not support initialize, using stateless mode`);
      // 保存一个空会话标记，跳过后续初始化
      await saveSession(db, server.id, {
        sessionId: null,
        protocolVersion: "2024-11-05",
        serverCapabilities: {},
        expiresAt: 0,
      });
      return;
    }
    throw new Error(`MCP 初始化失败: ${JSON.stringify(error)}`);
  }

  const protocolVersion = result?.protocolVersion || "2025-06-18";
  const serverCapabilities = result?.capabilities || {};
  const serverSessionId = sessionId || null;

  // 保存会话
  await saveSession(db, server.id, {
    sessionId: serverSessionId,
    protocolVersion,
    serverCapabilities,
    expiresAt: 0, // 永不过期（除非服务器返回 404）
  });

  // 发送 initialized 通知
  if (serverSessionId) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Mcp-Session-Id": serverSessionId,
      "MCP-Protocol-Version": protocolVersion,
    };
    if (server.apiKey) headers["Authorization"] = `Bearer ${server.apiKey}`;

    try {
      await fetch(server.url.replace(/\/+$/, ""), {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
    } catch {
      // initialized 通知失败不影响后续请求
    }
  }

  Logger.info("[mcp] Session initialized", { server: server.name, protocolVersion, hasSession: !!serverSessionId });
}

// 确保会话有效，若无效则重新初始化
async function ensureSession(db: D1Database, server: MCPServerConfig): Promise<boolean> {
  const session = await loadSession(db, server.id);
  if (session) return true; // 已有有效会话

  try {
    await initializeSession(db, server);
    return true;
  } catch (e: any) {
    Logger.warn("[mcp] Session init failed", { server: server.name, error: e?.message });
    return false;
  }
}

// ========== 数据表管理 ==========

export async function ensureMCPServersTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        api_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        tool_prefix TEXT,
        tools TEXT,
        tools_fetched_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to ensure mcp_servers table", { error: e?.message });
    throw e;
  }
}

// ========== 服务器配置 CRUD ==========

export async function loadMCPServers(db: D1Database | null): Promise<MCPServerConfig[]> {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at FROM mcp_servers ORDER BY created_at ASC`
    ).all() as any;
    return (results || []).map((r: any) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      apiKey: r.api_key || undefined,
      enabled: !!r.enabled,
      toolPrefix: r.tool_prefix || undefined,
      tools: r.tools ? JSON.parse(r.tools) : undefined,
      toolsFetchedAt: r.tools_fetched_at || undefined,
    })).filter(s => s.enabled);
  } catch (e: any) {
    Logger.warn("[mcp] Failed to load MCP servers", { error: e?.message });
    return [];
  }
}

export async function loadAllMCPServers(db: D1Database | null): Promise<MCPServerConfig[]> {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at FROM mcp_servers ORDER BY created_at ASC`
    ).all() as any;
    return (results || []).map((r: any) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      apiKey: r.api_key || undefined,
      enabled: !!r.enabled,
      toolPrefix: r.tool_prefix || undefined,
      tools: r.tools ? JSON.parse(r.tools) : undefined,
      toolsFetchedAt: r.tools_fetched_at || undefined,
    }));
  } catch (e: any) {
    Logger.warn("[mcp] Failed to load all MCP servers", { error: e?.message });
    return [];
  }
}

export async function saveMCPServers(db: D1Database | null, servers: MCPServerConfig[]): Promise<void> {
  if (!db) return;
  // 确保表存在
  await ensureMCPServersTable(db);
  try {
    if (servers.length === 0) return;
    await db.batch(
      servers.map((s) =>
        db.prepare(
          `INSERT INTO mcp_servers (id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, url = excluded.url, api_key = excluded.api_key,
             enabled = excluded.enabled, tool_prefix = excluded.tool_prefix,
             tools = excluded.tools, tools_fetched_at = excluded.tools_fetched_at,
             updated_at = excluded.updated_at`
        ).bind(
          s.id, s.name, s.url, s.apiKey || "", s.enabled ? 1 : 0,
          s.toolPrefix || "", s.tools ? JSON.stringify(s.tools) : "[]",
          s.toolsFetchedAt || null, new Date().toISOString(), new Date().toISOString()
        )
      )
    );
  } catch (e: any) {
    Logger.warn("[mcp] Failed to save MCP servers (batch), trying individual inserts", { error: e?.message });
    // batch 失败时逐个插入
    for (const s of servers) {
      try {
        await db.prepare(
          `INSERT INTO mcp_servers (id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, url = excluded.url, api_key = excluded.api_key,
             enabled = excluded.enabled, tool_prefix = excluded.tool_prefix,
             tools = excluded.tools, tools_fetched_at = excluded.tools_fetched_at,
             updated_at = excluded.updated_at`
        ).bind(
          s.id, s.name, s.url, s.apiKey || "", s.enabled ? 1 : 0,
          s.toolPrefix || "", s.tools ? JSON.stringify(s.tools) : "[]",
          s.toolsFetchedAt || null, new Date().toISOString(), new Date().toISOString()
        ).run();
      } catch (e2: any) {
        Logger.error("[mcp] Failed to save individual server", { error: e2?.message, serverId: s.id });
        throw e2;
      }
    }
  }
}

export async function deleteMCPServer(db: D1Database | null, serverId: string): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).bind(serverId).run();
    await clearSession(db, serverId);
  } catch (e: any) {
    Logger.warn("[mcp] Failed to delete MCP server", { error: e?.message });
    throw e;
  }
}

export async function updateServerTools(db: D1Database | null, serverId: string, tools: MCPToolDefinition[]): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `UPDATE mcp_servers SET tools = ?, tools_fetched_at = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(tools), Date.now(), new Date().toISOString(), serverId).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to update server tools", { error: e?.message });
  }
}

// ========== 工具发现 ==========

// 从 MCP Server 获取工具列表（标准流程：initialize → tools/list）
export async function fetchToolsFromServer(db: D1Database, server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  // 确保会话有效
  const sessionOk = await ensureSession(db, server);
  if (!sessionOk) {
    // 如果初始化失败（服务器不支持标准协议），尝试无状态方式
    Logger.info(`[mcp] Trying stateless tool fetch for ${server.name}`);
    return fetchToolsStateless(server);
  }

  // 发送 tools/list
  const { result, error } = await mcpRequest(db, server, "tools/list");

  if (error) {
    // 会话过期 → 清除会话后重试一次
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return fetchToolsFromServer(db, server);
    }
    Logger.warn(`[mcp] tools/list failed for ${server.name}`, { error });
    return [];
  }

  const tools = result?.tools || [];
  if (!Array.isArray(tools)) return [];

  return tools.map((t: any) => ({
    name: t.name,
    description: t.description || "",
    inputSchema: t.inputSchema || t.parameters || {},
    serverId: server.id,
  }));
}

// 无状态方式获取工具（兼容旧版 MCP 服务器 / 不支持 initialize 的服务器）
async function fetchToolsStateless(server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (server.apiKey) headers["Authorization"] = `Bearer ${server.apiKey}`;

    // 尝试标准 tools/list JSON-RPC 到同一端点
    const resp = await fetch(server.url.replace(/\/+$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    const tools = data?.result?.tools || data?.tools || [];
    if (!Array.isArray(tools)) return [];

    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || t.parameters || {},
      serverId: server.id,
    }));
  } catch {
    return [];
  }
}

// 获取所有已缓存的 MCP 工具定义（含前缀），可选自动拉取
export async function getAllMCPTools(db: D1Database | null, autoFetch = false): Promise<MCPToolDefinition[]> {
  const servers = await loadMCPServers(db);
  const allTools: MCPToolDefinition[] = [];

  for (const server of servers) {
    let tools = server.tools;

    if ((!tools || tools.length === 0) && autoFetch && db) {
      tools = await fetchToolsFromServer(db, server);
      if (tools.length > 0) {
        updateServerTools(db, server.id, tools).catch(() => {});
      }
    }

    const prefix = server.toolPrefix || `mcp_${server.id}`;
    for (const tool of (tools || [])) {
      const serverTag = `[${server.name}] `;
      // 描述前面加服务名标签，帮助 AI 区分不同 MCP 服务器的工具归属
      const taggedDesc = tool.description ? `${serverTag}${tool.description}` : `${serverTag}...`;
      allTools.push({ ...tool, name: `${prefix}_${tool.name}`, description: taggedDesc, rawName: tool.name, serverId: server.id });
    }
  }

  return allTools;
}

// ========== OpenAI 工具格式转换 ==========

// 从 inputSchema 提取参数说明，追加到描述中，帮助 AI 正确传参
function buildToolDesc(tool: MCPToolDefinition): string {
  const schema = tool.inputSchema?.properties;
  if (!schema || typeof schema !== "object") return tool.description;

  const hints: string[] = [];
  for (const [key, prop] of Object.entries(schema) as [string, any][]) {
    const type = prop.type || "string";
    const required = tool.inputSchema?.required?.includes(key) ? "必填" : "可选";
    const enum_ = prop.enum ? `(${prop.enum.join("/")})` : "";
    const desc = prop.description ? `- ${prop.description}` : "";
    hints.push(`${key}(${type} ${required}${enum_ ? " " + enum_ : ""})${desc}`.trim());
  }
  if (hints.length === 0) return tool.description;
  return `${tool.description}\n\n参数: ${hints.join(", ")}`;
}

export function mcpToolsToOpenAI(tools: MCPToolDefinition[]): any[] {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: buildToolDesc(t), parameters: t.inputSchema },
  }));
}

// ========== 工具调用解析 ==========

export function parseToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  allTools: MCPToolDefinition[]
): MCPToolCall[] {
  const toolMap = new Map(allTools.map(t => [t.name, t]));

  return toolCalls.map(tc => {
    let args: Record<string, any> = {};
    try { args = JSON.parse(tc.function.arguments); } catch {}

    const toolDef = toolMap.get(tc.function.name);
    return {
      name: tc.function.name,
      arguments: args,
      callId: tc.id,
      rawName: toolDef?.rawName || tc.function.name,
      serverId: toolDef?.serverId || "",
    };
  });
}

// ========== 工具执行 ==========

// 执行单个 MCP 工具调用（标准流程：initialize → tools/call）
async function executeToolCall(
  db: D1Database,
  server: MCPServerConfig,
  toolCall: MCPToolCall
): Promise<MCPToolResult> {
  // 确保会话有效
  const sessionOk = await ensureSession(db, server);
  if (!sessionOk) {
    // 无状态方式兜底
    return executeToolCallStateless(server, toolCall);
  }

  // 发送 tools/call
  const { result, error } = await mcpRequest(db, server, "tools/call", {
    name: toolCall.rawName,
    arguments: toolCall.arguments,
  });

  if (error) {
    // 会话过期 → 清除后重试一次
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return executeToolCall(db, server, toolCall);
    }
    return {
      callId: toolCall.callId,
      name: toolCall.name,
      content: `调用失败: ${JSON.stringify(error)}`,
      isError: true,
    };
  }

  // 解析 content 数组
  const content = result?.content || [];
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "");
    const text = textParts.join("\n") || JSON.stringify(content);
    // 检查是否有 isError 标记
    const isError = content.some((c: any) => c.type === "error");
    return { callId: toolCall.callId, name: toolCall.name, content: text, isError: isError || undefined };
  }

  return { callId: toolCall.callId, name: toolCall.name, content: JSON.stringify(result) };
}

// 无状态方式执行工具调用（兼容旧版）
async function executeToolCallStateless(server: MCPServerConfig, toolCall: MCPToolCall): Promise<MCPToolResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (server.apiKey) headers["Authorization"] = `Bearer ${server.apiKey}`;

    const resp = await fetch(server.url.replace(/\/+$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolCall.rawName, arguments: toolCall.arguments },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return { callId: toolCall.callId, name: toolCall.name, content: `调用失败 (HTTP ${resp.status}): ${errBody.slice(0, 500)}`, isError: true };
    }

    const data = await resp.json() as any;
    const content = data?.result?.content || data?.content || [];
    if (Array.isArray(content)) {
      const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n") || JSON.stringify(content);
      return { callId: toolCall.callId, name: toolCall.name, content: text };
    }
    return { callId: toolCall.callId, name: toolCall.name, content: JSON.stringify(content) };
  } catch (e: any) {
    return { callId: toolCall.callId, name: toolCall.name, content: `调用异常: ${e?.message || String(e)}`, isError: true };
  }
}

// 执行一批 MCP 工具调用
export async function executeToolCalls(
  toolCalls: MCPToolCall[],
  db: D1Database | null
): Promise<MCPToolResult[]> {
  if (toolCalls.length === 0 || !db) return [];

  const servers = await loadMCPServers(db);
  const serverMap = new Map(servers.map(s => [s.id, s]));

  const results: MCPToolResult[] = [];
  for (const tc of toolCalls) {
    const server = serverMap.get(tc.serverId);
    if (!server) {
      results.push({ callId: tc.callId, name: tc.name, content: `未找到 MCP Server: ${tc.serverId}`, isError: true });
      continue;
    }
    const result = await executeToolCall(db, server, tc);
    results.push(result);
  }

  return results;
}