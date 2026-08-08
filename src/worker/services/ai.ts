// AI 服务 - 支持 Cloudflare Workers AI + OpenAI 兼容 API

import { Logger } from "../utils/error";
import {
  getContextFromSQLite,
  saveContextToSQLite,
  clearContextSQLite,
  getContextFromD1,
  saveContextToD1,
  clearContextD1,
  buildMessagesWithContext,
  shouldClearContext,
} from "./context";
import {
  loadMCPServers,
  getAllMCPTools,
  mcpToolsToOpenAI,
  parseToolCalls,
  executeToolCalls,
  type MCPServerConfig,
  type MCPToolDefinition,
  type MCPToolResult,
} from "./mcp";

const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot AI），一个微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "始终使用中文回答，不要使用英文。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 200 字以内，除非用户明确要求更长。\n\n" +
  "【重要规则】当你有工具返回的数据时，必须严格按工具返回的实际数值来回答。不要编造、夸大或缩小任何数字。" +
  "如果工具返回的数据中包含总金额、交易笔数、分类等统计信息，直接引用原文，不要自己计算或推断。";

// 从 API baseUrl 中提取 base 和 version，用于构建其他端点
// 例: "https://open.bigmodel.cn/api/paas/v4/chat/completions"
//   → { base: "https://open.bigmodel.cn/api/paas", version: "v4" }
export function parseApiUrl(baseUrl: string): { base: string; version: string } {
  const url = baseUrl.trim().replace(/\/+$/, "");
  const match = url.match(/(.*?)\/(v\d+)\/(chat\/completions|images\/generations|videos?)\/?$/i);
  if (match) {
    return { base: match[1], version: match[2] };
  }
  const vMatch = url.match(/(.*?)\/(v\d+)\/?$/);
  if (vMatch) {
    return { base: vMatch[1], version: vMatch[2] };
  }
  return { base: url, version: "v1" };
}

const QUICK_REPLIES: Record<string, string> = {
  "你好": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "你好啊": "你好呀 👋 我是爪爪 AI，有什么能帮你的吗？",
  "在吗": "在的 👋 有什么能帮你的？",
  "早上好": "早上好 ☀️ 新的一天，有什么需要帮你查的吗？",
  "晚上好": "晚上好 🌙 这么晚还没睡？有什么能帮你的？",
  "谢谢": "不客气 😊",
  "感谢": "应该的，不客气～",
  "再见": "再见！需要的时候再回来找我 👋",
  "拜拜": "拜拜 👋",
  "你是谁": "我是爪爪 ClawBot AI —— 个人微信机器人。",
  "版本": "爪爪 ClawBot AI v2.0",
  "帮助": "我可以帮你：\n1. 回答问题\n2. 陪你聊天\n3. 写文本草稿\n4. 中英互译\n\n直接发送你想问的问题即可。",
};

const COMMANDS: Record<string, string> = {
  "/help": "📖 使用指南\n- 直接发送问题，AI 会回复\n- '重置' 清空对话上下文\n- '关于' 查看机器人信息",
  "/clear": "✅ 已清空对话上下文，我们重新开始吧。",
  "/reset": "✅ 已重置对话，我们重新开始吧。",
  "/about": "🦞 爪爪 ClawBot AI v2.0\n基于 Cloudflare Workers 构建",
};

export function tryQuickReply(text: string): string | null {
  const clean = text.trim().toLowerCase();
  if (COMMANDS[clean]) return COMMANDS[clean];
  if (QUICK_REPLIES[clean]) return QUICK_REPLIES[clean];
  return null;
}

// ========== OpenAI 兼容 API 调用 ==========

// 获取当前日期时间字符串（中国时区 Asia/Shanghai），通用辅助函数
function getCurrentTimeStr(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const weekdayMap: Record<string, string> = { "Sunday": "日", "Monday": "一", "Tuesday": "二", "Wednesday": "三", "Thursday": "四", "Friday": "五", "Saturday": "六" };
  return `${get("year")}年${get("month")}月${get("day")}日 ${get("hour")}:${get("minute")}:${get("second")}（星期${weekdayMap[get("weekday")] || get("weekday")}，中国时区）`;
}

// 内置工具：获取当前日期时间（中国时区 Asia/Shanghai）
const BUILTIN_TOOLS = [{
  type: "function",
  function: {
    name: "get_current_datetime",
    description: "获取当前日期和时间（中国时区 Asia/Shanghai, UTC+8），当用户问到「今天/昨天/明天/上个月/本月/上周/下周」等相对时间时，调用此工具获取准确日期后再回答",
    parameters: { type: "object", properties: {} },
  },
}];

function executeBuiltinTool(toolCall: { id: string; function: { name: string } }): MCPToolResult | null {
  if (toolCall.function.name !== "get_current_datetime") return null;
  const now = new Date();
  const tz = "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const weekdayMap: Record<string, string> = { "Sunday": "日", "Monday": "一", "Tuesday": "二", "Wednesday": "三", "Thursday": "四", "Friday": "五", "Saturday": "六" };
  const dateStr = `${get("year")}年${get("month")}月${get("day")}日`;
  const weekdayStr = weekdayMap[get("weekday")] || get("weekday");
  const timeStr = `${get("hour")}:${get("minute")}:${get("second")}`;
  return { callId: toolCall.id, name: "get_current_datetime", content: `当前日期: ${dateStr}（星期${weekdayStr}），当前时间: ${timeStr}（中国时区）` };
}

// 将工具返回的 JSON 转成自然语言，避免 AI 解析 JSON 时编造数字
function formatToolContent(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;

  try {
    const obj = JSON.parse(trimmed);
    return flattenToText(obj);
  } catch {
    return raw;
  }
}

// 常见字段名翻译，让 AI 更易理解工具返回的数据
const FIELD_LABELS: Record<string, string> = {
  ledger: "账本", scope: "范围", period: "期间", income: "收入", expense: "支出",
  balance: "结余", transaction_count: "交易笔数", total: "总计", top_categories: "主要分类",
  name: "名称", items: "记录", amount: "金额", tx_type: "交易类型", happened_at: "发生时间",
  note: "备注", category_name: "分类", account_name: "账户", sync_id: "记录ID",
  date_from: "开始日期", date_to: "结束日期", category: "分类", account: "账户", q: "关键词", limit: "条数",
  items_total: "总条数", title: "标题", content: "内容", status: "状态", message: "消息",
};

// 把 JSON 对象递归展开成 "key: value" 的易读文本
function flattenToText(value: any, depth = 0): string {
  if (value === null || value === undefined) return "无";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return "无";
    return value.map(v => flattenToText(v, depth + 1)).join("；");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries
      .map(([k, v]) => `${FIELD_LABELS[k] || k}: ${flattenToText(v, depth + 1)}`)
      .join("；");
  }

  return String(value);
}

async function callOpenAICompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string | any[] }>;
  maxTokens: number;
  temperature?: number;
  thinking?: boolean;
  tools?: any[];            // MCP 工具定义（OpenAI 格式）
  mcpServers?: MCPServerConfig[];
  mcpTools?: MCPToolDefinition[];
  db?: D1Database | null;
  maxToolRounds?: number;
}): Promise<string> {
  const url = params.baseUrl.trim().replace(/\/+$/, "");

  const body: any = {
    model: params.model,
    messages: params.messages,
    max_tokens: params.maxTokens,
    temperature: params.temperature ?? 0.7,
  };

  // 开启 Thinking 模式（深度推理）
  if (params.thinking) {
    body.chat_template_kwargs = { enable_thinking: true };
  }

  // 如果有 MCP 工具，附加到请求（加上内置时间工具）
  // 仅当有 MCP 工具时才添加内置工具，避免无工具场景下 AI 只调用时间工具而不回复
  const hasMcpTools = !!(params.tools && params.tools.length > 0);
  const allTools = hasMcpTools ? [...BUILTIN_TOOLS, ...params.tools!] : [];
  const hasTools = allTools.length > 0;
  if (hasTools) {
    body.tools = allTools;
  }

  const maxRounds = params.maxToolRounds ?? 5;
  const mcpTools = params.mcpTools || [];
  const mcpServers = params.mcpServers || [];
  const db = params.db || null;
  // 记录所有工具调用结果，用于兜底回复
  const allToolTexts: string[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: any[] } }> };
    const choice = data.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new Error("API 响应格式异常");
    }

    // 将 AI 回复加入消息列表
    params.messages.push({
      role: "assistant",
      content: message.content || "",
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    } as any);

    // 检查是否有 tool_calls
    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0 || !hasTools) {
      // 没有工具调用，返回最终回复
      return message.content || "";
    }

    // 解析并执行工具调用（内置工具 + MCP 工具）
    const allToolCalls = toolCalls as Array<{ id: string; function: { name: string; arguments: string } }>;
    // 内置工具直接执行，不走 MCP
    const builtinResults: MCPToolResult[] = [];
    const mcpOnlyCalls: typeof allToolCalls = [];
    for (const tc of allToolCalls) {
      const builtin = executeBuiltinTool(tc);
      if (builtin) {
        builtinResults.push(builtin);
      } else {
        mcpOnlyCalls.push(tc);
      }
    }
    const mcpResults = mcpOnlyCalls.length > 0
      ? await executeToolCalls(parseToolCalls(mcpOnlyCalls, mcpTools), db)
      : [];
    const results = [...builtinResults, ...mcpResults];

    // 将工具结果格式化后添加到消息列表（JSON 转自然语言，防止 AI 编造数字）
    for (const result of results) {
      const formatted = formatToolContent(result.content);
      params.messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: formatted,
      } as any);
      // 收集所有非当前时间工具的结果，用于兜底回复
      if (result.name !== "get_current_datetime" && result.content) {
        allToolTexts.push(formatted);
      }
    }

    // 记录工具返回的原始数据，用于诊断
    for (const result of results) {
      Logger.info(`[ai] MCP tool result: ${result.name}`, {
        contentPreview: result.content.slice(0, 800),
        isError: result.isError,
      });
    }

    Logger.info(`[ai] MCP tool round ${round + 1}: ${toolCalls.length} tools called`);

    // 更新 body 中的 messages 以包含新的消息
    body.messages = params.messages;
  }

  // 达到最大轮次限制，返回最后一条助手消息；若为空则用工具结果兜底
  const lastAssistant = [...params.messages].reverse().find(m => m.role === "assistant");
  const lastContent = lastAssistant?.content as string | undefined;
  if (lastContent && lastContent.trim()) {
    return lastContent;
  }
  // 兜底：AI 一直调用工具没生成文本，把工具返回的数据整理成回复
  if (allToolTexts.length > 0) {
    return `根据工具返回的数据：\n${allToolTexts.slice(-3).join("\n")}`;
  }
  return "";
}

// ========== Cloudflare Workers AI 调用 ==========

async function callCloudflareAI(
  aiBinding: any,
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number
): Promise<string> {
  if (!aiBinding) throw new Error("Cloudflare AI binding 未配置");
  const response = await aiBinding.run(model, { messages, max_tokens: maxTokens });
  return typeof response === "string" ? response : response?.response || "";
}

// ========== AI 配置接口 ==========

interface AIConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  maxContextChars?: number;  // 模型上下文窗口（字符数），默认 12000
  thinking?: boolean;
  mcpServers?: MCPServerConfig[];
  db?: D1Database | null;
}

// ========== 带上下文的 AI 调用（微信消息处理）==========

export async function callAIWithContext(
  storage: SqlStorage,
  aiBinding: any,
  userId: string,
  userMessage: string,
  systemPrompt: string,
  aiConfig?: Partial<AIConfig>,
  db?: D1Database
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();

  const quick = tryQuickReply(cleanMsg);
  if (quick) {
    return quick;
  }

  if (shouldClearContext(cleanMsg)) {
    if (db) { await clearContextD1(db, userId); } else { await clearContextSQLite(storage, userId); }
    return "✅ 已清空对话上下文，我们重新开始吧！";
  }

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiConfig?.model || (aiConfig?.provider === "cloudflare" || !aiConfig?.provider ? "@cf/meta/llama-3.2-3b-instruct" : ""),
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
    maxContextChars: aiConfig?.maxContextChars || 12000,
    thinking: aiConfig?.thinking || false,
    mcpServers: aiConfig?.mcpServers || [],
    db: aiConfig?.db || null,
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const context = db ? await getContextFromD1(db, userId) : await getContextFromSQLite(storage, userId);

  // 注入当前日期（通用，不针对特定 MCP），让 AI 正确换算"今天/上个月/本月"等相对时间
  const messages = buildMessagesWithContext(
    `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。\n\n${system}`,
    cleanMsg,
    context,
    config.maxContextChars
  );

  Logger.info(`[ai] Calling AI for ${userId}`, { provider: config.provider, model: config.model });

  let reply = "";
  try {
    if (config.provider !== "cloudflare") {
      // 加载 MCP 工具
      let mcpTools: MCPToolDefinition[] = [];
      let openAITools: any[] = [];
      if (config.mcpServers && config.mcpServers.length > 0 && config.db) {
        mcpTools = await getAllMCPTools(config.db);
        openAITools = mcpToolsToOpenAI(mcpTools);
        Logger.info(`[ai] Loaded ${mcpTools.length} MCP tools for ${userId}`);
      }

      reply = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        tools: openAITools.length > 0 ? openAITools : undefined,
        mcpServers: config.mcpServers,
        mcpTools,
        db: config.db,
      });
    } else {
      reply = await callCloudflareAI(aiBinding, config.model, messages, config.maxTokens);
    }
    } catch (e: any) {
    Logger.error(`[ai] AI call failed for ${userId}`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }

  Logger.info(`[ai] AI reply for ${userId}`, { replyLength: reply.length, provider: config.provider });

  // 始终保存上下文
  const now = Date.now();
  context.messages.push({ role: "user", content: cleanMsg.slice(0, 500), timestamp: now });
  if (reply) {
    context.messages.push({ role: "assistant", content: reply.slice(0, 500), timestamp: now });
  }
  if (context.messages.length > 10) {
    context.messages = context.messages.slice(-10);
  }
  context.lastUpdated = now;
  try {
    if (db) { await saveContextToD1(db, userId, context); } else { await saveContextToSQLite(storage, userId, context); }
  } catch {}

  return (reply || "").slice(0, 700) || "（AI 没有返回内容）";
}

// ========== 无上下文 AI 调用（管理后台测试）==========

export async function callAI(
  aiBinding: any,
  userMessage: string,
  systemPrompt: string,
  aiConfig?: Partial<AIConfig>
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();
  const quick = tryQuickReply(cleanMsg);
  if (quick) return quick;

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiConfig?.model || (aiConfig?.provider === "cloudflare" || !aiConfig?.provider ? "@cf/meta/llama-3.2-3b-instruct" : ""),
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
    thinking: aiConfig?.thinking || false,
    mcpServers: aiConfig?.mcpServers || [],
    db: aiConfig?.db || null,
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  Logger.info(`[ai] Calling AI (no context)`, { provider: config.provider, model: config.model });

  try {
    let text = "";
    if (config.provider !== "cloudflare") {
      // 加载 MCP 工具
      let mcpTools: MCPToolDefinition[] = [];
      let openAITools: any[] = [];
      if (config.mcpServers && config.mcpServers.length > 0 && config.db) {
        mcpTools = await getAllMCPTools(config.db);
        openAITools = mcpToolsToOpenAI(mcpTools);
        Logger.info(`[ai] Loaded ${mcpTools.length} MCP tools (no context)`);
      }

      text = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: [
          { role: "system", content: `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。\n\n${system}` },
          { role: "user", content: cleanMsg },
        ],
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        tools: openAITools.length > 0 ? openAITools : undefined,
        mcpServers: config.mcpServers,
        mcpTools,
        db: config.db,
      });
    } else {
      text = await callCloudflareAI(aiBinding, config.model, [
        { role: "system", content: `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。\n\n${system}` },
        { role: "user", content: cleanMsg },
      ], config.maxTokens);
    }

    return (text || "").slice(0, 700) || "（AI 没有返回内容）";
  } catch (e: any) {
    Logger.error(`[ai] AI call failed`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }
}

export function getDefaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}

// ========== 图片/视频生成（使用 /命令 触发）==========

const IMAGE_CMD_PATTERN = /^\/(图片|image)\s*/i;
const VIDEO_CMD_PATTERN = /^\/(视频|video)\s*/i;

export function isImageGenerationRequest(text: string): boolean {
  return IMAGE_CMD_PATTERN.test(text.trim());
}

export function isVideoGenerationRequest(text: string): boolean {
  return VIDEO_CMD_PATTERN.test(text.trim());
}

export function extractMediaPrompt(text: string, type: "image" | "video"): string {
  const pattern = type === "image" ? IMAGE_CMD_PATTERN : VIDEO_CMD_PATTERN;
  const prompt = text.trim().replace(pattern, "").trim();
  return prompt || text.trim();
}

const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.0-fast";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_NUM_FRAMES = 121;
const DEFAULT_FRAME_RATE = 24;

const VALID_IMAGE_SIZES = [
  "1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"
];

function clampToValidSize(w: number, h: number): string {
  const target = w * h;
  let best = VALID_IMAGE_SIZES[0];
  let bestDiff = Infinity;
  for (const s of VALID_IMAGE_SIZES) {
    const [sw, sh] = s.split("x").map(Number);
    const diff = Math.abs(sw * sh - target);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  }
  return best;
}

/** 从用户文本中解析图片尺寸，如 "/图片 512x512 赛博朋克" */
export function extractImageSize(text: string): string | undefined {
  const sizeMatch = text.match(/(\d{2,4})\s*[x×*]\s*(\d{2,4})/i);
  if (sizeMatch) {
    return clampToValidSize(parseInt(sizeMatch[1]), parseInt(sizeMatch[2]));
  }
  if (/正方形|方形/.test(text)) return "1024x1024";
  if (/横版|宽屏|宽幅/.test(text)) return "1440x720";
  if (/竖版|竖屏|手机/.test(text)) return "720x1440";
  if (/高清|大图/.test(text)) return "1344x768";
  if (/缩略|小图|小/.test(text)) return "768x1344";
  return undefined;
}

/** 从用户文本中解析视频时长（秒），如 "/视频 10秒 赛博朋克" */
export function extractVideoDuration(text: string): { numFrames: number; frameRate: number } | undefined {
  // 匹配数字+秒/s
  const durationMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|second)/i);
  if (durationMatch) {
    const seconds = Math.min(Math.max(parseFloat(durationMatch[1]), 1), 30);
    const fps = 24;
    return { numFrames: Math.round(seconds * fps), frameRate: fps };
  }
  // 中文关键词
  if (/长一点|长视频/.test(text)) return { numFrames: 24 * 8, frameRate: 24 };
  if (/短一点|短视频/.test(text)) return { numFrames: 24 * 3, frameRate: 24 };
  if (/超长/.test(text)) return { numFrames: 24 * 15, frameRate: 24 };
  return undefined;
}

/** 从用户文本中提取 URL */
export function extractUrl(text: string): string | undefined {
  const urlMatch = text.match(/(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/i);
  return urlMatch ? urlMatch[1] : undefined;
}

/** 从任意格式的响应中提取图片字节数据，兼容所有 AI 模型的返回格式 */
async function extractImageFromAny(response: any): Promise<Uint8Array | null> {
  // 1. 已经是 Uint8Array
  if (response instanceof Uint8Array) return response;

  // 2. ArrayBuffer
  if (response instanceof ArrayBuffer) return new Uint8Array(response);

  // 3. ReadableStream（流式响应，如 flux-1-schnell）
  if (response instanceof ReadableStream) {
    const reader = response.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  // 4. Response 对象（有 body）
  if (response instanceof Response) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > 0) return new Uint8Array(buf);
  }

  // 5. 有 body 属性（可能是 Response-like）
  if (response?.body instanceof ReadableStream) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }

  // 6. 对象类型：递归查找图片数据
  if (response && typeof response === "object") {
    // 检查常见属性名
    const IMAGE_KEYS = ["image", "data", "b64_json", "url", "content", "output", "result"];
    for (const key of IMAGE_KEYS) {
      const val = response[key];
      if (!val) continue;

      // { image: "data:image/...;base64,xxx" }
      if (typeof val === "string") {
        const bytes = decodeImageString(val);
        if (bytes) return bytes;
      }
      // { images: ["base64..."] } 或 { data: [{ b64_json: "..." }] }
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (typeof first === "string") {
          const bytes = decodeImageString(first);
          if (bytes) return bytes;
        }
        if (first?.b64_json) {
          const bytes = decodeBase64(first.b64_json);
          if (bytes) return bytes;
        }
        if (first?.url) {
          const bytes = await fetchImageUrl(first.url);
          if (bytes) return bytes;
        }
      }
      // { data: "base64..." } 直接是字符串
      if (typeof val === "string") {
        const bytes = decodeImageString(val);
        if (bytes) return bytes;
      }
    }

    // 检查嵌套: response.result.image, response.data[0].b64_json
    if (response.result?.image) {
      const val = response.result.image;
      if (typeof val === "string") {
        const bytes = decodeImageString(val);
        if (bytes) return bytes;
      }
      if (typeof val === "string" && val.startsWith("http")) {
        const bytes = await fetchImageUrl(val);
        if (bytes) return bytes;
      }
    }
    if (response.data?.[0]?.b64_json) {
      const bytes = decodeBase64(response.data[0].b64_json);
      if (bytes) return bytes;
    }
    if (response.data?.[0]?.url) {
      const bytes = await fetchImageUrl(response.data[0].url);
      if (bytes) return bytes;
    }
  }

  // 7. 纯字符串（可能是 base64）
  if (typeof response === "string") {
    const bytes = decodeImageString(response);
    if (bytes) return bytes;
  }

  return null;
}

/** 解码 base64 / data URL 字符串为 Uint8Array */
function decodeImageString(str: string): Uint8Array | null {
  if (!str || typeof str !== "string") return null;
  // data:image/...;base64,xxx
  if (str.startsWith("data:")) {
    const parts = str.split(",");
    if (parts[1]) return decodeBase64(parts[1]);
    return null;
  }
  // 纯 base64（检测常见图片头）
  if (str.startsWith("/9j/") || str.startsWith("iVBOR") || str.startsWith("UklGR")) {
    return decodeBase64(str);
  }
  return null;
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

async function fetchImageUrl(url: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(url);
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
  } catch {}
  return null;
}

// ========== 图片生成 ==========

import { getAdapter, type ProviderResponseConfig } from "./adapters";

export async function generateImage(
  aiBinding: any,
  prompt: string,
  model?: string,
  provider?: string,
  baseUrl?: string,
  apiKey?: string,
  imageUrl?: string,
  size?: string,
  allKeys?: string[],
  maxRetries?: number,
  imageUrls?: string[],
  responseConfig?: ProviderResponseConfig,
): Promise<{ data: Uint8Array | string | null; keyIndex: number }> {
  const imageModel = model || DEFAULT_IMAGE_MODEL;
  const imageSize = size || DEFAULT_IMAGE_SIZE;
  const keys = (allKeys && allKeys.length > 0) ? allKeys : (apiKey ? [apiKey] : []);
  const retries = maxRetries ?? 2;
  const refImages = imageUrls && imageUrls.length > 0 ? imageUrls : (imageUrl ? [imageUrl] : []);
  const adapter = getAdapter(provider || "openai", baseUrl, responseConfig);
  Logger.info("[ai] Generating image", { prompt: prompt.slice(0, 80), model: imageModel, adapter: adapter.id, refImageCount: refImages.length, size: imageSize, keyCount: keys.length });

  if (provider && provider !== "cloudflare" && baseUrl && keys.length > 0 && adapter.image) {
    for (let attempt = 0; attempt <= retries && attempt < keys.length; attempt++) {
      const currentKey = keys[attempt] || keys[0];
      try {
        const { base, version } = parseApiUrl(baseUrl);
        const url = `${base}/${version}/images/generations`;
        const body = adapter.image.buildBody(prompt, imageModel, imageSize, refImages);
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${currentKey}` },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => "");
          Logger.error("[ai] Image API error", { status: resp.status, body: errBody.slice(0, 200), url, attempt });
          if (attempt < retries && attempt < keys.length - 1) continue;
          let errMsg = `图片生成失败 (HTTP ${resp.status})`;
          try {
            const parsed = JSON.parse(errBody);
            errMsg = parsed?.error?.message || errMsg;
          } catch { errMsg = errBody.slice(0, 100) || errMsg; }
          throw new Error(errMsg);
        }
        const data = await resp.json() as any;
        // 用适配器提取图片
        const imageUrl = adapter.image.extractImageUrl(data);
        if (imageUrl) return { data: imageUrl, keyIndex: attempt };
        const base64 = adapter.image.extractImageBase64(data);
        if (base64) {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return { data: bytes, keyIndex: attempt };
        }
        Logger.warn("[ai] Unexpected image response", { keys: Object.keys(data || {}), dataKeys: data?.data ? Object.keys(data.data) : [] });
        return { data: null, keyIndex: attempt };
      } catch (e: any) {
        Logger.error("[ai] Image generation failed", { error: e?.message, attempt });
        if (attempt === Math.min(retries, keys.length - 1)) return { data: null, keyIndex: attempt };
      }
    }
    return { data: null, keyIndex: 0 };
  }

  // Cloudflare Workers AI（无 baseUrl）
  if (!aiBinding) {
    return { data: null, keyIndex: 0 };
  }

  try {
    const cfAdapter = getAdapter("cloudflare");
    const response = await aiBinding.run(imageModel, { prompt });
    Logger.info("[ai] Cloudflare AI response", { type: typeof response, constructor: response?.constructor?.name, keys: Object.keys(response || {}).slice(0, 10) });
    const extracted = await extractImageFromAny(response);
    if (extracted) return { data: extracted, keyIndex: 0 };
    Logger.warn("[ai] Could not extract image from response", { response: JSON.stringify(response).slice(0, 300) });
    return { data: null, keyIndex: 0 };
  } catch (e: any) {
    Logger.error("[ai] Image generation failed", { error: e?.message, model: imageModel, prompt: prompt.slice(0, 50) });
    return { data: null, keyIndex: 0 };
  }
}

// 只提交视频生成任务，不轮询，返回 { taskId, videoId?, baseUrl, provider, apiKey, model, prompt, url? }
// 用于微信消息处理中的异步视频生成：先提交任务，后续由 checkPendingVideos 轮询完成
export async function submitVideoTask(
  aiBinding: any,
  prompt: string,
  model?: string,
  provider?: string,
  baseUrl?: string,
  apiKey?: string,
  numFrames?: number,
  frameRate?: number,
): Promise<{ taskId: string; videoId?: string; baseUrl: string; provider: string; apiKey: string; model: string; prompt: string; url?: string } | null> {
  const videoModel = model || DEFAULT_VIDEO_MODEL;
  const effectiveProvider = provider || "cloudflare";
  const effectiveNumFrames = numFrames || DEFAULT_NUM_FRAMES;
  const effectiveFrameRate = frameRate || DEFAULT_FRAME_RATE;
  Logger.info("[ai] Submitting video task", { prompt: prompt.slice(0, 50), model: videoModel, provider: effectiveProvider, numFrames: effectiveNumFrames, frameRate: effectiveFrameRate });

  // 非 Cloudflare 提供商（如 Agnes AI）：POST /v1/videos，返回 task_id 和 video_id
  // Agnes 查询结果推荐用 GET /agnesapi?video_id=
  if (effectiveProvider !== "cloudflare" && baseUrl && apiKey) {
    try {
      const { base, version } = parseApiUrl(baseUrl);
      // 智谱AI用 /videos/generations，其他提供商用 /videos
      const isZhipu = baseUrl.includes("bigmodel.cn");
      const submitUrl = isZhipu ? `${base}/${version}/videos/generations` : `${base}/${version}/videos`;
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: videoModel, prompt, num_frames: effectiveNumFrames, frame_rate: effectiveFrameRate }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        Logger.error("[ai] Video task submit error", { status: resp.status, body: errBody.slice(0, 200), url: submitUrl });
        return null;
      }
      const submitData = await resp.json() as any;

      const taskId = submitData.task_id || submitData.id;
      const videoId = submitData.video_id;
      const url = submitData.remixed_from_video_id; // 极少数情况会同步返回

      if (url) {
        return { taskId: taskId || `sync_${Date.now()}`, videoId, baseUrl, provider: effectiveProvider, apiKey, model: videoModel, prompt, url };
      }
      if (!taskId && !videoId) {
        return null;
      }
      return { taskId, videoId, baseUrl, provider: effectiveProvider, apiKey, model: videoModel, prompt };
    } catch (e: any) {
      Logger.error("[ai] Video task submit failed", { error: e?.message });
      return null;
    }
  }

  // Cloudflare AI
  if (!aiBinding) {
    return null;
  }
  try {
    const response = await aiBinding.run(videoModel, {
      prompt,
      aspect_ratio: "16:9",
      duration: 5,
      resolution: "720p",
    });

    if (response?.state === "Processing" || response?.state === "Queued") {
      const jobId = response.id || response.job_id;
      if (jobId) {
        return { taskId: jobId, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt };
      }
    }
    if (response?.result?.video) {
      return { taskId: `sync_${Date.now()}`, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt, url: response.result.video };
    }
    if (typeof response === "string" && response.startsWith("http")) {
      return { taskId: `sync_${Date.now()}`, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt, url: response };
    }
    Logger.warn("[ai] Unexpected Cloudflare video response", { keys: Object.keys(response || {}), response: JSON.stringify(response).slice(0, 300) });
    throw new Error(`Cloudflare 视频模型返回了意外的响应格式，可能该模型在当前计划不可用`);
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    Logger.error("[ai] Cloudflare video submit failed", { error: errMsg, stack: e?.stack?.slice(0, 200), model: videoModel });
    // 检测 Cloudflare 特定错误码
    if (errMsg.includes("2021") || errMsg.includes("Invalid User Credentials") || errMsg.includes("not available")) {
      throw new Error(`视频生成失败：Cloudflare 免费计划不支持该视频模型 (${videoModel})，请升级计划或使用其他提供商`);
    }
    throw e;
  }
}
