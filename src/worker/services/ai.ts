// AI 服务 - 支持 Cloudflare Workers AI + OpenAI 兼容 API

import { Logger } from "../utils/error";
import {
  getContextFromSQLite,
  saveContextToSQLite,
  clearContextSQLite,
  buildMessagesWithContext,
  shouldClearContext,
} from "./context";

const DEFAULT_SYSTEM_PROMPT =
  "你是爪爪（ClawBot AI），一个微信机器人助手。" +
  "你的性格友好、简洁、幽默，回答要符合微信阅读习惯，段落清晰，语气亲切。" +
  "始终使用中文回答，不要使用英文。" +
  "如果用户问的问题你不知道，就直接说不知道。不要编造信息。" +
  "回复长度控制在 200 字以内，除非用户明确要求更长。";

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

async function callOpenAICompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
}): Promise<string> {
  let base = params.baseUrl.replace(/\/+$/, "");
  base = base.replace(/\/v1\/(chat\/completions|images\/generations|videos\/generations)$/i, "");
  const url = base + "/v1/chat/completions";

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
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
}

// ========== 带上下文的 AI 调用（微信消息处理）==========

export async function callAIWithContext(
  storage: SqlStorage,
  aiBinding: any,
  userId: string,
  userMessage: string,
  systemPrompt: string,
  aiConfig?: Partial<AIConfig>
): Promise<string> {
  const cleanMsg = (userMessage || "").trim();

  const quick = tryQuickReply(cleanMsg);
  if (quick) {
    Logger.info(`[ai] Quick reply for ${userId}`);
    return quick;
  }

  if (shouldClearContext(cleanMsg)) {
    await clearContextSQLite(storage, userId);
    return "✅ 已清空对话上下文，我们重新开始吧！";
  }

  const config: AIConfig = {
    provider: aiConfig?.provider || "cloudflare",
    model: aiConfig?.model || (aiConfig?.provider === "cloudflare" || !aiConfig?.provider ? "@cf/meta/llama-3.2-3b-instruct" : ""),
    baseUrl: aiConfig?.baseUrl || "",
    apiKey: aiConfig?.apiKey || "",
    maxTokens: aiConfig?.maxTokens || 1024,
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const context = await getContextFromSQLite(storage, userId);
  const messages = buildMessagesWithContext(system, cleanMsg, context);

  Logger.info(`[ai] Calling AI for ${userId}`, { provider: config.provider, model: config.model });

  let reply = "";
  try {
    if (config.provider !== "cloudflare") {
      reply = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens,
      });
    } else {
      reply = await callCloudflareAI(aiBinding, config.model, messages, config.maxTokens);
    }
  } catch (e: any) {
    Logger.error(`[ai] AI call failed for ${userId}`, { error: e?.message || String(e) });
    return `AI调用失败: ${e?.message || String(e)}`;
  }

  Logger.info(`[ai] AI reply for ${userId}`, { replyLength: reply.length, provider: config.provider });

  // 始终保存上下文（即使 AI 未返回内容，也要保存用户消息）
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
    await saveContextToSQLite(storage, userId, context);
    Logger.info(`[ai] Context saved for ${userId}`, { messageCount: context.messages.length });
  } catch (e) {
    Logger.error(`[ai] Context save failed for ${userId}`, { error: (e as Error).message });
  }

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
  };

  if (config.provider !== "cloudflare" && !config.model) {
    return "AI调用失败: 未配置模型名称，请在管理后台设置 AI 模型";
  }

  const system = systemPrompt || DEFAULT_SYSTEM_PROMPT;

  Logger.info(`[ai] Calling AI (no context)`, { provider: config.provider, model: config.model });

  try {
    let text = "";
    if (config.provider !== "cloudflare") {
      text = await callOpenAICompatible({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: cleanMsg },
        ],
        maxTokens: config.maxTokens,
      });
    } else {
      text = await callCloudflareAI(aiBinding, config.model, [
        { role: "system", content: system },
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

// ========== 图片/视频生成（Cloudflare Workers AI）==========

const IMAGE_KEYWORDS = /画|描绘|绘制|生成图片|生成一张|帮我画|给我画|画一个|画一幅|画张|来一张|来幅|draw|generate image|create image/i;
const VIDEO_KEYWORDS = /生成视频|制作视频|做一个视频|帮我做视频|帮我生成视频|录一段|拍一段|成一个视频|做个视频|拍个视频|录个视频|generate video|create video|make a video/i;
const IMAGE_PROMPT_PREFIXES = ["画", "描绘", "绘制", "生成图片", "生成一张", "帮我画", "给我画", "画一个", "画一幅", "画张", "来一张", "来幅"];
const VIDEO_PROMPT_PREFIXES = ["生成视频", "制作视频", "做一个视频", "帮我做视频", "帮我生成视频", "录一段", "拍一段", "成一个视频", "做个视频", "拍个视频", "录个视频"];

export function isImageGenerationRequest(text: string): boolean {
  return IMAGE_KEYWORDS.test(text.trim());
}

export function isVideoGenerationRequest(text: string): boolean {
  return VIDEO_KEYWORDS.test(text.trim());
}

export function extractMediaPrompt(text: string, type: "image" | "video"): string {
  const prefixes = type === "image" ? IMAGE_PROMPT_PREFIXES : VIDEO_PROMPT_PREFIXES;
  let prompt = text.trim();

  // 尝试从开头匹配前缀
  for (const prefix of prefixes) {
    if (prompt.startsWith(prefix)) {
      prompt = prompt.slice(prefix.length).trim();
      break;
    }
  }

  // 如果开头没匹配到，尝试在整段文字中查找并提取前缀后面的内容
  if (prompt === text.trim()) {
    for (const prefix of prefixes) {
      const idx = prompt.indexOf(prefix);
      if (idx !== -1) {
        prompt = prompt.slice(idx + prefix.length).trim();
        break;
      }
    }
  }

  // 移除开头的量词：一个、一幅、一张、一段 等
  prompt = prompt.replace(/^(一个|一幅|一张|一段)/, "").trim();
  // 移除结尾的标点和多余文字
  prompt = prompt.replace(/[。！？.!?,，]+$/, "").trim();
  return prompt || text.trim();
}

const DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.0-fast";

export async function generateImage(
  aiBinding: any,
  prompt: string,
  model?: string,
  provider?: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<Uint8Array | string | null> {
  const imageModel = model || DEFAULT_IMAGE_MODEL;
  Logger.info("[ai] Generating image", { prompt: prompt.slice(0, 80), model: imageModel, provider: provider || "cloudflare" });

  // 非 Cloudflare 提供商：走 OpenAI 兼容 API
  if (provider && provider !== "cloudflare" && baseUrl && apiKey) {
    Logger.info("[ai] Using OpenAI compat for image", { baseUrl: baseUrl.slice(0, 30), apiKeyPrefix: apiKey.slice(0, 6), model: imageModel });
    try {
      let base = baseUrl.replace(/\/+$/, "");
      base = base.replace(/\/v1\/(chat\/completions|images\/generations|videos\/generations)$/i, "");
      const url = base + "/v1/images/generations";
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: imageModel, prompt, n: 1, size: "1024x1024" }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        Logger.error("[ai] Image API error", { status: resp.status, body: errBody.slice(0, 200) });
        return null;
      }
      const data = await resp.json() as any;
      const item = data?.data?.[0];
      if (item?.b64_json) {
        const binary = atob(item.b64_json);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      if (item?.url) {
        // 直接返回 URL，避免下载转换
        Logger.info("[ai] Image URL received", { url: item.url });
        return item.url;
      }
      Logger.warn("[ai] Unexpected image response", { keys: Object.keys(data || {}) });
      return null;
    } catch (e: any) {
      Logger.error("[ai] Image generation failed (OpenAI compat)", { error: e?.message });
      return null;
    }
  }

  // Cloudflare Workers AI
  if (!aiBinding) {
    Logger.warn("[ai] AI binding not available, provider check failed", { provider, hasBaseUrl: !!baseUrl, hasApiKey: !!apiKey });
    return null;
  }

  try {
    const response = await aiBinding.run(imageModel, { prompt });
    Logger.info("[ai] Image model response", { type: typeof response, isArrayBuffer: response instanceof ArrayBuffer, isUint8Array: response instanceof Uint8Array, keys: response && typeof response === "object" ? Object.keys(response) : null });

    if (response instanceof Uint8Array) {
      Logger.info("[ai] Image generated (Uint8Array)", { size: response.length });
      return response;
    }
    if (response instanceof ArrayBuffer) {
      Logger.info("[ai] Image generated (ArrayBuffer)", { size: response.byteLength });
      return new Uint8Array(response);
    }
    if (response?.images?.[0]) {
      const img = response.images[0];
      if (typeof img === "string") {
        const binary = atob(img);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        Logger.info("[ai] Image generated (base64)", { size: bytes.length });
        return bytes;
      }
      return img;
    }
    if (response?.result?.image) {
      const imgUrl = response.result.image;
      Logger.info("[ai] Image generated (URL)", { url: imgUrl });
      // 下载图片
      const resp = await fetch(imgUrl);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        return new Uint8Array(buf);
      }
    }
    Logger.warn("[ai] Unexpected image response format", { response: JSON.stringify(response).slice(0, 200) });
    return null;
  } catch (e: any) {
    Logger.error("[ai] Image generation failed", { error: e?.message, model: imageModel, prompt: prompt.slice(0, 50) });
    return null;
  }
}

export async function generateVideo(
  aiBinding: any,
  prompt: string,
  model?: string,
  provider?: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<string | null> {
  const videoModel = model || DEFAULT_VIDEO_MODEL;
  Logger.info("[ai] Generating video", { prompt: prompt.slice(0, 50), model: videoModel, provider: provider || "cloudflare" });

  // 非 Cloudflare 提供商：走 OpenAI 兼容 API
  if (provider && provider !== "cloudflare" && baseUrl && apiKey) {
    Logger.info("[ai] Using OpenAI compat for video", { baseUrl: baseUrl.slice(0, 30), apiKeyPrefix: apiKey.slice(0, 6), model: videoModel });
    try {
      let base = baseUrl.replace(/\/+$/, "");
      base = base.replace(/\/v1\/(chat\/completions|images\/generations|video\/generations)$/i, "");
      // 提交视频生成任务
      const submitUrl = base + "/v1/video/generations";
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: videoModel, prompt, duration: 5 }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        Logger.error("[ai] Video API error", { status: resp.status, body: errBody.slice(0, 200) });
        return null;
      }
      const submitData = await resp.json() as any;
      const taskId = submitData.task_id || submitData.id;
      if (!taskId) {
        // 同步返回 URL
        if (submitData?.data?.[0]?.url) return submitData.data[0].url;
        if (submitData?.video) return submitData.video;
        Logger.warn("[ai] No task_id in video response", { keys: Object.keys(submitData || {}) });
        return null;
      }

      Logger.info("[ai] Video task submitted", { taskId });
      // 轮询等待完成（最多 180 秒）
      for (let i = 0; i < 36; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const statusUrl = `${base}/v1/video/generations/${taskId}`;
        const statusResp = await fetch(statusUrl, {
          headers: { "Authorization": `Bearer ${apiKey}` },
        });
        if (!statusResp.ok) continue;
        const statusData = await statusResp.json() as any;
        const status = statusData?.data?.status || statusData?.status;
        const progress = statusData?.data?.progress || statusData?.progress || "0%";
        Logger.info("[ai] Video status", { status, progress, attempt: i + 1 });

        if (status === "completed" || status === "COMPLETED" || status === "success" || status === "SUCCESS") {
          // 尝试多种字段获取视频 URL
          const videoUrl = statusData?.data?.remixed_from_video_id
            || statusData?.data?.video_url
            || statusData?.data?.url
            || statusData?.result_url
            || statusData?.video_url;
          if (videoUrl) {
            Logger.info("[ai] Video generated", { url: videoUrl });
            return videoUrl;
          }
        }
        if (status === "failed" || status === "FAILED" || status === "error") {
          Logger.error("[ai] Video generation failed", { error: statusData?.data?.error || statusData?.fail_reason });
          return null;
        }
      }
      Logger.error("[ai] Video generation timeout");
      return null;
    } catch (e: any) {
      Logger.error("[ai] Video generation failed (OpenAI compat)", { error: e?.message });
      return null;
    }
  }

  // Cloudflare Workers AI
  if (!aiBinding) {
    Logger.warn("[ai] AI binding not available for video generation");
    return null;
  }

  try {
    const response = await aiBinding.run(videoModel, {
      prompt,
      aspect_ratio: "16:9",
      duration: 5,
      resolution: "720p",
    });

    // 异步模型：可能返回 state=Processing，需要轮询
    if (response?.state === "Processing" || response?.state === "Queued") {
      const jobId = response.id || response.job_id;
      if (jobId) {
        // 轮询等待完成（最多 120 秒）
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const status = await aiBinding.run(videoModel, { jobId });
          if (status?.state === "Completed" && status?.result?.video) {
            Logger.info("[ai] Video generated", { url: status.result.video });
            return status.result.video;
          }
          if (status?.state === "Failed") {
            Logger.error("[ai] Video generation failed", { error: status.error });
            return null;
          }
        }
        Logger.error("[ai] Video generation timeout");
        return null;
      }
    }

    // 同步返回
    if (response?.result?.video) {
      Logger.info("[ai] Video generated", { url: response.result.video });
      return response.result.video;
    }
    if (typeof response === "string" && response.startsWith("http")) {
      return response;
    }

    Logger.warn("[ai] Unexpected video response format", { keys: Object.keys(response || {}) });
    return null;
  } catch (e: any) {
    Logger.error("[ai] Video generation failed", { error: e?.message, prompt: prompt.slice(0, 50) });
    return null;
  }
}
