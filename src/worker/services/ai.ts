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

async function callOpenAICompatible(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string | any[] }>;
  maxTokens: number;
  temperature?: number;
}): Promise<string> {
  const url = params.baseUrl.trim().replace(/\/+$/, "");

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
      temperature: params.temperature ?? 0.7,
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

export async function generateImage(
  aiBinding: any,
  prompt: string,
  model?: string,
  provider?: string,
  baseUrl?: string,
  apiKey?: string,
  imageUrl?: string,
  size?: string,
): Promise<Uint8Array | string | null> {
  const imageModel = model || DEFAULT_IMAGE_MODEL;
  const imageSize = size || DEFAULT_IMAGE_SIZE;
  Logger.info("[ai] Generating image", { prompt: prompt.slice(0, 80), model: imageModel, provider: provider || "cloudflare", hasImageRef: !!imageUrl, size: imageSize });

  // 非 Cloudflare 提供商（如 Agnes AI）：POST /v1/images/generations
  // Agnes 要求 response_format 放在 extra_body 中，文生图用 return_base64 或 extra_body.response_format
  // 以图生图：传递 image_url 参数
  if (provider && provider !== "cloudflare" && baseUrl && apiKey) {
    try {
      const { base, version } = parseApiUrl(baseUrl);
      const url = `${base}/${version}/images/generations`;
      const body: any = {
        model: imageModel,
        prompt,
        size: imageSize,
        watermark_enabled: false,
        extra_body: { response_format: "url" },
      };
      // 以图生图：添加 image_url 参数
      if (imageUrl) {
        body.image_url = imageUrl;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        Logger.error("[ai] Image API error", { status: resp.status, body: errBody.slice(0, 200), url });
        let errMsg = `图片生成失败 (HTTP ${resp.status})`;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed?.error?.message || errMsg;
        } catch { errMsg = errBody.slice(0, 100) || errMsg; }
        throw new Error(errMsg);
      }
      const data = await resp.json() as any;
      const item = data?.data?.[0];
      if (item?.url) {
        Logger.info("[ai] Image URL received", { url: item.url.slice(0, 80) });
        return item.url;
      }
      if (item?.b64_json) {
        const binary = atob(item.b64_json);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        Logger.info("[ai] Image Base64 decoded", { size: bytes.length });
        return bytes;
      }
      Logger.warn("[ai] Unexpected image response", { keys: Object.keys(data || {}), dataKeys: data?.data ? Object.keys(data.data) : [] });
      return null;
    } catch (e: any) {
      Logger.error("[ai] Image generation failed", { error: e?.message });
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
      Logger.info("[ai] Video task submitted", { taskId: submitData.task_id, videoId: submitData.video_id, status: submitData.status });

      const taskId = submitData.task_id || submitData.id;
      const videoId = submitData.video_id;
      const url = submitData.remixed_from_video_id; // 极少数情况会同步返回

      if (url) {
        Logger.info("[ai] Video task returned immediate URL", { url: url.slice(0, 80) });
        return { taskId: taskId || `sync_${Date.now()}`, videoId, baseUrl, provider: effectiveProvider, apiKey, model: videoModel, prompt, url };
      }
      if (!taskId && !videoId) {
        Logger.warn("[ai] No task_id or video_id in response", { keys: Object.keys(submitData || {}) });
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
    Logger.warn("[ai] AI binding not available for video");
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
        Logger.info("[ai] Cloudflare video task submitted", { jobId });
        return { taskId: jobId, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt };
      }
    }
    if (response?.result?.video) {
      Logger.info("[ai] Cloudflare video returned immediately", { url: response.result.video.slice(0, 80) });
      return { taskId: `sync_${Date.now()}`, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt, url: response.result.video };
    }
    if (typeof response === "string" && response.startsWith("http")) {
      return { taskId: `sync_${Date.now()}`, baseUrl: `cf://${videoModel}`, provider: "cloudflare", apiKey: "", model: videoModel, prompt, url: response };
    }
    Logger.warn("[ai] Unexpected Cloudflare video response", { keys: Object.keys(response || {}) });
    return null;
  } catch (e: any) {
    Logger.error("[ai] Cloudflare video submit failed", { error: e?.message });
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

  // 非 Cloudflare 提供商（如 Agnes AI）：POST /v1/videos 提交，GET /agnesapi?video_id= 查询
  if (provider && provider !== "cloudflare" && baseUrl && apiKey) {
    try {
      let base = baseUrl.replace(/\/+$/, "");
      base = base.replace(/\/v1\/(chat\/completions|images\/generations|videos?\/generations|videos\/?|videos)$/i, "");
      base = base.replace(/\/v1$/, "");
      const submitUrl = base + "/v1/videos";
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: videoModel, prompt, num_frames: 121, frame_rate: 24 }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        Logger.error("[ai] Video submit failed", { status: resp.status, body: errBody.slice(0, 200) });
        return null;
      }
      const submitData = await resp.json() as any;
      const taskId = submitData.task_id || submitData.id;
      const videoId = submitData.video_id;
      if (submitData.remixed_from_video_id) return submitData.remixed_from_video_id; // 极少数同步返回
      if (!taskId && !videoId) {
        Logger.warn("[ai] No task_id or video_id in response", { keys: Object.keys(submitData || {}) });
        return null;
      }

      // 轮询：优先用 video_id 查询（/agnesapi?video_id=），回退到 /v1/videos/{task_id}
      const statusUrl = videoId ? `${base}/agnesapi?video_id=${encodeURIComponent(videoId)}` : `${base}/v1/videos/${taskId}`;
      Logger.info("[ai] Video task polling", { taskId, videoId, statusUrl });
      for (let i = 0; i < 36; i++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const statusResp = await fetch(statusUrl, { headers: { "Authorization": `Bearer ${apiKey}` } });
          if (!statusResp.ok) continue;
          const statusData = await statusResp.json() as any;
          if (statusData.status === "completed") return statusData.remixed_from_video_id;
          if (statusData.status === "failed") {
            Logger.error("[ai] Video generation failed", { error: statusData.error });
            return null;
          }
        } catch {}
      }
      Logger.error("[ai] Video generation timeout after 3 minutes");
      return null;
    } catch (e: any) {
      Logger.error("[ai] Video generation failed", { error: e?.message });
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
