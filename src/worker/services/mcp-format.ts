// MCP - 工具格式转换与调用解析
// 从 mcp.ts 拆出：mcpToolsToOpenAI / parseToolCalls / 描述构建

import type { MCPToolDefinition, MCPToolCall } from "./mcp-types";

// ========== OpenAI 工具格式转换 ==========

// 根据工具名自动推断工具动作类型，追加语义提示，帮助 AI 在多个工具中正确选择
function inferActionHint(name: string): string | null {
  const n = name.toLowerCase();
  // 详情类：用户说"看第X条/详情/内容"时用
  if (/^(get|read|view|fetch|detail|show|list_memo)$/.test(n)) return "【详情】当用户要看某条记录的完整内容/详情时调用";
  // 搜索类
  if (/^search|^find|^query/.test(n)) return "【搜索】当用户要按关键词/条件查找内容时调用";
  // 列表类
  if (/^list/.test(n)) return "【列表】当用户要查看某类数据的列表/清单时调用";
  // 创建类
  if (/^(create|add|new|insert|post|send|write|import|upload)/.test(n)) return "【创建/发送】当用户要新增记录、发送内容时调用";
  // 更新类
  if (/^(update|edit|modify|change|set|rename|move|merge|restore)/.test(n)) return "【修改】当用户要更新/修改内容时调用";
  // 删除类
  if (/^(delete|remove|trash|clear|deactivate)/.test(n)) return "【删除】当用户要删除/移除内容时调用";
  // 统计类
  if (/^(stats|summary|count|analy|overview)/.test(n)) return "【统计】当用户要看汇总/统计/分析时调用";
  return null;
}

// 从 inputSchema 提取参数说明，追加到描述中，帮助 AI 正确传参
function buildToolDesc(tool: MCPToolDefinition): string {
  // 对常见参数名自动推断格式提示（通用，不针对特定 MCP）
  const FORMAT_HINTS: Record<string, string> = {
    period: "格式: YYYY-MM(月) / YYYY(年) / YYYY-MM-DD(日)",
    date_from: "格式: YYYY-MM-DD，开始日期",
    date_to: "格式: YYYY-MM-DD，结束日期",
    happened_at: "格式: YYYY-MM-DD，交易发生时间",
  };

  let desc = tool.description || "";

  // 追加动作类型提示（帮助 AI 区分列表/详情/创建/删除等）
  const actionHint = inferActionHint(tool.rawName || tool.name);
  if (actionHint) {
    desc = `${desc} ${actionHint}`.trim();
  }

  // 附加参数说明
  const schema = tool.inputSchema?.properties;
  if (schema && typeof schema === "object") {
    const hints: string[] = [];
    for (const [key, prop] of Object.entries(schema) as [string, any][]) {
      const type = prop.type || "string";
      const required = tool.inputSchema?.required?.includes(key) ? "必填" : "可选";
      const enum_ = prop.enum ? `(${prop.enum.join("/")})` : "";
      const paramDesc = prop.description || FORMAT_HINTS[key] || "";
      hints.push(`${key}(${type} ${required}${enum_ ? " " + enum_ : ""})${paramDesc ? " - " + paramDesc : ""}`.trim());
    }
    if (hints.length > 0) {
      desc = `${desc}\n\n参数: ${hints.join(", ")}`;
    }
  }

  return desc;
}

export function mcpToolsToOpenAI(tools: MCPToolDefinition[]): any[] {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: buildToolDesc(t), parameters: t.inputSchema },
  }));
}

// ========== 工具调用解析 ==========

export function parseToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  allTools: MCPToolDefinition[]
): MCPToolCall[] {
  const toolMap = new Map(allTools.map(t => [t.name, t]));

  return toolCalls.map(tc => {
    let args: Record<string, any> = {};
    try { args = JSON.parse(tc.function.arguments); } catch {}

    const toolDef = toolMap.get(tc.function.name);
    return {
      name: tc.function.name,
      arguments: args,
      callId: tc.id,
      rawName: toolDef?.rawName || tc.function.name,
      serverId: toolDef?.serverId || "",
    };
  });
}