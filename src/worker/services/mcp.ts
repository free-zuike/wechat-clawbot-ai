// MCP (Model Context Protocol) 服务 - 调用外部服务/工具
// 支持配置多个 MCP Server，AI 可在对话中自动调用其提供的工具

import { Logger } from "../utils/error";

// ========== 类型定义 ==========

export interface MCPServerConfig {
  id: string;
  name: string;
  /** MCP Server 的 HTTP 端点 URL（必填） */
  url: string;
  /** 可选：API Key 用于认证 */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 工具名称前缀（避免名称冲突，如 "mcp_tools_1"） */
  toolPrefix?: string;
  /** 工具定义列表（从 MCP Server 获取，或手动配置） */
  tools?: MCPToolDefinition[];
  /** 最近一次获取工具的时间戳 */
  toolsFetchedAt?: number;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 格式的输入参数 */
  inputSchema: Record<string, any>;
  /** 所属 MCP Server ID */
  serverId: string;
}

export interface MCPToolCall {
  /** 工具名称（含前缀） */
  name: string;
  /** 调用参数 */
  arguments: Record<string, any>;
  /** 调用 ID（由 AI 返回） */
  callId: string;
  /** 原始工具名（不含前缀） */
  rawName: string;
  /** 所属 MCP Server ID */
  serverId: string;
}

export interface MCPToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

// ========== MCP 服务 ==========

// 确保 mcp_servers 表存在
export async function ensureMCPServersTable(db: D1Database): Promise<void> {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
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
      )
    `);
  } catch (e: any) {
    Logger.warn("[mcp] Failed to ensure mcp_servers table", { error: e?.message });
  }
}

// 加载 MCP Server 配置（仅启用的）
export async function loadMCPServers(db: D1Database | null): Promise<MCPServerConfig[]> {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at FROM mcp_servers ORDER BY created_at ASC`
    ).all();
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

// 加载所有 MCP Server 配置（含禁用的，用于管理）
export async function loadAllMCPServers(db: D1Database | null): Promise<MCPServerConfig[]> {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at FROM mcp_servers ORDER BY created_at ASC`
    ).all();
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

// 保存全部 MCP Server 配置（逐条 upsert，避免删全表导致数据丢失）
export async function saveMCPServers(db: D1Database | null, servers: MCPServerConfig[]): Promise<void> {
  if (!db) return;
  try {
    await db.batch(
      servers.map((s) =>
        db.prepare(
          `INSERT INTO mcp_servers (id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             url = excluded.url,
             api_key = excluded.api_key,
             enabled = excluded.enabled,
             tool_prefix = excluded.tool_prefix,
             tools = excluded.tools,
             tools_fetched_at = excluded.tools_fetched_at,
             updated_at = excluded.updated_at`
        ).bind(
          s.id,
          s.name,
          s.url,
          s.apiKey || "",
          s.enabled ? 1 : 0,
          s.toolPrefix || "",
          s.tools ? JSON.stringify(s.tools) : "[]",
          s.toolsFetchedAt || null,
          new Date().toISOString(),
          new Date().toISOString()
        )
      )
    );
  } catch (e: any) {
    Logger.warn("[mcp] Failed to save MCP servers", { error: e?.message });
    throw e;
  }
}

// 删除单个 MCP Server
export async function deleteMCPServer(db: D1Database | null, serverId: string): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).bind(serverId).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to delete MCP server", { error: e?.message });
    throw e;
  }
}

// 更新单个 MCP Server 的工具列表
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

// 从 MCP Server 获取工具列表（通过 MCP 协议规范端点）
export async function fetchToolsFromServer(server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (server.apiKey) {
      headers["Authorization"] = `Bearer ${server.apiKey}`;
    }

    // 标准 MCP 协议：POST /tools/list
    const resp = await fetch(`${server.url.replace(/\/+$/, "")}/tools/list`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    if (!resp.ok) {
      Logger.warn(`[mcp] Failed to fetch tools from ${server.name}`, { status: resp.status });
      return [];
    }

    const data = await resp.json() as any;
    // MCP 响应格式: { jsonrpc: "2.0", id: 1, result: { tools: [...] } }
    const tools = data?.result?.tools || data?.tools || [];
    if (!Array.isArray(tools)) return [];

    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || t.parameters || {},
      serverId: server.id,
    }));
  } catch (e: any) {
    Logger.warn(`[mcp] Error fetching tools from ${server.name}`, { error: e?.message });
    return [];
  }
}

// 获取所有 MCP 工具定义（含前缀），可选是否自动拉取
export async function getAllMCPTools(db: D1Database | null, autoFetch = true): Promise<MCPToolDefinition[]> {
  const servers = await loadMCPServers(db);
  const allTools: MCPToolDefinition[] = [];

  for (const server of servers) {
    let tools = server.tools;

    // 如果还没有工具定义且允许自动拉取，尝试从 MCP Server 获取
    if ((!tools || tools.length === 0) && autoFetch) {
      tools = await fetchToolsFromServer(server);
      // 异步缓存工具定义到 D1（不阻塞返回）
      if (tools.length > 0) {
        updateServerTools(db, server.id, tools).catch(() => {});
      }
    }

    const prefix = server.toolPrefix || `mcp_${server.id}`;
    for (const tool of tools) {
      allTools.push({
        ...tool,
        name: `${prefix}_${tool.name}`,
        serverId: server.id,
      });
    }
  }

  return allTools;
}

// 将 MCP 工具转换为 OpenAI 兼容的 tool 格式
export function mcpToolsToOpenAI(tools: MCPToolDefinition[]): any[] {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// 解析 AI 返回的 tool_calls 为 MCP 调用
export function parseToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  allTools: MCPToolDefinition[]
): MCPToolCall[] {
  const toolMap = new Map(allTools.map(t => [t.name, t]));

  return toolCalls.map(tc => {
    const toolDef = toolMap.get(tc.function.name);
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {}

    return {
      name: tc.function.name,
      arguments: args,
      callId: tc.id,
      rawName: toolDef ? tc.function.name.replace(/^mcp_[^_]+_/, "") : tc.function.name,
      serverId: toolDef?.serverId || "",
    };
  });
}

// 执行单个 MCP 工具调用
async function executeToolCall(
  server: MCPServerConfig,
  toolCall: MCPToolCall
): Promise<MCPToolResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (server.apiKey) {
    headers["Authorization"] = `Bearer ${server.apiKey}`;
  }

  try {
    // 标准 MCP 协议：POST /tools/call
    const resp = await fetch(`${server.url.replace(/\/+$/, "")}/tools/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolCall.rawName,
          arguments: toolCall.arguments,
        },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      return {
        callId: toolCall.callId,
        name: toolCall.name,
        content: `调用失败 (HTTP ${resp.status}): ${errBody.slice(0, 500)}`,
        isError: true,
      };
    }

    const data = await resp.json() as any;
    // MCP 响应格式: { jsonrpc: "2.0", id: ..., result: { content: [...] } }
    const content = data?.result?.content || data?.content || [];

    if (Array.isArray(content)) {
      // MCP content 可以是多种类型: text, image, resource
      const textParts = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "");
      const text = textParts.join("\n") || JSON.stringify(content);
      return { callId: toolCall.callId, name: toolCall.name, content: text };
    }

    return {
      callId: toolCall.callId,
      name: toolCall.name,
      content: typeof content === "string" ? content : JSON.stringify(content),
    };
  } catch (e: any) {
    return {
      callId: toolCall.callId,
      name: toolCall.name,
      content: `调用异常: ${e?.message || String(e)}`,
      isError: true,
    };
  }
}

// 执行一批 MCP 工具调用并返回结果
export async function executeToolCalls(
  toolCalls: MCPToolCall[],
  db: D1Database | null
): Promise<MCPToolResult[]> {
  if (toolCalls.length === 0) return [];

  const servers = await loadMCPServers(db);
  const serverMap = new Map(servers.map(s => [s.id, s]));

  const results: MCPToolResult[] = [];
  for (const tc of toolCalls) {
    const server = serverMap.get(tc.serverId);
    if (!server) {
      results.push({
        callId: tc.callId,
        name: tc.name,
        content: `未找到 MCP Server: ${tc.serverId}`,
        isError: true,
      });
      continue;
    }
    const result = await executeToolCall(server, tc);
    results.push(result);
  }

  return results;
}

// ========== 完整的 MCP 对话处理 ==========
// 在 AI 调用完成后，检查是否有 tool_calls，循环执行直到 AI 给出最终回复

export async function callAIWithMCP(
  params: {
    messages: Array<{ role: string; content: string | any[] }>;
    tools: MCPToolDefinition[];
    mcpServers: MCPServerConfig[];
    db: D1Database | null;
    maxTokens?: number;
    temperature?: number;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  },
  maxRounds: number = 5
): Promise<string> {
  const { messages, tools, mcpServers, db, maxTokens = 2048, temperature = 0.7, model, baseUrl, apiKey } = params;
  const serverMap = new Map(mcpServers.map(s => [s.id, s]));

  // 保存工具定义到 servers 中，方便 executeToolCall 查找
  for (const tool of tools) {
    const server = serverMap.get(tool.serverId);
    if (server) {
      if (!server.tools) server.tools = [];
      if (!server.tools.find(t => t.name === tool.name)) {
        server.tools.push(tool);
      }
    }
  }

  // 构建 OpenAI 工具格式
  const openAITools = mcpToolsToOpenAI(tools);
  if (openAITools.length === 0) {
    // 没有 MCP 工具，直接返回 AI 回复
    return "";
  }

  const apiUrl = (baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey_ = apiKey || "";

  for (let round = 0; round < maxRounds; round++) {
    const body: any = {
      model: model || "gpt-4o",
      messages,
      max_tokens: maxTokens,
      temperature,
      tools: openAITools,
    };

    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey_}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`MCP AI 调用失败 (${resp.status}): ${errBody.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new Error("MCP AI 响应格式异常");
    }

    // 将 AI 回复添加到消息列表
    messages.push({
      role: "assistant",
      content: message.content || "",
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    } as any);

    // 检查是否有 tool_calls
    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // 没有工具调用，返回最终回复
      return message.content || "";
    }

    // 解析并执行工具调用
    const parsedCalls = parseToolCalls(toolCalls, tools);
    const results = await executeToolCalls(parsedCalls, db);

    // 将工具结果添加到消息列表
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.content,
      } as any);
    }

    Logger.info(`[mcp] Round ${round + 1}: ${toolCalls.length} tools called, ${results.length} results`);
  }

  // 达到最大轮次限制，返回最后一条助手消息
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  return (lastAssistant?.content as string) || "";
}