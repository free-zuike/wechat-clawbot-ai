// MCP Server 管理路由
// 提供 MCP Server 的增删改查、工具列表获取、连通性测试
// 数据存储在 D1 数据库（mcp_servers 表），不使用 KV

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";
import {
  ensureMCPServersTable,
  loadAllMCPServers,
  saveMCPServers,
  updateServerTools,
  getAllMCPTools,
  type MCPServerConfig,
} from "../services/mcp";

function maskKey(key: string): string {
  if (!key) return "";
  return key.length <= 8 ? "***" : key.slice(0, 4) + "***" + key.slice(-4);
}

function isMaskedKey(val: string): boolean {
  return !!val && val.includes("***");
}

function unmaskMCPKey(newVal: unknown, oldVal: unknown): string {
  if (typeof newVal === "string" && isMaskedKey(newVal)) {
    return (oldVal as string) || "";
  }
  return (newVal as string) || "";
}

// 提供给前端的响应（API Key 掩码化）
function maskServersResponse(servers: MCPServerConfig[]): any[] {
  return servers.map(s => ({
    ...s,
    apiKey: s.apiKey ? maskKey(s.apiKey) : "",
  }));
}

export async function handleMCP(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const url = new URL(request.url);
  const method = request.method;

  // 确保表存在
  await ensureMCPServersTable(env.DB);

  // 获取已存储的原始配置
  const stored = await loadAllMCPServers(env.DB);

  if (method === "GET") {
    // 列表 + 工具列表
    const withTools = await Promise.all(
      stored.map(async (s) => {
        const tools = await getAllMCPTools(env.DB);
        return {
          ...s,
          apiKey: s.apiKey ? maskKey(s.apiKey) : "",
          tools: tools.filter(t => t.serverId === s.id),
        };
      })
    );
    return json({ ok: true, servers: withTools });
  }

  if (method === "POST") {
    // 新增或更新
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: "INVALID_JSON", message: "无效的 JSON" }, 400);
    }

    const { id, name, url: serverUrl, apiKey, enabled, toolPrefix } = body;
    if (!name || !serverUrl) {
      return json({ error: "VALIDATION_ERROR", message: "名称和 URL 为必填" }, 400);
    }

    const serverId = id || `mcp_${Date.now().toString(36)}`;
    const existing = stored.find(s => s.id === serverId);

    const server: MCPServerConfig = {
      id: serverId,
      name: String(name).trim(),
      url: String(serverUrl).trim(),
      apiKey: existing ? unmaskMCPKey(apiKey, existing.apiKey) : String(apiKey || ""),
      enabled: enabled !== false,
      toolPrefix: toolPrefix || `mcp_${serverId}`,
      tools: existing?.tools || [],
      toolsFetchedAt: existing?.toolsFetchedAt,
    };

    const idx = stored.findIndex(s => s.id === serverId);
    if (idx >= 0) stored[idx] = server;
    else stored.push(server);

    await saveMCPServers(env.DB, stored);
    Logger.info("[mcp] server saved", { id: serverId, name: server.name });
    return json({ ok: true, serverId, server: maskServersResponse([server])[0] });
  }

  if (method === "DELETE") {
    // 删除
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "VALIDATION_ERROR", message: "缺少 id" }, 400);
    const remaining = stored.filter(s => s.id !== id);
    await saveMCPServers(env.DB, remaining);
    Logger.info("[mcp] server deleted", { id });
    return json({ ok: true });
  }

  if (method === "PUT") {
    // 刷新工具列表
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "VALIDATION_ERROR", message: "缺少 id" }, 400);
    const server = stored.find(s => s.id === id);
    if (!server) return json({ error: "NOT_FOUND", message: "MCP Server 不存在" }, 404);

    // 清空缓存后重新拉取
    await updateServerTools(env.DB, id, []);
    const tools = await getAllMCPTools(env.DB);
    const serverTools = tools.filter(t => t.serverId === id);

    return json({ ok: true, tools: serverTools });
  }

  return json({ error: "Method Not Allowed" }, 405);
}