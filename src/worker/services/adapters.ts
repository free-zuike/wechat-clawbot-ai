// AI 提供商适配器 - 配置驱动，新增提供商只需在 UI 配置路径
import { Logger } from "../utils/error";

// JSON 路径提取工具：从对象中按路径提取值
// "data[0].url" → obj.data[0].url
function getByPath(obj: any, path: string): any {
  if (!path || !obj) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

// ========== 提供商响应格式配置 ==========
export interface ProviderResponseConfig {
  // 图片生成
  imageUrlPath?: string;      // 图片 URL 的 JSON 路径，如 "data[0].url"
  imageBase64Path?: string;   // 图片 base64 的 JSON 路径，如 "data[0].b64_json"
  imageRefParam?: string;     // 参考图参数名，如 "image"
  imageRefLocation?: string;  // 参考图参数位置："top_level" 或 "extra_body"
  imageExtraBody?: Record<string, any>;  // 额外的 extra_body 字段

  // 视频提交
  videoSubmitIdPath?: string;    // 任务 ID 的 JSON 路径，如 "task_id"
  videoSubmitUrlPath?: string;   // 同步视频 URL 的 JSON 路径
  videoSubmitPath?: string;      // 视频提交 API 路径后缀（如 "/videos/generations"，空则用默认）
  videoSubmitBody?: Record<string, any>;  // 额外的提交 body 字段

  // 视频状态查询
  videoCheckPath?: string;       // 状态查询路径模板，含 {taskId} 占位符，如 "/agnesapi?video_id={taskId}"
  videoCheckUrlPath?: string;    // 视频 URL 的 JSON 路径
  videoCheckStatusPath?: string; // 状态字段的 JSON 路径
  videoCheckCompleted?: string;  // "已完成" 的状态值
  videoCheckProcessing?: string; // "处理中" 的状态值
  videoCheckFailed?: string;     // "失败" 的状态值
}

// ========== 通用可配置适配器 ==========
function createGenericImageAdapter(config: ProviderResponseConfig) {
  const imageUrlPath = config.imageUrlPath || "data[0].url";
  const imageBase64Path = config.imageBase64Path || "data[0].b64_json";
  const refParam = config.imageRefParam || "image";
  const refLoc = config.imageRefLocation || "extra_body";

  return {
    buildBody(prompt: string, model: string, size: string, refImages: string[]): any {
      const body: any = { model, prompt, size };
      // extra_body 配置
      if (!body.extra_body) body.extra_body = {};
      body.extra_body.response_format = "url";
      if (config.imageExtraBody) {
        Object.assign(body.extra_body, config.imageExtraBody);
      }
      // 参考图
      if (refImages.length > 0) {
        if (refLoc === "extra_body") {
          body.extra_body[refParam] = refImages;
        } else {
          body[refParam] = refImages.length === 1 ? refImages[0] : refImages;
        }
      }
      return body;
    },
    extractImageUrl(response: any): string | null {
      return getByPath(response, imageUrlPath) || null;
    },
    extractImageBase64(response: any): string | null {
      return getByPath(response, imageBase64Path) || null;
    },
  };
}

function createGenericVideoAdapter(config: ProviderResponseConfig) {
  const submitIdPath = config.videoSubmitIdPath || "task_id";
  const submitUrlPath = config.videoSubmitUrlPath || "data[0].url";
  const checkPathTemplate = config.videoCheckPath || "";
  const checkUrlPath = config.videoCheckUrlPath || "data[0].url";
  const checkStatusPath = config.videoCheckStatusPath || "status";
  const completedVal = config.videoCheckCompleted || "SUCCESS";
  const processingVal = config.videoCheckProcessing || "PROCESSING";
  const failedVal = config.videoCheckFailed || "FAIL";

  return {
    buildSubmitBody(prompt: string, model: string, params?: { numFrames?: number; frameRate?: number }) {
      const body: any = { model, prompt };
      if (config.videoSubmitBody) Object.assign(body, config.videoSubmitBody);
      const pathSuffix = config.videoSubmitPath || "";
      return { url: pathSuffix, body };
    },
    extractTaskId(response: any): string | null {
      return getByPath(response, submitIdPath) || null;
    },
    extractVideoUrl(response: any): string | null {
      return getByPath(response, submitUrlPath) || null;
    },
    buildCheckRequest(taskId: string, baseUrl: string, apiKey: string) {
      const { base, version } = parseUrl(baseUrl);
      let url: string;
      if (checkPathTemplate) {
        url = base + checkPathTemplate.replace("{taskId}", taskId);
      } else {
        url = `${base}/${version}/videos/${taskId}`;
      }
      return { url, headers: { Authorization: `Bearer ${apiKey}` } };
    },
    extractVideoFromStatus(response: any): string | null {
      return getByPath(response, checkUrlPath) || null;
    },
    extractStatus(response: any): "completed" | "processing" | "failed" | null {
      const val = getByPath(response, checkStatusPath);
      if (val === completedVal || val === "completed") return "completed";
      if (val === processingVal || val === "processing") return "processing";
      if (val === failedVal || val === "failed") return "failed";
      return null;
    },
  };
}

// ========== 预置适配器（特殊格式） ==========

const agnesImage = {
  buildBody(prompt: string, model: string, size: string, refImages: string[]) {
    const body: any = { model, prompt, size };
    body.extra_body = { response_format: "url" };
    if (refImages.length > 0) body.extra_body.image = refImages;
    return body;
  },
  extractImageUrl(response: any) { return response?.data?.[0]?.url || null; },
  extractImageBase64(response: any) { return response?.data?.[0]?.b64_json || null; },
};

const zhipuImage = { ...agnesImage };

const zhipuVideo = {
  buildSubmitBody(prompt: string, model: string) {
    return { url: "/videos/generations", body: { model, prompt } };
  },
  extractTaskId(response: any) { return response?.task_id || response?.id || null; },
  extractVideoUrl(response: any) { return response?.video_result?.[0]?.url || null; },
  buildCheckRequest(taskId: string, baseUrl: string, apiKey: string) {
    const { base, version } = parseUrl(baseUrl);
    return { url: `${base}/${version}/async-result/${taskId}`, headers: { Authorization: `Bearer ${apiKey}` } };
  },
  extractVideoFromStatus(response: any) { return response?.video_result?.[0]?.url || null; },
  extractStatus(response: any) {
    const s = response?.task_status;
    if (s === "SUCCESS") return "completed";
    if (s === "PROCESSING") return "processing";
    if (s === "FAIL") return "failed";
    return null;
  },
};

const agnesVideo = {
  buildSubmitBody(prompt: string, model: string) {
    return { url: "", body: { model, prompt } };
  },
  extractTaskId(response: any) { return response?.task_id || response?.data?.[0]?.task_id || null; },
  extractVideoUrl(response: any) { return response?.data?.[0]?.url || null; },
  buildCheckRequest(taskId: string, baseUrl: string, apiKey: string) {
    const { base } = parseUrl(baseUrl);
    return { url: `${base}/agnesapi?video_id=${taskId}`, headers: { Authorization: `Bearer ${apiKey}` } };
  },
  extractVideoFromStatus(response: any) { return response?.remixed_from_video_id?.url || response?.data?.[0]?.url || null; },
  extractStatus(response: any) {
    const s = response?.status || response?.task_status;
    if (s === "SUCCESS" || s === "completed") return "completed";
    if (s === "PROCESSING" || s === "pending") return "processing";
    if (s === "FAIL" || s === "failed") return "failed";
    return null;
  },
};

const cloudflareImage = {
  buildBody(prompt: string) { return { prompt }; },
  extractImageUrl(_r: any) { return null; },
  extractImageBase64(response: any) { return response?.image || null; },
};

// ========== 工具函数 ==========
function parseUrl(baseUrl: string): { base: string; version: string } {
  const url = baseUrl.trim().replace(/\/+$/, "");
  const versionMatch = url.match(/\/(v\d+)\//);
  const version = versionMatch ? versionMatch[1] : "v1";
  const base = url.replace(/\/(v\d+)(\/.*)?$/, "");
  return { base, version };
}

function detectProvider(baseUrl: string): string {
  if (baseUrl.includes("bigmodel.cn")) return "zhipu";
  if (baseUrl.includes("agnes-ai.com") || baseUrl.includes("agnes")) return "agnes";
  return "generic";
}

// ========== 适配器获取 ==========
export type ProviderAdapter = {
  id: string;
  image?: {
    buildBody(prompt: string, model: string, size: string, refImages: string[]): any;
    extractImageUrl(response: any): string | null;
    extractImageBase64(response: any): string | null;
  };
  video?: {
    buildSubmitBody(prompt: string, model: string, params?: any): { url: string; body: any };
    extractTaskId(response: any): string | null;
    extractVideoUrl(response: any): string | null;
    buildCheckRequest(taskId: string, baseUrl: string, apiKey: string): { url: string; headers?: Record<string, string> };
    extractVideoFromStatus(response: any): string | null;
    extractStatus(response: any): "completed" | "processing" | "failed" | null;
  };
};

// 预置适配器注册表
const builtinAdapters: Record<string, Partial<ProviderAdapter>> = {
  agnes: { image: agnesImage, video: agnesVideo },
  zhipu: { image: zhipuImage, video: zhipuVideo },
  cloudflare: { image: cloudflareImage },
};

// 获取适配器：预置 > 配置 > 通用
export function getAdapter(providerId: string, baseUrl?: string, responseConfig?: ProviderResponseConfig): ProviderAdapter {
  // 1. 预置适配器（Agnes、智谱等特殊格式）
  if (builtinAdapters[providerId]) {
    return { id: providerId, ...builtinAdapters[providerId] };
  }
  // 2. 用户配置的响应格式（从 UI 配置读取）
  if (responseConfig && (responseConfig.imageUrlPath || responseConfig.videoSubmitIdPath)) {
    return {
      id: providerId,
      image: responseConfig.imageUrlPath ? createGenericImageAdapter(responseConfig) : undefined,
      video: responseConfig.videoSubmitIdPath ? createGenericVideoAdapter(responseConfig) : undefined,
    };
  }
  // 3. 根据 baseUrl 自动检测
  if (baseUrl) {
    const detected = detectProvider(baseUrl);
    if (builtinAdapters[detected]) {
      return { id: detected, ...builtinAdapters[detected] };
    }
  }
  // 4. 通用 OpenAI 兼容
  return {
    id: providerId,
    image: createGenericImageAdapter({ imageUrlPath: "data[0].url", imageBase64Path: "data[0].b64_json" }),
    video: undefined,
  };
}

export { parseUrl as parseApiUrl };
