// AI 提供商适配器 - 每个提供商的请求/响应格式定义
// 新增提供商只需添加 adapter，不改已有代码

export interface ProviderAdapter {
  id: string;
  name: string;

  // 图片生成
  image?: {
    // 构建请求体
    buildBody(prompt: string, model: string, size: string, refImages: string[]): any;
    // 从响应中提取图片 URL
    extractImageUrl(response: any): string | null;
    // 从响应中提取 base64
    extractImageBase64(response: any): string | null;
  };

  // 视频提交
  video?: {
    // 构建提交请求体
    buildSubmitBody(prompt: string, model: string, params?: { numFrames?: number; frameRate?: number }): { url: string; body: any };
    // 从提交响应中提取 taskId
    extractTaskId(response: any): string | null;
    // 从提交响应中提取 videoUrl（同步返回的情况）
    extractVideoUrl(response: any): string | null;
    // 构建状态查询请求
    buildCheckRequest(taskId: string, baseUrl: string, apiKey: string): { url: string; headers?: Record<string, string> };
    // 从状态响应中提取视频 URL
    extractVideoFromStatus(response: any): string | null;
    // 从状态响应中提取状态
    extractStatus(response: any): "completed" | "processing" | "failed" | null;
  };
}

// ========== Agnes AI 适配器 ==========
const agnesImage: ProviderAdapter["image"] = {
  buildBody(prompt, model, size, refImages) {
    const body: any = { model, prompt, size };
    body.extra_body = { response_format: "url" };
    if (refImages.length > 0) {
      body.extra_body.image = refImages;
    }
    return body;
  },
  extractImageUrl(response) {
    return response?.data?.[0]?.url || null;
  },
  extractImageBase64(response) {
    return response?.data?.[0]?.b64_json || null;
  },
};

const agnesVideo: ProviderAdapter["video"] = {
  buildSubmitBody(prompt, model) {
    return { url: "", body: { model, prompt } };
  },
  extractTaskId(response) {
    return response?.task_id || response?.data?.[0]?.task_id || null;
  },
  extractVideoUrl(response) {
    return response?.data?.[0]?.url || null;
  },
  buildCheckRequest(taskId, baseUrl, apiKey) {
    const { base } = parseUrl(baseUrl);
    return { url: `${base}/agnesapi?video_id=${taskId}`, headers: { Authorization: `Bearer ${apiKey}` } };
  },
  extractVideoFromStatus(response) {
    return response?.remixed_from_video_id?.url || response?.data?.[0]?.url || null;
  },
  extractStatus(response) {
    const status = response?.status || response?.task_status;
    if (status === "SUCCESS" || status === "completed") return "completed";
    if (status === "PROCESSING" || status === "pending") return "processing";
    if (status === "FAIL" || status === "failed") return "failed";
    return null;
  },
};

// ========== 智谱 AI 适配器 ==========
const zhipuImage: ProviderAdapter["image"] = {
  buildBody(prompt, model, size, refImages) {
    const body: any = { model, prompt, size };
    body.extra_body = { response_format: "url" };
    if (refImages.length > 0) {
      body.extra_body.image = refImages;
    }
    return body;
  },
  extractImageUrl(response) {
    return response?.data?.[0]?.url || null;
  },
  extractImageBase64(response) {
    return response?.data?.[0]?.b64_json || null;
  },
};

const zhipuVideo: ProviderAdapter["video"] = {
  buildSubmitBody(prompt, model) {
    return { url: "", body: { model, prompt } };
  },
  extractTaskId(response) {
    return response?.task_id || response?.id || null;
  },
  extractVideoUrl(response) {
    return response?.video_result?.[0]?.url || null;
  },
  buildCheckRequest(taskId, baseUrl, apiKey) {
    const { base, version } = parseUrl(baseUrl);
    return { url: `${base}/${version}/async-result/${taskId}`, headers: { Authorization: `Bearer ${apiKey}` } };
  },
  extractVideoFromStatus(response) {
    return response?.video_result?.[0]?.url || null;
  },
  extractStatus(response) {
    const status = response?.task_status;
    if (status === "SUCCESS") return "completed";
    if (status === "PROCESSING") return "processing";
    if (status === "FAIL") return "failed";
    return null;
  },
};

// ========== 通用 OpenAI 兼容适器 ==========
const openaiImage: ProviderAdapter["image"] = {
  buildBody(prompt, model, size, refImages) {
    const body: any = { model, prompt, size };
    body.extra_body = { response_format: "url" };
    if (refImages.length > 0) {
      body.extra_body.image = refImages;
    }
    return body;
  },
  extractImageUrl(response) {
    return response?.data?.[0]?.url || null;
  },
  extractImageBase64(response) {
    return response?.data?.[0]?.b64_json || null;
  },
};

// ========== Cloudflare Workers AI 适配器 ==========
const cloudflareImage: ProviderAdapter["image"] = {
  buildBody(prompt, model, _size, _refImages) {
    return { prompt };
  },
  extractImageUrl(_response) {
    return null;
  },
  extractImageBase64(response) {
    return response?.image || null;
  },
};

// ========== 工具函数 ==========
function parseUrl(baseUrl: string): { base: string; version: string } {
  // "https://api.xxx.com/v4/chat/completions" → { base: "https://api.xxx.com", version: "v4" }
  const url = baseUrl.trim().replace(/\/+$/, "");
  const versionMatch = url.match(/\/(v\d+)\//);
  const version = versionMatch ? versionMatch[1] : "v1";
  // 移除 /v\d+/ 部分和后续路径
  const base = url.replace(/\/(v\d+)(\/.*)?$/, "");
  return { base, version };
}

// ========== 适配器注册表 ==========
const adapters: Record<string, ProviderAdapter> = {
  agnes: { id: "agnes", name: "Agnes AI", image: agnesImage, video: agnesVideo },
  zhipu: { id: "zhipu", name: "智谱 AI", image: zhipuImage, video: zhipuVideo },
  openai: { id: "openai", name: "OpenAI 兼容", image: openaiImage },
  cloudflare: { id: "cloudflare", name: "Cloudflare Workers AI", image: cloudflareImage },
};

// 根据 baseUrl 自动检测提供商类型
function detectProvider(baseUrl: string): string {
  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (baseUrl.includes("agnes-ai.com") || baseUrl.includes("agnes")) return "agnes";
  if (baseUrl.includes("openai.com")) return "openai";
  return "openai"; // 默认 OpenAI 兼容
}

export function getAdapter(providerId: string, baseUrl?: string): ProviderAdapter {
  // 1. 直接按 ID 查找
  if (adapters[providerId]) return adapters[providerId];
  // 2. 根据 baseUrl 自动检测
  if (baseUrl) {
    const detected = detectProvider(baseUrl);
    if (adapters[detected]) return adapters[detected];
  }
  // 3. 回退到通用 OpenAI 兼容
  return adapters.openai;
}

export { parseUrl as parseApiUrl };
