// MCP - 工具调用执行
// 从 mcp.ts 拆出：executeToolCall 系列、批量执行、sendAlert

import { Logger } from "../utils/error";
import type { MCPServerConfig, MCPToolCall, MCPToolResult } from "./mcp-types";
import { loadMCPServers, loadAllMCPServers } from "./mcp-store";
import { mcpRequest, ensureEra, ensureLegacySession } from "./mcp-transport";
import { clearSession } from "./mcp-session";
import { executeResourceRead, executePromptGet } from "./mcp-discovery";

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
    return await formatToolResult(toolCall, result, server);
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
    return executeToolCallStateless(server, toolCall);
  }

  return await formatToolResult(toolCall, result, server);
}

// 统一格式化工具结果（兼容 2026-07-28 的 resultType/content 结构和旧版结构）
async function formatToolResult(toolCall: MCPToolCall, result?: any, server?: MCPServerConfig): Promise<MCPToolResult> {
  // 处理 Tasks 扩展：服务器返回了异步任务，需要轮询
  if (result?.resultType === "task" && result?.taskId) {
    return pollTask(server, toolCall, result);
  }
  const content = result?.content || [];
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "");
    const structuredParts = content
      .filter((c: any) => c.type === "structured")
      .map((c: any) => JSON.stringify(c.structured || c));
    const text = [...textParts, ...structuredParts].join("\n") || JSON.stringify(content);
    const isError = content.some((c: any) => c.type === "error");
    return { callId: toolCall.callId, name: toolCall.name, content: text, isError: isError || undefined };
  }
  return { callId: toolCall.callId, name: toolCall.name, content: JSON.stringify(result) };
}

// 轮询 Tasks 扩展的异步任务
async function pollTask(server: MCPServerConfig | undefined, toolCall: MCPToolCall, taskResult: any): Promise<MCPToolResult> {
  if (!server) return { callId: toolCall.callId, name: toolCall.name, content: "任务轮询缺少服务器配置", isError: true };
  const taskId = taskResult.taskId;
  const pollInterval = taskResult.pollIntervalMs || 1000;
  const maxPolls = 60;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollInterval));
    try {
      const { result, error } = await mcpRequest(
        null as any, // 任务轮询不依赖会话
        { ...server, era: "modern" },
        "tasks/get", { taskId }
      );
      if (error) return { callId: toolCall.callId, name: toolCall.name, content: `任务查询失败: ${JSON.stringify(error)}`, isError: true };
      const status = result?.status || result?.meta?.status;
      if (status === "completed") {
        return formatResultSimple(toolCall, result?.result || result);
      }
      if (status === "failed") {
        return { callId: toolCall.callId, name: toolCall.name, content: `任务失败: ${JSON.stringify(result?.error || result)}`, isError: true };
      }
      if (status === "cancelled") {
        return { callId: toolCall.callId, name: toolCall.name, content: "任务已取消", isError: true };
      }
      if (status === "input_required") {
        return { callId: toolCall.callId, name: toolCall.name, content: `任务需要额外输入: ${JSON.stringify(result?.inputRequests || result)}`, isError: true };
      }
    } catch {
      return { callId: toolCall.callId, name: toolCall.name, content: "任务轮询异常", isError: true };
    }
  }
  return { callId: toolCall.callId, name: toolCall.name, content: "任务超时", isError: true };
}

function formatResultSimple(toolCall: MCPToolCall, result?: any): MCPToolResult {
  const content = result?.content || [];
  if (Array.isArray(content)) {
    const text = content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n") || JSON.stringify(content);
    return { callId: toolCall.callId, name: toolCall.name, content: text };
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
    // 根据 rawName 路由到不同的 MCP 方法
    if (tc.rawName === "read_resource") {
      const uri = tc.arguments?.uri;
      if (!uri) {
        results.push({ callId: tc.callId, name: tc.name, content: "缺少 uri 参数", isError: true });
        continue;
      }
      results.push(await executeResourceRead(db, server, uri, tc.callId));
    } else if (tc.rawName === "get_prompt") {
      const name = tc.arguments?.name;
      if (!name) {
        results.push({ callId: tc.callId, name: tc.name, content: "缺少 name 参数", isError: true });
        continue;
      }
      results.push(await executePromptGet(db, server, name, tc.arguments?.arguments, tc.callId));
    } else {
      const result = await executeToolCall(db, server, tc);
      results.push(result);
    }
  }

  return results;
}

// 通过 MCP 工具发送告警（在工具列表中找 push/notify/alert 类工具）
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