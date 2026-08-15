// iLink DO - AI 配置解析（从 KV 读取 + resolveAIConfig 逻辑）
// 从 ilink-do.ts 的 getConfigCached 拆出：纯解析函数，不依赖 DO 实例状态

// AI 配置（与 ilink-do.ts RuntimeCache.config 结构一致）
export interface AIConfigResult {
  aiSystemPrompt: string;
  aiModel: string;
  aiProvider: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiMaxTokens: number;
  aiMaxContextChars: number;
  aiImageModel: string;
  aiVideoModel: string;
  allKeys: string[];
  aiMaxRetries: number;
  responseConfig: any;
  aiCustomProviders: any[];
  mcpServers: any[];
  newsnowBaseUrl: string;
  searchBaseUrl: string;
  searchToken: string;
  allowlist: string;
  webhook: { enabled: boolean; url: string; title: string; apiKey: string; channels: string[] };
}

// 从 KV 读取配置并解析（无 DO 状态依赖，可独立测试）
export async function loadAIConfigFromKV(
  env: any,
  kv: KVNamespace | null,
): Promise<AIConfigResult> {
  let aiSystemPrompt = env.AI_SYSTEM_PROMPT || "";
  let webhookUrl = "";

  // 确保 MCP 表存在
  try {
    const { ensureMCPServersTable, ensureMCPSessionsTable } = await import("../services/mcp");
    await ensureMCPServersTable(env.DB);
    await ensureMCPSessionsTable(env.DB);
  } catch (_e) {}
  let webhookEnabled = false;
  let webhookTitle = "";
  let webhookApiKey = "";
  let webhookChannels: string[] = [];

  // 从 KV 读配置
  const configRaw = await kv?.get("clawbot:config");
  let kvConfig: Record<string, unknown> = {};
  try {
    if (configRaw) {
      kvConfig = JSON.parse(configRaw);
      // 自动修复旧数据中的掩码密钥（顶层 key 掩码时清空，让下方回退逻辑生效）
      if (typeof kvConfig.aiApiKey === "string" && kvConfig.aiApiKey.includes("***")) {
        kvConfig.aiApiKey = "";
      }
      aiSystemPrompt = aiSystemPrompt || (kvConfig.aiSystemPrompt as string) || "";
      webhookUrl = (kvConfig.webhookUrl as string) || "";
      webhookEnabled = (kvConfig.webhookEnabled as boolean) || false;
      webhookTitle = (kvConfig.webhookTitle as string) || "";
      webhookApiKey = (kvConfig.webhookApiKey as string) || "";
      webhookChannels = (kvConfig.webhookChannels as string[]) || [];
    }
  } catch (_e) {}

  const newsnowBaseUrl = (kvConfig.newsnowBaseUrl as string) || "";
  const searchBaseUrl = (kvConfig.searchBaseUrl as string) || "";
  const searchToken = (kvConfig.searchToken as string) || "";

  // 使用 resolveAIConfig 统一解析 AI 提供商配置（支持 aiPresets）
  const presets = (kvConfig.aiPresets as any[]) || [];
  const activeProvider = (kvConfig.aiProvider as string) || "cloudflare";
  const activePreset = presets.find((p: any) => p.id === activeProvider);

  let aiModel = env.AI_MODEL || "";
  let aiProvider = "cloudflare";
  let aiBaseUrl = "";
  let aiApiKey = "";
  let aiMaxTokens = 1024;
  let aiMaxContextChars = 12000;

  if (activePreset && activeProvider !== "cloudflare") {
    aiProvider = activeProvider;
    aiModel = activePreset.model || aiModel;
    aiBaseUrl = activePreset.baseUrl || "";
    // 自动修复：如果预设 apiKey 是掩码值（含 ***），用顶层字段替代
    aiApiKey = (activePreset.apiKey || "").includes("***") ? ((kvConfig.aiApiKey as string) || "") : (activePreset.apiKey || "");
    aiMaxTokens = activePreset.maxTokens || 1024;
    aiMaxContextChars = activePreset.maxContextChars || 12000;
  } else {
    // cloudflare 或无预设：回退到顶层字段
    aiProvider = activeProvider;
    aiModel = aiModel || (kvConfig.aiModel as string) || "";
    aiBaseUrl = (kvConfig.aiBaseUrl as string) || "";
    aiApiKey = (kvConfig.aiApiKey as string) || "";
    aiMaxTokens = (kvConfig.aiMaxTokens as number) || 1024;
  }

  const aiImageModel = (activePreset?.imageModel as string) || "@cf/black-forest-labs/flux-1-schnell";
  const aiVideoModel = (activePreset?.videoModel as string) || "bytedance/seedance-2.0-fast";

  const backupKeys = ((activePreset?.apiKeys as string[]) || []).filter((k: string) => k && !k.includes("***"));
  const allKeys = [aiApiKey, ...backupKeys].filter(Boolean);
  const aiMaxRetries = (kvConfig.aiMaxRetries as number) || 2;

  const responseConfig = (activePreset?.responseConfig as any) || {};
  // 加载 MCP 服务器配置
  let mcpServers: any[] = [];
  try {
    const { loadAllMCPServers } = await import("../services/mcp");
    mcpServers = (await loadAllMCPServers(env.DB)).filter((s: any) => s.enabled);
  } catch (_e) {}

  return {
    aiSystemPrompt, aiModel, aiProvider, aiBaseUrl, aiApiKey,
    aiMaxTokens, aiMaxContextChars, aiImageModel, aiVideoModel,
    allKeys, aiMaxRetries, responseConfig,
    aiCustomProviders: (kvConfig.aiCustomProviders as any[]) || [],
    mcpServers, newsnowBaseUrl, searchBaseUrl, searchToken,
    allowlist: (kvConfig.allowlist as string) || "",
    webhook: {
      enabled: webhookEnabled, url: webhookUrl, title: webhookTitle,
      apiKey: webhookApiKey, channels: webhookChannels,
    },
  };
}