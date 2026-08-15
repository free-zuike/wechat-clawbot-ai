// MCP (Model Context Protocol) 服务 - 统一入口（模块汇聚）
// 拆分说明：
//   mcp-types.ts       类型定义与协议常量
//   mcp-session.ts     会话存储 + OAuth token
//   mcp-transport.ts   Streamable HTTP 传输层（mcpRequest/时代检测/会话初始化）
//   mcp-store.ts       mcp_servers 表 CRUD
//   mcp-discovery.ts   工具/资源/提示词发现与聚合
//   mcp-execute.ts     工具调用执行 + 告警
//   mcp-format.ts      OpenAI 工具格式转换
// 本文件重新导出全部公开 API，保持对外兼容（routes/mcp.ts、ai.ts、index.ts、测试）

import { Logger } from "../utils/error";
import type { MCPServerConfig } from "./mcp-types";

// ========== 重新导出 ==========
export {
  MCP_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  buildMeta,
  CLIENT_INFO,
} from "./mcp-types";
export type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
  MCPToolCall,
  MCPToolResult,
} from "./mcp-types";
export {
  ensureMCPSessionsTable,
  extractOAuthMeta,
  ensureOAuthToken,
  loadSession,
  saveSession,
  clearSession,
} from "./mcp-session";
export {
  mcpRequest,
  isModernError,
  ensureEra,
  ensureLegacySession,
  initializeSession,
} from "./mcp-transport";
export {
  ensureMCPServersTable,
  loadMCPServers,
  loadAllMCPServers,
  saveMCPServers,
  deleteMCPServer,
  updateServerTools,
  updateServerResources,
  updateServerPrompts,
} from "./mcp-store";
export {
  fetchToolsFromServer,
  fetchResourcesFromServer,
  fetchPromptsFromServer,
  getAllMCPTools,
  refreshAllMCPToolsIfStale,
  formatContentResult,
} from "./mcp-discovery";
export { executeToolCalls, sendAlert } from "./mcp-execute";
export { mcpToolsToOpenAI, parseToolCalls } from "./mcp-format";

// ========== subscriptions/listen（2026-07-28 变更通知流） ==========

// 订阅服务器变更通知，收到通知后调用回调函数
// 适用于 DO 中作为后台任务运行
export async function subscribeToListChanges(
  server: MCPServerConfig,
  onNotification: (type: string) => void
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
    };
    if (server.apiKey) headers["Authorization"] = `Bearer ${server.apiKey}`;
    if (server.oauthToken) headers["Authorization"] = `Bearer ${server.oauthToken}`;

    const resp = await fetch(server.url.replace(/\/+$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscriptions/listen",
        params: {
          subscriptions: ["toolsListChanged", "promptsListChanged", "resourcesListChanged"],
        },
      }),
    });

    if (!resp.ok || !resp.body) return;

    // 读取 SSE 流
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // 解析 SSE 事件
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

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
          // 处理变更通知
          if (msg.method === "notifications/tools/list_changed") {
            onNotification("tools");
          } else if (msg.method === "notifications/prompts/list_changed") {
            onNotification("prompts");
          } else if (msg.method === "notifications/resources/list_changed") {
            onNotification("resources");
          }
        } catch {}
      }
    }
  } catch (e: any) {
    Logger.warn("[mcp] subscriptions/listen connection ended", { server: server.name, error: e?.message });
  }
}