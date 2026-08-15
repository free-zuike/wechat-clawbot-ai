// AI 服务 - 图片/视频生成（含 /命令 触发与尺寸解析）
// 从 ai.ts 拆出：图片生成、视频生成、图片字节提取、尺寸/时长解析

import { Logger } from "../utils/error";
import { getAdapter, type ProviderResponseConfig } from "./adapters";
import { parseApiUrl } from "./ai-utils";

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
  // 直接 base64
  return decodeBase64(str);
}

/** 解码 base64 字符串为 Uint8Array（Workers 无 Buffer，手写转换） */
function decodeBase64(b64: string): Uint8Array | null {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 从 URL 下载图片为 Uint8Array */
async function fetchImageUrl(url: string): Promise<Uint8Array | null> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return null;
  return new Uint8Array(await resp.arrayBuffer());
}

// ========== 图片生成 ==========

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
    for (let attempt = 0; attempt <= retries; attempt++) {
      const currentKey = keys[attempt] || keys[0];
      try {
        const { base, version } = parseApiUrl(baseUrl);
        const url = `${base}/${version}/images/generations`;
        const body = adapter.image.buildBody(prompt, imageModel, imageSize, refImages);
        const extraHeaders = (adapter as any).extraHeaders || {};
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${currentKey}`, ...extraHeaders },
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
  imageUrl?: string,  // 可选：以图生视频的参考图片
): Promise<{ taskId: string; videoId?: string; baseUrl: string; provider: string; apiKey: string; model: string; prompt: string; url?: string } | null> {
  const videoModel = model || DEFAULT_VIDEO_MODEL;
  const effectiveProvider = provider || "cloudflare";
  const effectiveNumFrames = numFrames || DEFAULT_NUM_FRAMES;
  const effectiveFrameRate = frameRate || DEFAULT_FRAME_RATE;
  Logger.info("[ai] Submitting video task", { prompt: prompt.slice(0, 50), model: videoModel, provider: effectiveProvider, numFrames: effectiveNumFrames, frameRate: effectiveFrameRate, hasImageUrl: !!imageUrl });

  // 非 Cloudflare 提供商（如 Agnes AI）：POST /v1/videos，返回 task_id 和 video_id
  // Agnes 查询结果推荐用 GET /agnesapi?video_id=
  if (effectiveProvider !== "cloudflare" && baseUrl && apiKey) {
    try {
      const { base, version } = parseApiUrl(baseUrl);
      // 智谱AI用 /videos/generations，其他提供商用 /videos
      const isZhipu = baseUrl.includes("bigmodel.cn");
      const submitUrl = isZhipu ? `${base}/${version}/videos/generations` : `${base}/${version}/videos`;
      const body: Record<string, any> = { model: videoModel, prompt, num_frames: effectiveNumFrames, frame_rate: effectiveFrameRate };
      // 参考图片（部分提供商支持以图生视频）
      if (imageUrl) {
        body.image = imageUrl;
        body.image_url = imageUrl;
      }
      const resp = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify(body),
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