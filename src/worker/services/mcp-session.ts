// MCP - DC1 会话存储与管理（legacy 会话表 + OAuth token 存储）
// 从 mcp.ts 拆出：mcp_sessions 表操作 + OAuth token 管理

import { Logger } from "../utils/error";
import { LEGACY_PROTOCOL_VERSION } from "./mcp-types";
import type { MCPServerConfig } from "./mcp-types";

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

export async function loadSession(db: D1Database, serverId: string): Promise<MCPSession | null> {
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
      protocolVersion: row.protocol_version === "2024-11-05" ? LEGACY_PROTOCOL_VERSION : (row.protocol_version || LEGACY_PROTOCOL_VERSION),
      serverCapabilities: row.server_capabilities ? JSON.parse(row.server_capabilities) : {},
      expiresAt: row.expires_at || 0,
    };
  } catch {
    return null;
  }
}

export async function saveSession(db: D1Database, serverId: string, session: MCPSession): Promise<void> {
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

export async function clearSession(db: D1Database, serverId: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM mcp_sessions WHERE server_id = ?`).bind(serverId).run();
  } catch {}
}

// ========== OAuth 认证 ==========

// 从服务器响应中提取 OAuth 元数据（2026-07-28 规范）
export function extractOAuthMeta(result?: any): { authorizer?: string; resource?: string } {
  const meta = result?._meta;
  if (!meta) return {};
  const oauth = meta["io.modelcontextprotocol/oauth"] || meta["oauth"];
  if (!oauth) return {};
  return {
    authorizer: oauth.authorizationServer || oauth.authorizer,
    resource: oauth.resource,
  };
}

// 确保 OAuth token 有效，失效则刷新
export async function ensureOAuthToken(db: D1Database, server: MCPServerConfig): Promise<string | null> {
  // 如果没有配置 client_id，无法使用 OAuth
  if (!server.oauthClientId || !server.oauthClientSecret) return null;

  // 如果 token 还有效（5 分钟内不过期），直接返回
  if (server.oauthToken && server.oauthTokenExpiresAt && server.oauthTokenExpiresAt > Date.now() + 300_000) {
    return server.oauthToken;
  }

  const authorizer = server.oauthAuthorizer;
  if (!authorizer) return null;

  try {
    const resp = await fetch(authorizer, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: server.oauthClientId,
        client_secret: server.oauthClientSecret,
        resource: server.url,
      }).toString(),
    });
    if (!resp.ok) {
      Logger.warn("[mcp] OAuth token request failed", { status: resp.status, server: server.name });
      return null;
    }
    const data = await resp.json() as any;
    const token = data.access_token;
    const expiresIn = data.expires_in || 3600;
    if (token) {
      server.oauthToken = token;
      server.oauthTokenExpiresAt = Date.now() + expiresIn * 1000;
      // 直接更新数据库中的 token 字段
      try {
        await db.prepare(
          `UPDATE mcp_servers SET oauth_token = ?, oauth_token_expires_at = ?, updated_at = ? WHERE id = ?`
        ).bind(token, server.oauthTokenExpiresAt, new Date().toISOString(), server.id).run();
      } catch {}
      return token;
    }
  } catch (e: any) {
    Logger.warn("[mcp] OAuth token request error", { error: e?.message, server: server.name });
  }
  return null;
}