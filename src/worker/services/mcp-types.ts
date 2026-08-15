// MCP (Model Context Protocol) - 类型定义与协议常量
// 从 mcp.ts 拆出：无副作用、无运行时依赖的类型与常量

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
  /** 资源列表（已缓存） */
  resources?: MCPResourceDefinition[];
  /** 资源获取时间戳 */
  resourcesFetchedAt?: number;
  /** 提示词列表（已缓存） */
  prompts?: MCPPromptDefinition[];
  /** 提示词获取时间戳 */
  promptsFetchedAt?: number;
  /** OAuth client credentials */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthToken?: string;
  oauthTokenExpiresAt?: number;
  /** OAuth 授权服务器端点（从服务器 discover 响应中获取） */
  oauthAuthorizer?: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  serverId: string;
  rawName?: string;
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  serverId: string;
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
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";
export const CLIENT_INFO = { name: "clawbot-mcp-client", version: "2.0.0" };

// 现代请求的 _meta 元数据（2026-07-28 要求每个请求携带）
export function buildMeta(): Record<string, any> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {
      tools: {},
      resources: {},
      prompts: {},
      extensions: {
        "io.modelcontextprotocol/tasks": {},
      },
    },
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  };
}