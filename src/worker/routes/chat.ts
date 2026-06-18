// 聊天路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { callAI, tryQuickReply, isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt, generateImage, generateVideo } from "../services/ai";
import { configCache } from "../utils/cache";
import { resolveAIConfig } from "./config";
import type { Env } from "../index";

interface ChatResponse {
  reply: string;
  source: "shortcut" | "ai" | "error";
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const requestId = crypto.randomUUID().slice(0, 8);
  Logger.info(`[chat][${requestId}] handleChat called`);

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

    const trimmed = rawMessage.trim();
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

    const aiConfig = resolveAIConfig(kv);
    const systemPrompt = (kv.aiSystemPrompt as string) || "";

    // 从预设中读取图片/视频模型
    const presets = (kv.aiPresets as any[]) || [];
    const activePreset = presets.find((p: any) => p.id === aiConfig.provider);
    const imageModel = activePreset?.imageModel || "";
    const videoModel = activePreset?.videoModel || "";
    const modelInfo = `${aiConfig.provider} · `;

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
          }, { delaySeconds: 0 });
          Logger.info(`[chat][${requestId}] Video task queued`, { 
            provider: aiConfig.provider,
            baseUrl: aiConfig.baseUrl.substring(0, 50),
            apiKeyPrefix: aiConfig.apiKey ? aiConfig.apiKey.slice(0, 8) : "EMPTY"
          });
        } catch (e: any) {
          Logger.error(`[chat][${requestId}] Queue send failed`, { error: e?.message });
          return json({ reply: `❌ 视频任务提交失败: ${e?.message}`, source: "error" } satisfies ChatResponse);
        }
        return json({ reply: `🎬 ${modelInfo}${videoModel}\n\n视频已加入生成队列（约 1-2 分钟），生成完成后会自动推送。`, source: "ai" } satisfies ChatResponse);
      } else {
        // 图片生成快，同步处理
        const imageData = await generateImage(env.AI, prompt, imageModel, aiConfig.provider, aiConfig.baseUrl, aiConfig.apiKey);
        if (imageData) {
          if (typeof imageData === "string") {
            return json({ reply: `🎨 ${modelInfo}${imageModel}\n\n图片已生成！\n\n![生成的图片](${imageData})`, source: "ai" } satisfies ChatResponse);
          }
          let base64 = "";
          const chunkSize = 8192;
          for (let i = 0; i < imageData.length; i += chunkSize) {
            base64 += String.fromCharCode(...imageData.slice(i, i + chunkSize));
          }
          base64 = btoa(base64);
          const dataUrl = `data:image/png;base64,${base64}`;
          return json({ reply: `🎨 ${modelInfo}${imageModel}\n\n图片已生成！\n\n![生成的图片](${dataUrl})`, source: "ai" } satisfies ChatResponse);
        }
        return json({ reply: `❌ 图片生成失败 (${modelInfo}${imageModel})\n请稍后重试或换个描述试试`, source: "error" } satisfies ChatResponse);
      }
    }

    Logger.info(`[chat][${requestId}] provider`, { provider: aiConfig.provider, model: aiConfig.model || "default" });

    const reply = await callAI(env.AI, trimmed, systemPrompt, {
      provider: aiConfig.provider,
      model: aiConfig.model,
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      maxTokens: aiConfig.maxTokens,
    });

    Logger.info(`[chat][${requestId}] reply`, { length: reply.length });
    return json({ reply, source: "ai" } satisfies ChatResponse);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Logger.error(`[chat][${requestId}] error`, { error: msg });
    return json({ reply: "错误: " + msg, source: "error" } satisfies ChatResponse);
  }
}
