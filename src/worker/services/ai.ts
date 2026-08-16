// AI 服务 - OpenAI 兼容 API 调用 + 微信消息 AI 处理
// 纯工具函数见 ai-utils.ts，内置工具见 ai-tools.ts，媒体生成见 ai-media.ts

import { Logger, withRetry } from "../utils/error";
import {
  getContextFromSQLite,
  saveContextToSQLite,
  clearContextSQLite,
  getContextFromD1,
  saveContextToD1,
  clearContextD1,
  buildMessagesWithContext,
  shouldClearContext,
  MAX_CONTEXT_MESSAGES,
} from "./context";
import {
  getAllMCPTools,
  mcpToolsToOpenAI,
  parseToolCalls,
  executeToolCalls,
  type MCPServerConfig,
  type MCPToolDefinition,
  type MCPToolResult,
} from "./mcp";
import {
  getCurrentTimeStr,
  DEFAULT_SYSTEM_PROMPT,
  tryQuickReply,
  isVagueFollowUp,
  parseApiUrl,
} from "./ai-utils";
import {
  BUILTIN_TOOLS,
  executeBuiltinTool,
  formatToolContent,
} from "./ai-tools";

// ========== 重新导出（保持对外 API 兼容：ilink-do.ts / routes / 测试直接 import ./ai）==========
export { parseApiUrl, tryQuickReply, isVagueFollowUp, filterBuiltinTools, DEFAULT_SYSTEM_PROMPT } from "./ai-utils";
export { BUILTIN_TOOLS, executeBuiltinTool, formatToolContent } from "./ai-tools";
export {
  isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt,
  extractImageSize, extractVideoDuration, extractUrl,
  generateImage, submitVideoTask,
} from "./ai-media";
export type { ProviderResponseConfig } from "./adapters";

// ========== OpenAI 兼容 API 调用 ==========

async function callOpenAICompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string | any[] }>;
  maxTokens: number;
  temperature?: number;
  thinking?: boolean;
  tools?: any[];
  mcpServers?: MCPServerConfig[];
  mcpTools?: MCPToolDefinition[];
  db?: D1Database | null;
  maxToolRounds?: number;
  newsnowBaseUrl?: string;
  searchBaseUrl?: string;
  searchToken?: string;
  searchEngine?: string;
  // 媒体生成配置（供 generate_image / generate_video 内置工具使用）
  aiBinding?: any;
  mediaProvider?: string;
  mediaModel?: string;
  mediaBaseUrl?: string;
  mediaApiKey?: string;
  mediaAllKeys?: string[];
  mediaMaxRetries?: number;
  mediaResponseConfig?: any;
  // 浏览器绑定（用于搜索兜底，Cloudflare Browser Run）
  browserBinding?: any;
}): Promise<{ reply: string; toolResults: string[] }> {
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

  // 内置工具：只在对应服务已配置时注册
  const allTools = [...BUILTIN_TOOLS, ...(params.tools || [])];
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
    // 单次请求：网络错误 / 429 / 5xx 重试 2 次（指数退避），4xx 参数错误不重试
    const resp = await withRetry(
      async () => {
        let r: Response;
        try {
          r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${params.apiKey}`,
            },
            body: JSON.stringify(body),
          });
        } catch (e: any) {
          throw Object.assign(new Error(`网络错误: ${e?.message || "fetch failed"}`), { retryable: true });
        }
        if (r.status === 429 || r.status >= 500) {
          const errBody = await r.text().catch(() => "");
          throw Object.assign(new Error(`API ${r.status}: ${errBody.slice(0, 200)}`), { retryable: true });
        }
        if (!r.ok) {
          const errBody = await r.text().catch(() => "");
          throw Object.assign(new Error(`API ${r.status}: ${errBody.slice(0, 200)}`), { retryable: false });
        }
        return r;
      },
      {
        retries: 2,
        baseDelayMs: 500,
        maxDelayMs: 2000,
        onRetry: (attempt, error) => Logger.warn(`[ai] Retrying API call (attempt ${attempt})`, { error: error.message }),
        shouldRetry: (e) => (e as any).retryable === true,
      }
    );

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
      return { reply: message.content || "", toolResults: allToolTexts };
    }

    // 解析并执行工具调用（内置工具 + MCP 工具）
    const allToolCalls = toolCalls as Array<{ id: string; function: { name: string; arguments: string } }>;
    // 内置工具直接执行（异步），不走 MCP
    const builtinResults: MCPToolResult[] = [];
    const mcpOnlyCalls: typeof allToolCalls = [];
    for (const tc of allToolCalls) {
      const builtin = await executeBuiltinTool(tc, params.newsnowBaseUrl, params.searchBaseUrl, params.searchToken, {
      aiBinding: params.aiBinding,
      provider: params.mediaProvider || "",
      model: params.mediaModel || "",
      baseUrl: params.mediaBaseUrl || "",
      apiKey: params.mediaApiKey || "",
      allKeys: params.mediaAllKeys || [],
      maxRetries: params.mediaMaxRetries ?? 2,
      responseConfig: params.mediaResponseConfig,
    }, params.browserBinding, params.searchEngine);
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
    return { reply: lastContent, toolResults: allToolTexts };
  }
  // 兜底：AI 一直调用工具没生成文本，把工具返回的数据整理成回复
  if (allToolTexts.length > 0) {
    return { reply: `根据工具返回的数据：\n${allToolTexts.slice(-3).join("\n")}`, toolResults: allToolTexts };
  }
  return { reply: "", toolResults: allToolTexts };
}

// ========== 上下文智能压缩 ==========

// 用 AI 总结旧对话，保留关键语义
async function summarizeMessages(
  messages: Array<{ role: string; content: string; timestamp: number }>,
  config: AIConfig,
): Promise<string | null> {
  try {
    // 构造摘要请求（只包含旧消息，不包含当前用户消息）
    const convText = messages.map(m =>
      `${m.role === "user" ? "用户" : "AI"}: ${m.content.slice(0, 500)}`
    ).join("\n");

    const messagesForSummary = [
      { role: "system" as const, content: "你是对话摘要助手。请用简洁的中文总结以下对话的关键信息：用户问了什么、得到什么关键结论、有哪些重要数据。控制在 200 字以内。直接输出摘要，不要其他内容。" },
      { role: "user" as const, content: convText },
    ];

    const useCloudflareApi = config.provider === "cloudflare"
      && config.mcpServers && config.mcpServers.length > 0
      && config.accountId && config.cfApiToken;
    const baseUrl = useCloudflareApi
      ? `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`
      : config.baseUrl;
    const apiKey = useCloudflareApi ? config.cfApiToken : config.apiKey;

    if (!baseUrl || !apiKey) return null;

    const resp = await fetch(baseUrl.trim().replace(/\/+$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: messagesForSummary,
        max_tokens: 300,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const summary = data?.choices?.[0]?.message?.content;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
    return null;
  } catch (e: any) {
    Logger.warn("[ai] Context summarization failed, using original context", { error: e?.message });
    return null;
  }
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
  maxContextChars?: number;
  newsnowBaseUrl?: string;
  searchBaseUrl?: string;
  searchToken?: string;
  searchEngine?: string;
  thinking?: boolean;
  mcpServers?: MCPServerConfig[];
  db?: D1Database | null;
  // Cloudflare 账号信息（用于 Cloudflare AI 走 OpenAI 兼容 API 以支持工具调用）
  accountId?: string;
  cfApiToken?: string;
  // 媒体生成配置
  aiBinding?: any;
  mediaProvider?: string;
  mediaModel?: string;
  mediaBaseUrl?: string;
  mediaApiKey?: string;
  mediaAllKeys?: string[];
  mediaMaxRetries?: number;
  mediaResponseConfig?: any;
  // 浏览器绑定（用于搜索兜底，Cloudflare Browser Run）
  browserBinding?: any;
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
    maxContextChars: aiConfig?.maxContextChars || 20000,
    newsnowBaseUrl: aiConfig?.newsnowBaseUrl,
    searchBaseUrl: aiConfig?.searchBaseUrl,
    searchToken: aiConfig?.searchToken,
    searchEngine: aiConfig?.searchEngine,
    thinking: aiConfig?.thinking || false,
    mcpServers: aiConfig?.mcpServers || [],
    db: aiConfig?.db || null,
    aiBinding: aiBinding,
    mediaProvider: aiConfig?.mediaProvider,
    mediaModel: aiConfig?.mediaModel,
    mediaBaseUrl: aiConfig?.mediaBaseUrl,
    mediaApiKey: aiConfig?.mediaApiKey,
    mediaAllKeys: aiConfig?.mediaAllKeys,
    mediaMaxRetries: aiConfig?.mediaMaxRetries,
    mediaResponseConfig: aiConfig?.mediaResponseConfig,
    accountId: aiConfig?.accountId,
    cfApiToken: aiConfig?.cfApiToken,
    browserBinding: aiConfig?.browserBinding,
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const context = db ? await getContextFromD1(db, userId) : await getContextFromSQLite(storage, userId);

  // 智能压缩：当上下文超过 70% 限制时，用 AI 总结旧消息，保留语义
  const COMPRESS_THRESHOLD = Math.floor(config.maxContextChars * 0.7);
  const KEEP_RECENT = 4; // 保留最近 4 条消息（2 轮对话）
  let compressed = false;
  if (context.messages.length > KEEP_RECENT + 2) {
    const totalChars = context.messages.reduce((s, m) => s + m.content.length, 0);
    if (totalChars > COMPRESS_THRESHOLD) {
      const oldMsgs = context.messages.slice(0, -KEEP_RECENT);
      const recentMsgs = context.messages.slice(-KEEP_RECENT);
      const summary = await summarizeMessages(oldMsgs, config);
      if (summary) {
        context.messages = [
          { role: "user", content: `[对话历史摘要]\n${summary}`, timestamp: Date.now() },
          ...recentMsgs,
        ];
        if (db) { await saveContextToD1(db, userId, context); } else { await saveContextToSQLite(storage, userId, context); }
        compressed = true;
        Logger.info(`[ai] Context compressed for ${userId}`, { oldCount: oldMsgs.length, summaryLength: summary.length });
      }
    }
  }

  // 检测模糊回指：用户说"列出来"/"是哪一条"等短句时，自动注入上一条回复的上下文
  // 避免 AI 模型无法关联前文，比在 system prompt 里列关键词更可靠
  let augmentedMsg = cleanMsg;
  if (isVagueFollowUp(cleanMsg)) {
    const lastAssistant = [...context.messages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      const topic = lastAssistant.content.replace(/\n+/g, " ");
      augmentedMsg = `[上一条回复提到: ${topic}]\n用户接着说: ${cleanMsg}`;
      Logger.info(`[ai] Augmented follow-up for ${userId}`, { original: cleanMsg, augmented: augmentedMsg.slice(0, 200) });
    }
  }

  // 注入当前日期（通用，不针对特定 MCP），让 AI 正确换算"今天/上个月/本月"等相对时间
  const messages = buildMessagesWithContext(
    `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。当用户问到新闻、时事、热点时，调用 get_news 工具获取中文新闻。当用户问到天气时，调用 get_weather 工具获取实时天气，不要用 web_search 搜天气。当用户说「帮我看看这个链接/访问这个页面」时，调用 fetch_url 工具获取网页内容。**严格按照工具返回的数据回答，只汇报查询的城市，不要编造其他城市的数据。**\n` +
    `注意对话连续性：用户可能会用简短回复（如"列出来"、"展开说说"、"是哪一条"、"具体点"等）来指代上一条回复中提到的内容，你需要根据对话历史理解上下文，不要当成一个独立的新问题。如果用户说"列出来"而上一轮你提到了某类数据，就直接列出那些数据。\n\n` +
    system,
    augmentedMsg,
    context,
    config.maxContextChars
  );

  Logger.info(`[ai] Calling AI for ${userId}`, { provider: config.provider, model: config.model });

  let reply = "";
  let toolResults: string[] = [];
  try {
    // Cloudflare Workers AI binding 不支持 tool calling，有 MCP 工具时走 Cloudflare REST API
    const useCloudflareApi = config.provider === "cloudflare"
      && config.mcpServers && config.mcpServers.length > 0
      && config.accountId && config.cfApiToken;
    if (config.provider !== "cloudflare" || useCloudflareApi) {
      // 加载 MCP 工具
      let mcpTools: MCPToolDefinition[] = [];
      let openAITools: any[] = [];
      if (config.mcpServers && config.mcpServers.length > 0 && config.db) {
        mcpTools = await getAllMCPTools(config.db, false);
        openAITools = mcpToolsToOpenAI(mcpTools);
        Logger.info(`[ai] Loaded ${mcpTools.length} MCP tools for ${userId}`);
      }

      const effectiveBaseUrl = useCloudflareApi
        ? `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`
        : config.baseUrl;
      const effectiveApiKey = useCloudflareApi ? config.cfApiToken : config.apiKey;

      const result = await callOpenAICompatible({
        baseUrl: effectiveBaseUrl,
        apiKey: effectiveApiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        tools: openAITools.length > 0 ? openAITools : undefined,
        mcpServers: config.mcpServers,
        mcpTools,
        db: config.db,
        newsnowBaseUrl: config.newsnowBaseUrl,
        searchBaseUrl: config.searchBaseUrl,
        searchToken: config.searchToken,
        searchEngine: config.searchEngine,
        aiBinding: config.aiBinding,
        mediaProvider: config.mediaProvider,
        mediaModel: config.mediaModel,
        mediaBaseUrl: config.mediaBaseUrl,
        mediaApiKey: config.mediaApiKey,
        mediaAllKeys: config.mediaAllKeys,
        mediaMaxRetries: config.mediaMaxRetries,
        mediaResponseConfig: config.mediaResponseConfig,
        browserBinding: config.browserBinding,
      });
      reply = result.reply;
      toolResults = result.toolResults;
    } else {
      reply = await callCloudflareAI(aiBinding, config.model, messages, config.maxTokens);
    }
  } catch (e: any) {
    Logger.error(`[ai] AI call failed for ${userId}`, { error: e?.message || String(e) });
    return "AI 暂时无法回答，请稍后重试";
  }

  Logger.info(`[ai] AI reply for ${userId}`, { replyLength: reply.length, provider: config.provider });

  // 保存上下文：完整保存 AI 回复 和 工具结果
  const now = Date.now();
  context.messages.push({ role: "user", content: cleanMsg, timestamp: now });
  if (reply) {
    context.messages.push({ role: "assistant", content: reply, timestamp: now });
  }
  // 工具结果作为独立消息保存
  for (const tr of toolResults) {
    context.messages.push({ role: "user", content: `[查询结果] ${tr}`, timestamp: now });
  }
  if (context.messages.length > MAX_CONTEXT_MESSAGES) {
    context.messages = context.messages.slice(-MAX_CONTEXT_MESSAGES);
  }
  if (db) {
    await saveContextToD1(db, userId, context);
  } else {
    await saveContextToSQLite(storage, userId, context);
  }

  return reply;
}

// ========== 无上下文 AI 调用（管理后台测试）==========

export async function callAI(
  aiBinding: any,
  userMessage: string,
  systemPrompt?: string,
  aiConfig?: Partial<AIConfig>
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();

  const quick = tryQuickReply(cleanMsg);
  if (quick) return quick;

  if (shouldClearContext(cleanMsg)) {
    return "✅ 已清空对话上下文，我们重新开始吧！";
  }

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiConfig?.model || (aiConfig?.provider === "cloudflare" || !aiConfig?.provider ? "@cf/meta/llama-3.2-3b-instruct" : ""),
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
    maxContextChars: aiConfig?.maxContextChars || 20000,
    newsnowBaseUrl: aiConfig?.newsnowBaseUrl,
    searchBaseUrl: aiConfig?.searchBaseUrl,
    searchToken: aiConfig?.searchToken,
    searchEngine: aiConfig?.searchEngine,
    thinking: aiConfig?.thinking || false,
    mcpServers: aiConfig?.mcpServers || [],
    db: aiConfig?.db || null,
    aiBinding: aiBinding,
    mediaProvider: aiConfig?.mediaProvider,
    mediaModel: aiConfig?.mediaModel,
    mediaBaseUrl: aiConfig?.mediaBaseUrl,
    mediaApiKey: aiConfig?.mediaApiKey,
    mediaAllKeys: aiConfig?.mediaAllKeys,
    mediaMaxRetries: aiConfig?.mediaMaxRetries,
    mediaResponseConfig: aiConfig?.mediaResponseConfig,
    browserBinding: aiConfig?.browserBinding,
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  Logger.info(`[ai] Calling AI (no context)`, { provider: config.provider, model: config.model });

  try {
    let text = "";
    // Cloudflare Workers AI binding 不支持 tool calling，有 MCP 工具时走 Cloudflare REST API
    const useCloudflareApi = config.provider === "cloudflare"
      && config.mcpServers && config.mcpServers.length > 0
      && config.accountId && config.cfApiToken;
    if (config.provider !== "cloudflare" || useCloudflareApi) {
      // 加载 MCP 工具
      let mcpTools: MCPToolDefinition[] = [];
      let openAITools: any[] = [];
      if (config.mcpServers && config.mcpServers.length > 0 && config.db) {
        mcpTools = await getAllMCPTools(config.db, false);
        openAITools = mcpToolsToOpenAI(mcpTools);
        Logger.info(`[ai] Loaded ${mcpTools.length} MCP tools (no context)`);
      }

      const result = await callOpenAICompatible({
        baseUrl: useCloudflareApi
          ? `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`
          : config.baseUrl,
        apiKey: useCloudflareApi ? config.cfApiToken : config.apiKey,
        model: config.model,
        messages: [
          { role: "system", content: `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。当用户问到新闻、时事、热点时，调用 get_news 工具获取中文新闻。当用户问到天气时，调用 get_weather 工具获取实时天气，不要用 web_search 搜天气。当用户说「帮我看看这个链接/访问这个页面」时，调用 fetch_url 工具获取网页内容。**严格按照工具返回的数据回答，只汇报查询的城市，不要编造其他城市的数据。**\n注意对话连续性：用户可能会用简短回复（如"列出来"、"展开说说"、"是哪一条"、"具体点"等）来指代上一条回复中提到的内容，你需要根据对话历史理解上下文，不要当成一个独立的新问题。如果用户说"列出来"而上一轮你提到了某类数据，就直接列出那些数据。\n\n${system}` },
          { role: "user", content: cleanMsg },
        ],
        maxTokens: config.maxTokens,
        thinking: config.thinking,
        tools: openAITools.length > 0 ? openAITools : undefined,
        mcpServers: config.mcpServers,
        mcpTools,
        db: config.db,
        newsnowBaseUrl: config.newsnowBaseUrl,
        searchBaseUrl: config.searchBaseUrl,
        searchToken: config.searchToken,
        searchEngine: config.searchEngine,
        aiBinding: config.aiBinding,
        mediaProvider: config.mediaProvider,
        mediaModel: config.mediaModel,
        mediaBaseUrl: config.mediaBaseUrl,
        mediaApiKey: config.mediaApiKey,
        mediaAllKeys: config.mediaAllKeys,
        mediaMaxRetries: config.mediaMaxRetries,
        mediaResponseConfig: config.mediaResponseConfig,
        browserBinding: config.browserBinding,
      });
      text = result.reply;
    } else {
      text = await callCloudflareAI(aiBinding, config.model, [
        { role: "system", content: `当前时间: ${getCurrentTimeStr()}。当用户提到"今天/昨天/明天/上个月/本月/下周/几点"等相对时间时，基于以上时间准确换算。当用户问到新闻、时事、热点时，调用 get_news 工具获取中文新闻。当用户问到天气时，调用 get_weather 工具获取实时天气，不要用 web_search 搜天气。当用户说「帮我看看这个链接/访问这个页面」时，调用 fetch_url 工具获取网页内容。**严格按照工具返回的数据回答，只汇报查询的城市，不要编造其他城市的数据。**\n注意对话连续性：用户可能会用简短回复（如"列出来"、"展开说说"、"是哪一条"、"具体点"等）来指代上一条回复中提到的内容，你需要根据对话历史理解上下文，不要当成一个独立的新问题。如果用户说"列出来"而上一轮你提到了某类数据，就直接列出那些数据。\n\n${system}` },
        { role: "user", content: cleanMsg },
      ], config.maxTokens);
    }

    return text || "（AI 没有返回内容）";
  } catch (e: any) {
    Logger.error(`[ai] AI call failed`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }
}

export function getDefaultSystemPrompt(): string {
  return DEFAULT_SYSTEM_PROMPT;
}