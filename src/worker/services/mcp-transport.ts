// MCP - 标准 Streamable HTTP 传输层
// 从 mcp.ts 拆出：mcpRequest / 响应解析 / 时代检测 / legacy 会话初始化
// 遵循 MCP 2026-07-28 规范（dual-era）：
// - 现代（2026-07-28+）：无状态，每请求带 _meta，无 initialize 握手
// - 旧版（2025-11-25-）：initialize + Mcp-Session-Id 会话
// 自动检测服务器时代：先发现代请求，400 且无现代错误体 → 降级为旧版

import { Logger } from "../utils/error";
import {
  MCP_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  CLIENT_INFO,
  buildMeta,
  type MCPServerConfig,
} from "./mcp-types";
import {
  ensureMCPSessionsTable,
  loadSession,
  saveSession,
  clearSession,
  extractOAuthMeta,
  ensureOAuthToken,
} from "./mcp-session";

// mcpRequest 中调用：如果收到 401 且服务器有 OAuth 元数据，尝试获取 token
async function handleOAuthIfNeeded(db: D1Database, server: MCPServerConfig, error: any): Promise<string | null> {
  // 只在 401 时尝试 OAuth
  if (error?.code !== 401) return null;
  return ensureOAuthToken(db, server);
}

// 发送 JSON-RPC 请求到 MCP Server，返回 result 或 error
// mode: "modern"（2026-07-28 无状态）或 "legacy"（旧版会话）
export async function mcpRequest(
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
    // Mcp-Name: 对 tools/call 传工具名，其他方法传方法名
    headers["Mcp-Name"] = (method === "tools/call" && params?.name) ? String(params.name) : method;
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

  // 401 → 尝试 OAuth 认证
  if (resp.status === 401) {
    const token = await handleOAuthIfNeeded(db, server, { code: 401 });
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      try {
        resp = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (e: any) {
        return { error: { code: -32000, message: `Network error: ${e?.message || "fetch failed"}` } };
      }
    }
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
    // 提取 OAuth 元数据
    const oauthMeta = extractOAuthMeta(data.result);
    if (oauthMeta.authorizer && !server.oauthAuthorizer) {
      server.oauthAuthorizer = oauthMeta.authorizer;
      Logger.info("[mcp] OAuth authorizer discovered", { server: server.name, authorizer: oauthMeta.authorizer });
    }
    // 处理 2026-07-28 的 resultType 字段
    const result = data.result;
    if (result && result.resultType === "input_required") {
      // MRTR（Multi Round-Trip Request）：服务器需要更多输入才能完成
      // 当前场景（工具调用）不处理 MRTR，返回提示信息
      Logger.warn("[mcp] Server requested additional input (MRTR)", { inputRequests: result.inputRequests });
      return { result: { content: [{ type: "text", text: `服务器需要额外输入: ${JSON.stringify(result.inputRequests)}` }], isError: true }, sessionId };
    }
    // 兼容旧版服务器（无 resultType 字段）：视为 "complete"
    return { result: data.result, sessionId };
  } catch {
    return { error: { code: -32700, message: "Parse error: invalid JSON" } };
  }
}

// 解析 SSE 事件流，找到匹配 requestId 的响应
// 同时记录 progress/cancelled 通知（2026-07-28 通知随响应流返回）
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
      // 处理服务器通知（无 id 的 JSON-RPC 通知）
      if (msg.method === "notifications/progress") {
        Logger.info("[mcp] Progress notification", { progress: msg.params?.progress, total: msg.params?.total });
        continue;
      }
      if (msg.method === "notifications/cancelled") {
        Logger.warn("[mcp] Request cancelled by server", { requestId: msg.params?.requestId });
        continue;
      }
      if (msg.method === "notifications/message") {
        Logger.info("[mcp] Server message", { level: msg.params?.level, message: msg.params?.message });
        continue;
      }
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
export function isModernError(error?: any): boolean {
  if (!error) return false;
  // 现代 JSON-RPC 错误码：UnsupportedProtocolVersion (-32022), HeaderMismatch (-32020), MissingCapability (-32021)
  // 旧版服务器返回 HTTP 400，code 为正值，不匹配
  return error.code === -32022 || error.code === -32020 || error.code === -32021;
}

// 确保服务器时代已检测（缓存）
const eraCache = new Map<string, "modern" | "legacy">();

export async function ensureEra(db: D1Database, server: MCPServerConfig): Promise<"modern" | "legacy"> {
  if (server.era) return server.era;
  if (eraCache.has(server.id)) {
    server.era = eraCache.get(server.id)!;
    return server.era;
  }
  const era = await detectServerEra(db, server);
  eraCache.set(server.id, era);
  return era;
}

// 清除单个服务器的时代缓存（saveMCPServers 在配置变更后调用）
export function clearEraCache(serverId: string): void {
  eraCache.delete(serverId);
}

// ========== 旧版会话初始化（仅 legacy 服务器） ==========

export async function initializeSession(db: D1Database, server: MCPServerConfig): Promise<void> {
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
        protocolVersion: LEGACY_PROTOCOL_VERSION,
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

// 确保 legacy 会话可用（供 discovery/execute 内部使用）
export async function ensureLegacySession(db: D1Database, server: MCPServerConfig): Promise<boolean> {
  await ensureMCPSessionsTable(db);
  const session = await loadSession(db, server.id);
  if (session?.sessionId) return true;

  // 无会话或会话为 null（stateless 服务器保存了 null session）
  try {
    await initializeSession(db, server);
    const after = await loadSession(db, server.id);
    if (!after?.sessionId) {
      // initialize 成功但没返回 session id → stateless 或 sessionless，仍视为可用
      return true;
    }
    return true;
  } catch {
    return false;
  }
}