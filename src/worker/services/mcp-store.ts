// MCP - 服务器配置存储（mcp_servers 表 CRUD）
// 从 mcp.ts 拆出：表结构 + 加载/保存/删除/更新缓存

import { Logger } from "../utils/error";
import type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
} from "./mcp-types";
import { clearSession } from "./mcp-session";
import { clearEraCache } from "./mcp-transport";

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
        resources TEXT,
        resources_fetched_at INTEGER,
        prompts TEXT,
        prompts_fetched_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run();
    // 迁移旧表：添加 resources/prompts/oauth 列（如果不存在，ALTER 会报错则忽略）
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN resources TEXT`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN resources_fetched_at INTEGER`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN prompts TEXT`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN prompts_fetched_at INTEGER`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN oauth_client_secret TEXT`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN oauth_token TEXT`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN oauth_token_expires_at INTEGER`).run().catch(() => {});
    await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN oauth_authorizer TEXT`).run().catch(() => {});
  } catch (e: any) {
    Logger.warn("[mcp] Failed to ensure mcp_servers table", { error: e?.message });
    throw e;
  }
}

function mapRowToServer(r: any): MCPServerConfig {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    apiKey: r.api_key || undefined,
    enabled: !!r.enabled,
    toolPrefix: r.tool_prefix || undefined,
    tools: r.tools ? JSON.parse(r.tools) : undefined,
    toolsFetchedAt: r.tools_fetched_at || undefined,
    resources: r.resources ? JSON.parse(r.resources) : undefined,
    resourcesFetchedAt: r.resources_fetched_at || undefined,
    prompts: r.prompts ? JSON.parse(r.prompts) : undefined,
    promptsFetchedAt: r.prompts_fetched_at || undefined,
  };
}

// ========== 服务器配置 CRUD ==========

export async function loadMCPServers(db: D1Database | null): Promise<MCPServerConfig[]> {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at FROM mcp_servers ORDER BY created_at ASC`
    ).all() as any;
    return (results || []).map((r: any) => ({
      ...mapRowToServer(r),
      oauthClientId: r.oauth_client_id || undefined,
      oauthClientSecret: r.oauth_client_secret || undefined,
      oauthToken: r.oauth_token || undefined,
      oauthTokenExpiresAt: r.oauth_token_expires_at || undefined,
      oauthAuthorizer: r.oauth_authorizer || undefined,
    } as MCPServerConfig)).filter(s => s.enabled);
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
    return (results || []).map((r: any) => mapRowToServer(r));
  } catch (e: any) {
    Logger.warn("[mcp] Failed to load all MCP servers", { error: e?.message });
    return [];
  }
}

export async function saveMCPServers(db: D1Database | null, servers: MCPServerConfig[]): Promise<void> {
  if (!db) return;
  // 服务器配置变更后清除时代缓存，避免陈旧检测结果
  for (const s of servers) {
    clearEraCache(s.id);
  }
  // 确保表存在
  await ensureMCPServersTable(db);
  try {
    if (servers.length === 0) return;
    const single = (s: MCPServerConfig) => db.prepare(
      `INSERT INTO mcp_servers (id, name, url, api_key, enabled, tool_prefix, tools, tools_fetched_at, resources, resources_fetched_at, prompts, prompts_fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, url = excluded.url, api_key = excluded.api_key,
         enabled = excluded.enabled, tool_prefix = excluded.tool_prefix,
         tools = COALESCE(NULLIF(excluded.tools, ''), tools),
         tools_fetched_at = COALESCE(excluded.tools_fetched_at, tools_fetched_at),
         resources = COALESCE(NULLIF(excluded.resources, ''), resources),
         resources_fetched_at = COALESCE(excluded.resources_fetched_at, resources_fetched_at),
         prompts = COALESCE(NULLIF(excluded.prompts, ''), prompts),
         prompts_fetched_at = COALESCE(excluded.prompts_fetched_at, prompts_fetched_at),
         updated_at = excluded.updated_at`
    ).bind(
      s.id, s.name, s.url, s.apiKey || "", s.enabled ? 1 : 0,
      s.toolPrefix || "",
      s.tools !== undefined ? JSON.stringify(s.tools) : null,
      s.toolsFetchedAt || null,
      s.resources !== undefined ? JSON.stringify(s.resources) : null,
      s.resourcesFetchedAt || null,
      s.prompts !== undefined ? JSON.stringify(s.prompts) : null,
      s.promptsFetchedAt || null,
      new Date().toISOString(), new Date().toISOString()
    );
    try {
      await db.batch(servers.map(single));
    } catch (e: any) {
      Logger.warn("[mcp] Failed to save MCP servers (batch), trying individual inserts", { error: e?.message });
      // batch 失败时逐个插入
      for (const s of servers) {
        try {
          await single(s).run();
        } catch (e2: any) {
          Logger.error("[mcp] Failed to save individual server", { error: e2?.message, serverId: s.id });
          throw e2;
        }
      }
    }
  } catch (e: any) {
    Logger.warn("[mcp] Failed to save MCP servers", { error: e?.message });
  }
}

export async function deleteMCPServer(db: D1Database | null, serverId: string): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).bind(serverId).run();
    await clearSession(db, serverId);
    clearEraCache(serverId);
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

export async function updateServerResources(db: D1Database | null, serverId: string, resources: MCPResourceDefinition[]): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `UPDATE mcp_servers SET resources = ?, resources_fetched_at = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(resources), Date.now(), new Date().toISOString(), serverId).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to update server resources", { error: e?.message });
  }
}

export async function updateServerPrompts(db: D1Database | null, serverId: string, prompts: MCPPromptDefinition[]): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(
      `UPDATE mcp_servers SET prompts = ?, prompts_fetched_at = ?, updated_at = ? WHERE id = ?`
    ).bind(JSON.stringify(prompts), Date.now(), new Date().toISOString(), serverId).run();
  } catch (e: any) {
    Logger.warn("[mcp] Failed to update server prompts", { error: e?.message });
  }
}