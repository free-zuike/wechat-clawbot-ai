// MCP (Model Context Protocol) 服务 - 标准 Streamable HTTP 传输
// 遵循 MCP 2026-07-28 规范（dual-era）：https://modelcontextprotocol.io/specification/2026-07-28
// - 现代（2026-07-28+）：无状态，每请求带 _meta，无 initialize 握手
// - 旧版（2025-11-25-）：initialize + Mcp-Session-Id 会话
// 自动检测服务器时代：先发现代请求，400 且无现代错误体 → 降级为旧版

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
  /** 服务器时代：modern=2026-07-28+，legacy=旧版会话握手 */
  era?: "modern" | "legacy";
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

// ========== 协议版本 ==========

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "clawbot-mcp-client", version: "2.0.0" };

// 现代请求的 _meta 元数据（2026-07-28 要求每个请求携带）
function buildMeta(): Record<string, any> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": { tools: {} },
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  };
}

// ========== 会话管理（仅旧版服务器使用） ==========

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
      protocolVersion: row.protocol_version || LEGACY_PROTOCOL_VERSION,
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

// 发送 JSON-RPC 请求到 MCP Server，返回 result 或 error
// mode: "modern"（2026-07-28 无状态）或 "legacy"（旧版会话）
async function mcpRequest(
  db: D1Database,
  server: MCPServerConfig,
  method: string,
  params?: any,
  options?: { noSession?: boolean; id?: number; forceModern?: boolean }
): Promise<{ result?: any; error?: any; sessionId?: string | null }> {
  const endpoint = server.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (server.apiKey) {
    headers["Authorization"] = `Bearer ${server.apiKey}`;
  }

  const requestId = options?.id ?? Date.now();
  const isModern = options?.forceModern || (server.era !== "legacy");

  let body: any;
  if (isModern) {
    // 现代模式：无会话，每请求带 _meta
    // 2026-07-28 要求标准请求头 Mcp-Method / Mcp-Name
    headers["Mcp-Method"] = method;
    headers["Mcp-Name"] = method;
    headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    body = { jsonrpc: "2.0", id: requestId, method, _meta: buildMeta() };
  } else {
    // 旧版模式：始终设置 MCP-Protocol-Version，会话 ID 仅在非初始化请求时设置
    if (!options?.noSession) {
      const session = await loadSession(db, server.id);
      if (session?.sessionId) {
        headers["Mcp-Session-Id"] = session.sessionId;
      }
      headers["MCP-Protocol-Version"] = session?.protocolVersion || LEGACY_PROTOCOL_VERSION;
    } else {
      // 即使 noSession（如 initialize），也必须设置 MCP-Protocol-Version
      headers["MCP-Protocol-Version"] = LEGACY_PROTOCOL_VERSION;
    }
    body = { jsonrpc: "2.0", id: requestId, method };
  }
  if (params !== undefined) body.params = params;

  let resp: Response;
  try {
    resp = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e: any) {
    return { error: { code: -32000, message: `Network error: ${e?.message || "fetch failed"}` } };
  }

  // 旧版会话过期 → 通知调用方重新初始化
  if (resp.status === 404 && !isModern && !options?.noSession) {
    return { error: { code: -32000, message: "SESSION_EXPIRED" }, sessionId: null };
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    return { error: { code: resp.status, message: errBody.slice(0, 500) } };
  }

  // 提取会话 ID（旧版从响应头）
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

// ========== 时代检测与服务器发现 ==========

// 调用 server/discover，探测服务器支持的协议版本（现代服务器必实现）
async function discoverServer(db: D1Database, server: MCPServerConfig): Promise<any | null> {
  try {
    const { result } = await mcpRequest(db, server, "server/discover", undefined, { forceModern: true, id: 1 });
    return result || null;
  } catch {
    return null;
  }
}

// 检测服务器时代。现代服务器：请求成功或返回现代 JSON-RPC 错误。
// 旧版服务器：400 且无现代错误体 → legacy
async function detectServerEra(db: D1Database, server: MCPServerConfig): Promise<"modern" | "legacy"> {
  try {
    const discover = await discoverServer(db, server);
    if (discover) {
      server.era = "modern";
      return "modern";
    }

    // discover 失败 → 尝试现代 tools/list
    const { error, result } = await mcpRequest(db, server, "tools/list", undefined, { forceModern: true, id: 2 });
    if (result || isModernError(error)) {
      server.era = "modern";
      return "modern";
    }
  } catch (e: any) {
    Logger.warn("[mcp] Era detection failed, assuming legacy", { server: server.name, error: e?.message });
  }
  // 400 无现代错误体 → 旧版
  server.era = "legacy";
  Logger.info(`[mcp] Server ${server.name} detected as legacy (initialize-based)`);
  return "legacy";
}

// 判断错误是否为"可识别的现代 JSON-RPC 错误"
// 现代服务器返回 200 OK + JSON-RPC error（code 为负值，如 -32022）
// 旧版服务器返回 HTTP 400（code 为 HTTP 状态码正值）
function isModernError(error?: any): boolean {
  if (!error) return false;
  // 现代 JSON-RPC 错误码：UnsupportedProtocolVersion (-32022), HeaderMismatch (-32020), MissingCapability (-32021)
  // 旧版服务器返回 HTTP 400，code 为正值，不匹配
  return error.code === -32022 || error.code === -32020 || error.code === -32021;
}

// 确保服务器时代已检测（缓存）
const eraCache = new Map<string, "modern" | "legacy">();

async function ensureEra(db: D1Database, server: MCPServerConfig): Promise<"modern" | "legacy"> {
  if (server.era) return server.era;
  if (eraCache.has(server.id)) {
    server.era = eraCache.get(server.id)!;
    return server.era;
  }
  const era = await detectServerEra(db, server);
  eraCache.set(server.id, era);
  return era;
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
    eraCache.delete(serverId);
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

// 从 MCP Server 获取工具列表（现代：直接 tools/list；旧版：initialize → tools/list）
export async function fetchToolsFromServer(db: D1Database, server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  const era = await ensureEra(db, server);

  if (era === "modern") {
    // 现代无状态：直接 tools/list
    const { result } = await mcpRequest(db, server, "tools/list");
    const tools = result?.tools || [];
    if (!Array.isArray(tools)) return [];
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || t.parameters || {},
      serverId: server.id,
    }));
  }

  // 旧版：确保会话 → tools/list
  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) {
    Logger.info(`[mcp] Trying stateless tool fetch for ${server.name}`);
    return fetchToolsStateless(server);
  }

  const { result, error } = await mcpRequest(db, server, "tools/list");
  if (error) {
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

// 根据工具名自动推断工具动作类型，追加语义提示，帮助 AI 在多个工具中正确选择
function inferActionHint(name: string): string | null {
  const n = name.toLowerCase();
  // 详情类：用户说"看第X条/详情/内容"时用
  if (/^(get|read|view|fetch|detail|show|list_memo)$/.test(n)) return "【详情】当用户要看某条记录的完整内容/详情时调用";
  // 搜索类
  if (/^search|^find|^query/.test(n)) return "【搜索】当用户要按关键词/条件查找内容时调用";
  // 列表类
  if (/^list/.test(n)) return "【列表】当用户要查看某类数据的列表/清单时调用";
  // 创建类
  if (/^(create|add|new|insert|post|send|write|import|upload)/.test(n)) return "【创建/发送】当用户要新增记录、发送内容时调用";
  // 更新类
  if (/^(update|edit|modify|change|set|rename|move|merge|restore)/.test(n)) return "【修改】当用户要更新/修改内容时调用";
  // 删除类
  if (/^(delete|remove|trash|clear|deactivate)/.test(n)) return "【删除】当用户要删除/移除内容时调用";
  // 统计类
  if (/^(stats|summary|count|analy|overview)/.test(n)) return "【统计】当用户要看汇总/统计/分析时调用";
  return null;
}

// 从 inputSchema 提取参数说明，追加到描述中，帮助 AI 正确传参
function buildToolDesc(tool: MCPToolDefinition): string {
  // 对常见参数名自动推断格式提示（通用，不针对特定 MCP）
  const FORMAT_HINTS: Record<string, string> = {
    period: "格式: YYYY-MM(月) / YYYY(年) / YYYY-MM-DD(日)",
    date_from: "格式: YYYY-MM-DD，开始日期",
    date_to: "格式: YYYY-MM-DD，结束日期",
    happened_at: "格式: YYYY-MM-DD，交易发生时间",
  };

  let desc = tool.description || "";

  // 追加动作类型提示（帮助 AI 区分列表/详情/创建/删除等）
  const actionHint = inferActionHint(tool.rawName || tool.name);
  if (actionHint) {
    desc = `${desc} ${actionHint}`.trim();
  }

  // 附加参数说明
  const schema = tool.inputSchema?.properties;
  if (schema && typeof schema === "object") {
    const hints: string[] = [];
    for (const [key, prop] of Object.entries(schema) as [string, any][]) {
      const type = prop.type || "string";
      const required = tool.inputSchema?.required?.includes(key) ? "必填" : "可选";
      const enum_ = prop.enum ? `(${prop.enum.join("/")})` : "";
      const paramDesc = prop.description || FORMAT_HINTS[key] || "";
      hints.push(`${key}(${type} ${required}${enum_ ? " " + enum_ : ""})${paramDesc ? " - " + paramDesc : ""}`.trim());
    }
    if (hints.length > 0) {
      desc = `${desc}\n\n参数: ${hints.join(", ")}`;
    }
  }

  return desc;
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

// 执行单个 MCP 工具调用（现代：直接 tools/call；旧版：initialize → tools/call）
async function executeToolCall(
  db: D1Database,
  server: MCPServerConfig,
  toolCall: MCPToolCall
): Promise<MCPToolResult> {
  const era = await ensureEra(db, server);

  if (era === "modern") {
    // 现代无状态：直接 tools/call
    const { result, error } = await mcpRequest(db, server, "tools/call", {
      name: toolCall.rawName,
      arguments: toolCall.arguments,
    });
    if (error) {
      return {
        callId: toolCall.callId,
        name: toolCall.name,
        content: `调用失败: ${JSON.stringify(error)}`,
        isError: true,
      };
    }
    return formatToolResult(toolCall, result);
  }

  // 旧版：确保会话 → tools/call
  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) {
    return executeToolCallStateless(server, toolCall);
  }

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

  return formatToolResult(toolCall, result);
}

// 统一格式化工具结果（兼容 2026-07-28 的 resultType/content 结构和旧版结构）
function formatToolResult(toolCall: MCPToolCall, result?: any): MCPToolResult {
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

// 执行一批 MCP 工具调用（串行执行，避免并发会话冲突）
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

// ========== 旧版会话初始化（仅 legacy 服务器） ==========

async function initializeSession(db: D1Database, server: MCPServerConfig): Promise<void> {
  Logger.info("[mcp] Initializing legacy session", { server: server.name });

  const { result, sessionId, error } = await mcpRequest(db, server, "initialize", {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, { noSession: true, id: 1, forceModern: false });

  if (error) {
    // 如果不支持 initialize（可能是旧版 MCP 服务器），记录但不阻塞
    if (error.code === -32601 || error.code === 404 || error.code === 405) {
      Logger.warn(`[mcp] Server ${server.name} does not support initialize, using stateless mode`);
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

  const protocolVersion = result?.protocolVersion || LEGACY_PROTOCOL_VERSION;
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

  Logger.info("[mcp] Legacy session initialized", { server: server.name, protocolVersion, hasSession: !!serverSessionId });
}

// 确保旧版会话有效，若无效则重新初始化
async function ensureLegacySession(db: D1Database, server: MCPServerConfig): Promise<boolean> {
  const session = await loadSession(db, server.id);
  if (session) return true; // 已有有效会话

  try {
    await initializeSession(db, server);
    return true;
  } catch (e: any) {
    Logger.warn("[mcp] Legacy session init failed", { server: server.name, error: e?.message });
    return false;
  }
}

// 发送告警通知：自动从已配置的 MCP 服务器中寻找推送工具（如 BeeSwarm 的 send_push）
// 不依赖 webhook 配置，直接使用 MCP 工具调用
export async function sendAlert(db: D1Database | null, title: string, body: string): Promise<void> {
  if (!db) return;
  try {
    const servers = await loadAllMCPServers(db);
    for (const server of servers) {
      if (!server.enabled || !server.tools) continue;
      // 在工具列表中找名包含 push/notify/alert 的工具
      const pushTool = server.tools.find(t => {
        const name = (t.name || "").toLowerCase();
        return name.includes("push") || name.includes("notify") || name.includes("alert");
      });
      if (!pushTool) continue;

      const prefix = server.toolPrefix || `mcp_${server.id}`;
      const toolCall: MCPToolCall = {
        name: `${prefix}_${pushTool.name}`,
        rawName: pushTool.name,
        serverId: server.id,
        callId: `alert_${Date.now()}`,
        arguments: { title, body, content: `${title}\n${body}` },
      };
      const result = await executeToolCall(db, server, toolCall);
      if (result.isError) {
        // 参数可能不同，重试一次简化参数
        const retryCall: MCPToolCall = {
          ...toolCall,
          arguments: { message: `${title}: ${body}` },
        };
        await executeToolCall(db, server, retryCall);
      }
      Logger.info("[mcp] Alert sent via MCP", { server: server.name, tool: pushTool.name });
      return; // 只发一次
    }
    Logger.warn("[mcp] No push-capable MCP tool found for alert");
  } catch (e: any) {
    Logger.warn("[mcp] Alert failed", { error: e?.message });
  }
}