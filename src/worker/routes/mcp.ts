// MCP Server 管理路由
// 提供 MCP Server 的增删改查、工具列表获取、连通性测试
// 数据存储在 D1 数据库（mcp_servers 表），不使用 KV

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";
import {
  ensureMCPServersTable,
  ensureMCPSessionsTable,
  loadAllMCPServers,
  saveMCPServers,
  deleteMCPServer,
  updateServerTools,
  getAllMCPTools,
  fetchToolsFromServer,
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

export async function handleMCP(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const url = new URL(request.url);
  const method = request.method;

  // 确保表存在
  await ensureMCPServersTable(env.DB);
  await ensureMCPSessionsTable(env.DB);

  if (method === "GET") {
    // 列表：只读缓存数据，不自动联网拉取工具
    const stored = await loadAllMCPServers(env.DB);
    const tools = await getAllMCPTools(env.DB, false);
    const servers = stored.map(s => ({
      ...s,
      apiKey: s.apiKey ? maskKey(s.apiKey) : "",
      tools: tools.filter(t => t.serverId === s.id),
    }));
    return json({ ok: true, servers });
  }

  if (method === "POST") {
    // 新增或更新
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: "INVALID_JSON", message: "无效的 JSON" }, 400);
    }

    const { id, name, url: serverUrl, apiKey, enabled, toolPrefix, oauthClientId, oauthClientSecret, oauthToken, oauthAuthorizer } = body;
    if (!name || !serverUrl) {
      return json({ error: "VALIDATION_ERROR", message: "名称和 URL 为必填" }, 400);
    }

    // 编辑时恢复原始 stored 数据，用于 unmask apiKey
    const stored = await loadAllMCPServers(env.DB);
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
      resources: existing?.resources,
      resourcesFetchedAt: existing?.resourcesFetchedAt,
      prompts: existing?.prompts,
      promptsFetchedAt: existing?.promptsFetchedAt,
      oauthClientId: oauthClientId || existing?.oauthClientId,
      oauthClientSecret: oauthClientSecret || existing?.oauthClientSecret,
      oauthToken: oauthToken || existing?.oauthToken,
      oauthTokenExpiresAt: existing?.oauthTokenExpiresAt,
      oauthAuthorizer: oauthAuthorizer || existing?.oauthAuthorizer,
    };

    // 只保存这一个 server（逐条 upsert，不涉及其他 server）
    try {
      await saveMCPServers(env.DB, [server]);
      // 单独保存 OAuth 配置（saveMCPServers 的 SQL 未包含 OAuth 列）
      if (oauthClientId || oauthClientSecret || oauthToken || oauthAuthorizer || existing?.oauthClientId) {
        await env.DB.prepare(
          `UPDATE mcp_servers SET oauth_client_id = ?, oauth_client_secret = ?, oauth_token = ?, oauth_token_expires_at = ?, oauth_authorizer = ?, updated_at = ? WHERE id = ?`
        ).bind(
          server.oauthClientId || null,
          server.oauthClientSecret || null,
          server.oauthToken || null,
          server.oauthTokenExpiresAt || null,
          server.oauthAuthorizer || null,
          new Date().toISOString(),
          serverId
        ).run().catch(() => {});
      }
      Logger.info("[mcp] server saved", { id: serverId, name: server.name });
      return json({
        ok: true,
        serverId,
        server: {
          ...server,
          apiKey: server.apiKey ? maskKey(server.apiKey) : "",
        },
      });
    } catch (e: any) {
      Logger.error("[mcp] save failed", { error: e?.message });
      return json({ error: "SAVE_FAILED", message: `保存失败: ${e?.message}` }, 500);
    }
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "VALIDATION_ERROR", message: "缺少 id" }, 400);
    try {
      await deleteMCPServer(env.DB, id);
      Logger.info("[mcp] server deleted", { id });
      return json({ ok: true });
    } catch (e: any) {
      return json({ error: "DELETE_FAILED", message: `删除失败: ${e?.message}` }, 500);
    }
  }

  if (method === "PUT") {
    // 刷新工具列表：主动拉取 MCP Server 的工具
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "VALIDATION_ERROR", message: "缺少 id" }, 400);

    const stored = await loadAllMCPServers(env.DB);
    const server = stored.find(s => s.id === id);
    if (!server) return json({ error: "NOT_FOUND", message: "MCP Server 不存在" }, 404);

    try {
      const tools = await fetchToolsFromServer(env.DB, server);
      if (tools.length > 0) {
        await updateServerTools(env.DB, id, tools);
      } else {
        Logger.warn(`[mcp] Refresh returned empty tools for ${server.name}, keeping existing cache`);
      }
      return json({ ok: true, tools, cached: tools.length === 0 });
    } catch (e: any) {
      return json({ error: "FETCH_FAILED", message: `获取工具失败: ${e?.message}` }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}