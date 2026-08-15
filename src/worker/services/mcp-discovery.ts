// MCP - 工具/资源/提示词发现与聚合
// 从 mcp.ts 拆出：fetchTools/Resources/Prompts、getAllMCPTools、定时刷新

import { Logger } from "../utils/error";
import type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
  MCPToolResult,
} from "./mcp-types";
import { loadMCPServers, loadAllMCPServers, updateServerTools } from "./mcp-store";
import { mcpRequest, ensureEra, ensureLegacySession } from "./mcp-transport";
import { clearSession } from "./mcp-session";

// ========== 工具发现 ==========

// 从 MCP Server 获取工具列表（现代：直接 tools/list；旧版：initialize → tools/list）
export async function fetchToolsFromServer(db: D1Database, server: MCPServerConfig): Promise<MCPToolDefinition[]> {
  const era = await ensureEra(db, server);

  if (era === "modern") {
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
    Logger.warn(`[mcp] tools/list failed for ${server.name}, falling back to stateless`, { error });
    return fetchToolsStateless(server);
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

// ========== 资源发现 ==========

export async function fetchResourcesFromServer(db: D1Database, server: MCPServerConfig): Promise<MCPResourceDefinition[]> {
  const era = await ensureEra(db, server);

  if (era === "modern") {
    const { result } = await mcpRequest(db, server, "resources/list");
    const resources = result?.resources || [];
    if (!Array.isArray(resources)) return [];
    return resources.map((r: any) => ({
      uri: r.uri,
      name: r.name || r.uri,
      description: r.description || "",
      mimeType: r.mimeType || "",
      serverId: server.id,
    }));
  }

  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) return [];

  const { result, error } = await mcpRequest(db, server, "resources/list");
  if (error) {
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return fetchResourcesFromServer(db, server);
    }
    return [];
  }
  const resources = result?.resources || [];
  if (!Array.isArray(resources)) return [];
  return resources.map((r: any) => ({
    uri: r.uri,
    name: r.name || r.uri,
    description: r.description || "",
    mimeType: r.mimeType || "",
    serverId: server.id,
  }));
}

// 读取资源内容
export async function executeResourceRead(db: D1Database, server: MCPServerConfig, uri: string, toolCallId: string): Promise<MCPToolResult> {
  const era = await ensureEra(db, server);
  if (era === "modern") {
    const { result, error } = await mcpRequest(db, server, "resources/read", { uri });
    if (error) return { callId: toolCallId, name: "read_resource", content: `读取失败: ${JSON.stringify(error)}`, isError: true };
    return { callId: toolCallId, name: "read_resource", content: formatContentResult(result?.contents || []) };
  }
  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) return { callId: toolCallId, name: "read_resource", content: "服务器不可用", isError: true };
  const { result, error } = await mcpRequest(db, server, "resources/read", { uri });
  if (error) {
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return executeResourceRead(db, server, uri, toolCallId);
    }
    return { callId: toolCallId, name: "read_resource", content: `读取失败: ${JSON.stringify(error)}`, isError: true };
  }
  return { callId: toolCallId, name: "read_resource", content: formatContentResult(result?.contents || []) };
}

// ========== 提示词发现 ==========

export async function fetchPromptsFromServer(db: D1Database, server: MCPServerConfig): Promise<MCPPromptDefinition[]> {
  const era = await ensureEra(db, server);

  if (era === "modern") {
    const { result } = await mcpRequest(db, server, "prompts/list");
    const prompts = result?.prompts || [];
    if (!Array.isArray(prompts)) return [];
    return prompts.map((p: any) => ({
      name: p.name,
      description: p.description || "",
      arguments: (p.arguments || []).map((a: any) => ({ name: a.name, description: a.description, required: a.required })),
      serverId: server.id,
    }));
  }

  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) return [];

  const { result, error } = await mcpRequest(db, server, "prompts/list");
  if (error) {
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return fetchPromptsFromServer(db, server);
    }
    return [];
  }
  const prompts = result?.prompts || [];
  if (!Array.isArray(prompts)) return [];
  return prompts.map((p: any) => ({
    name: p.name,
    description: p.description || "",
    arguments: (p.arguments || []).map((a: any) => ({ name: a.name, description: a.description, required: a.required })),
    serverId: server.id,
  }));
}

// 获取提示词内容
export async function executePromptGet(db: D1Database, server: MCPServerConfig, name: string, args: Record<string, string> | undefined, toolCallId: string): Promise<MCPToolResult> {
  const era = await ensureEra(db, server);
  const params: any = { name };
  if (args) params.arguments = args;

  if (era === "modern") {
    const { result, error } = await mcpRequest(db, server, "prompts/get", params);
    if (error) return { callId: toolCallId, name: "get_prompt", content: `获取失败: ${JSON.stringify(error)}`, isError: true };
    return { callId: toolCallId, name: "get_prompt", content: formatContentResult(result?.messages || []) };
  }
  const sessionOk = await ensureLegacySession(db, server);
  if (!sessionOk) return { callId: toolCallId, name: "get_prompt", content: "服务器不可用", isError: true };
  const { result, error } = await mcpRequest(db, server, "prompts/get", params);
  if (error) {
    if (error.message === "SESSION_EXPIRED") {
      await clearSession(db, server.id);
      return executePromptGet(db, server, name, args, toolCallId);
    }
    return { callId: toolCallId, name: "get_prompt", content: `获取失败: ${JSON.stringify(error)}`, isError: true };
  }
  return { callId: toolCallId, name: "get_prompt", content: formatContentResult(result?.messages || []) };
}

// 格式化资源/提示词内容（兼容多种 content 结构）
export function formatContentResult(contents: any[]): string {
  return contents.map((c: any) => {
    if (c.type === "text" && c.text) return c.text;
    if (c.type === "resource" && c.resource) {
      const r = c.resource;
      if (r.text) return r.text;
      if (r.blob) return `[二进制数据 ${r.blob.length} 字节, ${r.mimeType || "未知格式"}]`;
      return JSON.stringify(r);
    }
    return JSON.stringify(c);
  }).filter(Boolean).join("\n\n");
}

// ========== 工具聚合 ==========

// 获取所有已缓存的 MCP 工具定义（含前缀），可选自动拉取
// autoFetch 仅在工具缓存为空且距上次拉取超过 30 秒时才会触发，避免 subrequest 耗尽
const lastAutoFetchAttempt = new Map<string, number>();
const AUTO_FETCH_COOLDOWN_MS = 30_000;

export async function getAllMCPTools(db: D1Database | null, autoFetch = false): Promise<MCPToolDefinition[]> {
  const servers = await loadMCPServers(db);
  const allTools: MCPToolDefinition[] = [];

  for (const server of servers) {
    let tools = server.tools;

    if ((!tools || tools.length === 0) && autoFetch && db) {
      const lastAttempt = lastAutoFetchAttempt.get(server.id) || 0;
      const now = Date.now();
      if (now - lastAttempt > AUTO_FETCH_COOLDOWN_MS) {
        lastAutoFetchAttempt.set(server.id, now);
        tools = await fetchToolsFromServer(db, server);
        if (tools.length > 0) {
          updateServerTools(db, server.id, tools).catch((e: any) => Logger.warn("[mcp] Failed to cache tools", { server: server.name, error: e?.message }));
        }
      }
    }

    const prefix = server.toolPrefix || `mcp_${server.id}`;
    for (const tool of (tools || [])) {
      const serverTag = `[${server.name}] `;
      const taggedDesc = tool.description ? `${serverTag}${tool.description}` : `${serverTag}...`;
      allTools.push({ ...tool, name: `${prefix}_${tool.name}`, description: taggedDesc, rawName: tool.name, serverId: server.id });
    }

    // 资源读取工具（如果服务器有资源）
    let resources = server.resources;
    if ((!resources || resources.length === 0) && autoFetch && db) {
      resources = await fetchResourcesFromServer(db, server);
    }
    if (resources && resources.length > 0) {
      allTools.push({
        name: `${prefix}_read_resource`,
        description: `[${server.name}] 读取指定资源的内容。可用的资源：${resources.map(r => r.name).join("、")}`,
        inputSchema: { type: "object", properties: { uri: { type: "string", description: `资源 URI，可选值：${resources.map(r => r.uri).join("、")}` } }, required: ["uri"] },
        serverId: server.id,
        rawName: "read_resource",
      });
    }

    // 提示词获取工具（如果服务器有提示词）
    let prompts = server.prompts;
    if ((!prompts || prompts.length === 0) && autoFetch && db) {
      prompts = await fetchPromptsFromServer(db, server);
    }
    if (prompts && prompts.length > 0) {
      allTools.push({
        name: `${prefix}_get_prompt`,
        description: `[${server.name}] 获取指定提示词模板的内容。可用的提示词：${prompts.map(p => p.name).join("、")}`,
        inputSchema: { type: "object", properties: { name: { type: "string", description: `提示词名称，可选值：${prompts.map(p => p.name).join("、")}` } }, required: ["name"] },
        serverId: server.id,
        rawName: "get_prompt",
      });
    }
  }

  return allTools;
}

// ========== 定时刷新：定期检查 MCP 工具变更 ==========

// 检查所有 MCP 服务器的工具是否过期（超过 5 分钟未刷新），若是则重新拉取
export async function refreshAllMCPToolsIfStale(db: D1Database | null): Promise<void> {
  if (!db) return;
  try {
    const servers = await loadAllMCPServers(db);
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000; // 5 分钟

    for (const server of servers) {
      if (!server.enabled) continue;
      const lastFetch = server.toolsFetchedAt || 0;
      if (now - lastFetch < STALE_MS) continue; // 未过期，跳过

      Logger.info(`[mcp] Refreshing stale tools for ${server.name}`);
      try {
        const tools = await fetchToolsFromServer(db, {
          ...server,
          tools: undefined, // 强制重新拉取
        });
        if (tools.length > 0) {
          await updateServerTools(db, server.id, tools);
          Logger.info(`[mcp] Refreshed ${tools.length} tools for ${server.name}`);
        }
      } catch (e: any) {
        Logger.warn(`[mcp] Failed to refresh tools for ${server.name}`, { error: e?.message });
      }
    }
  } catch (e: any) {
    Logger.warn("[mcp] Failed to refresh stale MCP tools", { error: e?.message });
  }
}