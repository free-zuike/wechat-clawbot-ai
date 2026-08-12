// 聊天路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply, isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt, generateImage } from "../services/ai";
import { configCache } from "../utils/cache";
import { resolveAIConfig } from "./config";
import type { Env } from "../index";

async function logToDO(env: Env, type: string, prompt: string, result: string, provider: string, model: string, status: string, error?: string) {
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const params = new URLSearchParams({
      t: type, p: prompt.slice(0, 200), r: result.slice(0, 200),
      pv: provider, m: model, s: status, e: error || "", src: "chat",
    });
    await doStub.fetch(new Request(`http://localhost/log-generation?${params}`));
  } catch (e: any) {
    console.error("[chat] logToDO failed:", e?.message);
  }
}

interface ChatResponse {
  reply: string;
  source: "shortcut" | "ai" | "error";
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

  let trimmed = "";
  let aiConfig: ReturnType<typeof resolveAIConfig>;

  try {
    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch (e: unknown) {
      return json({ error: "INVALID_JSON", message: "无法解析请求体" }, 400);
    }

    const rawMessage = body.message;
    if (typeof rawMessage !== "string" || !rawMessage.trim()) {
      return json({ error: "VALIDATION_ERROR", message: "请输入消息内容" }, 400);
    }

    trimmed = rawMessage.trim();
    Logger.info(`[chat][${requestId}] message`, { length: trimmed.length });

    const quick = tryQuickReply(trimmed);
    if (quick) return json({ reply: quick, source: "shortcut" } satisfies ChatResponse);

    // 直接从 KV 读取原始配置（包含真实 apiKey），不与管理后台的掩码配置共享缓存
    let kv: Record<string, unknown> = {};
    try {
      const raw = await env.CLAWBOT_KV.get("clawbot:config");
      if (raw) kv = JSON.parse(raw);
    } catch (e) {
      Logger.warn("[chat] config read failed", { error: (e as Error).message });
    }
    // 清理可能存在的掩码值（兼容旧数据）
    try {
      if (Array.isArray(kv.aiPresets)) {
        kv.aiPresets = (kv.aiPresets as any[]).map(p => ({
          ...p,
          apiKey: typeof p.apiKey === "string" && p.apiKey.includes("***") ? "" : p.apiKey
        }));
      }
      if (typeof kv.aiApiKey === "string" && kv.aiApiKey.includes("***")) {
        kv.aiApiKey = "";
      }
    } catch (_) {}

    aiConfig = resolveAIConfig(kv);
    const systemPrompt = (kv.aiSystemPrompt as string) || "";

    // 从预设中读取图片/视频模型
    const presets = (kv.aiPresets as any[]) || [];
    const activePreset = presets.find((p: any) => p.id === aiConfig.provider);
    const imageModel = activePreset?.imageModel || "";
    const videoModel = activePreset?.videoModel || "";
    const allKeys = aiConfig.allKeys || [];
    const maxRetries = aiConfig.maxRetries || 2;
    const customProviders = (kv.aiCustomProviders as any[]) || [];
    const foundProvider = customProviders.find((p: any) => p.id === aiConfig.provider);
    const providerDisplayName = foundProvider?.name || aiConfig.provider;
    const modelInfo = `${providerDisplayName} · `;

    // 检查图片/视频生成请求
    if (isImageGenerationRequest(trimmed) || isVideoGenerationRequest(trimmed)) {
      const isVideo = isVideoGenerationRequest(trimmed);
      const prompt = extractMediaPrompt(trimmed, isVideo ? "video" : "image");
      const modelUsed = isVideo ? videoModel : imageModel;
      Logger.info(`[chat][${requestId}] ${isVideo ? "video" : "image"} generation`, { prompt: prompt.slice(0, 50), model: modelUsed });

      if (isVideo) {
        // 视频生成慢，走 Queue 异步处理
        try {
          await env.CLAWBOT_QUEUE.send({
            type: "video_generation",
            prompt,
            model: videoModel,
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl,
            apiKey: aiConfig.apiKey,
            source: "chat",
            allKeys,
            maxRetries,
          }, { delaySeconds: 0 });
          Logger.info(`[chat][${requestId}] Video task queued`);
        } catch (e: any) {
          Logger.error(`[chat][${requestId}] Queue send failed`, { error: e?.message });
          return json({ reply: `❌ 视频任务提交失败: ${e?.message}`, source: "error" } satisfies ChatResponse);
        }
        return json({ reply: `🎬 ${modelInfo}${videoModel}\n\n视频已加入生成队列（约 1-2 分钟），生成完成后会自动推送。`, source: "ai" } satisfies ChatResponse);
      } else {
        // 图片也走 Queue 异步处理，避免 Worker 超时
        // 如果 prompt 包含搜索意图，先搜图片获取参考 URL
        let imageUrl: string | undefined;
        let imageUrls: string[] | undefined;
        let finalPrompt = prompt;
        if (/搜索|搜|查找|找|的图|的照片|照片/.test(prompt)) {
          try {
            const searchKeywords = prompt.replace(/搜索|搜|查找|找|的图|的照片|照片|生成图片|生成|图片/g, "").trim();
            if (searchKeywords) {
              const searchResp = await fetch(`https://image.so.com/j?q=${encodeURIComponent(searchKeywords)}&sn=5`, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  "Accept": "application/json",
                  "Referer": "https://image.so.com/",
                },
              });
              const searchData = await searchResp.json() as any;
              if (searchData.list && searchData.list.length > 0) {
                // 随机选一张图作为参考（避免每次都用第一张）
                const validItems = searchData.list.filter((item: any) => item.img);
                const randomItem = validItems[Math.floor(Math.random() * Math.min(validItems.length, 5))];
                if (randomItem) {
                  imageUrl = randomItem.img;
                  imageUrls = [imageUrl];
                  finalPrompt = prompt;
                  Logger.info(`[chat][${requestId}] Found reference image for generation`, { prompt: finalPrompt.slice(0, 50) });
                }
              }
            }
          } catch (e: any) {
            Logger.error(`[chat][${requestId}] Image search failed`, { error: e?.message });
          }
        }
        try {
          await env.CLAWBOT_QUEUE.send({
            type: "image_generation",
            prompt: finalPrompt,
            model: imageModel,
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl,
            apiKey: aiConfig.apiKey,
            source: "chat",
            allKeys,
            maxRetries,
            imageUrl,
            imageUrls,
            responseConfig: (aiConfig as any).responseConfig || {},
          }, { delaySeconds: 0 });
          Logger.info(`[chat][${requestId}] Image task queued`);
        } catch (e: any) {
          Logger.error(`[chat][${requestId}] Queue send failed`, { error: e?.message });
          return json({ reply: `❌ 图片任务提交失败: ${e?.message}`, source: "error" } satisfies ChatResponse);
        }
        return json({ reply: `🎨 ${modelInfo}${imageModel}\n\n图片已加入生成队列，生成完成后会自动推送。`, source: "ai" } satisfies ChatResponse);
      }
    }

    Logger.info(`[chat][${requestId}] provider`, { provider: aiConfig.provider, model: aiConfig.model || "default" });

    // 加载 MCP 服务器配置
    let mcpServers: any[] = [];
    try {
      const { loadAllMCPServers } = await import("../services/mcp");
      mcpServers = (await loadAllMCPServers(env.DB)).filter((s: any) => s.enabled);
    } catch (_e) {}

    const reply = await callAI(env.AI, trimmed, systemPrompt, {
      provider: aiConfig.provider,
      model: aiConfig.model,
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      maxTokens: aiConfig.maxTokens,
      maxContextChars: aiConfig.maxContextChars,
      newsnowBaseUrl: (kv.newsnowBaseUrl as string) || "",
      searchBaseUrl: (kv.searchBaseUrl as string) || "",
      searchToken: (kv.searchToken as string) || "",
      thinking: aiConfig.thinking,
      mcpServers,
      db: env.DB,
      aiBinding: env.AI,
      mediaProvider: aiConfig.provider,
      mediaModel: imageModel || aiConfig.model,
      mediaBaseUrl: aiConfig.baseUrl,
      mediaApiKey: aiConfig.apiKey,
      mediaAllKeys: aiConfig.allKeys,
      mediaMaxRetries: aiConfig.maxRetries,
      mediaResponseConfig: aiConfig.responseConfig,
    });

    Logger.info(`[chat][${requestId}] reply`, { length: reply.length });
    await logToDO(env, "text", trimmed, reply.slice(0, 500), aiConfig.provider, aiConfig.model || "default", "success");
    return json({ reply, source: "ai" } satisfies ChatResponse);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`[chat][${requestId}] error`, { error: msg });
    await logToDO(env, "text", trimmed, "", aiConfig.provider || "unknown", aiConfig.model || "default", "failed", msg);
    return json({ reply: "错误: " + msg, source: "error" } satisfies ChatResponse);
  }
}
