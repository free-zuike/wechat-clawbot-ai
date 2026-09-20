// AI 模型列表路由

import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

// Cloudflare Workers AI 已知模型列表（免费/付费标记）
const CLOUDFLARE_MODELS = [
  // 文本生成 - 免费
  { id: "@cf/meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fast", name: "Llama 3.1 8B Fast", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/meta/llama-3.2-3b-instruct", name: "Llama 3.2 3B", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B FP8 Fast", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/qwen/qwen1.5-14b-chat-awq", name: "Qwen 1.5 14B", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/qwen/qwen1.5-7b-chat-awq", name: "Qwen 1.5 7B", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/mistral/mistral-7b-instruct-v0.2", name: "Mistral 7B v0.2", type: "text", tier: "free", provider: "cloudflare" },
  { id: "@cf/tinyllama/tinyllama-1.1b-chat-v1.0", name: "TinyLlama 1.1B", type: "text", tier: "free", provider: "cloudflare" },
  // 文本生成 - 付费
  { id: "@cf/meta/llama-3.1-70b-instruct", name: "Llama 3.1 70B", type: "text", tier: "paid", provider: "cloudflare" },
  { id: "@cf/meta/llama-3.1-405b-instruct-fp16", name: "Llama 3.1 405B FP16", type: "text", tier: "paid", provider: "cloudflare" },
  { id: "@cf/deepseek/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 32B", type: "text", tier: "paid", provider: "cloudflare" },
  // 图片生成 - 免费
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", type: "image", tier: "free", provider: "cloudflare" },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", name: "Stable Diffusion XL", type: "image", tier: "free", provider: "cloudflare" },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", name: "SDXL Lightning", type: "image", tier: "free", provider: "cloudflare" },
  // 图片生成 - 付费
  { id: "@cf/black-forest-labs/flux-1.1-pro", name: "FLUX.1.1 Pro", type: "image", tier: "paid", provider: "cloudflare" },
  // 视频生成 - 付费
  { id: "bytedance/seedance-1.0-lite-720p", name: "Seedance 1.0 Lite", type: "video", tier: "paid", provider: "cloudflare" },
  // 语音识别
  { id: "@cf/openai/whisper", name: "Whisper", type: "speech", tier: "free", provider: "cloudflare" },
  { id: "@cf/openai/whisper-large-v3-turbo", name: "Whisper Large V3 Turbo", type: "speech", tier: "free", provider: "cloudflare" },
  // 嵌入
  { id: "@cf/baai/bge-base-en-v1.5", name: "BGE Base EN v1.5", type: "embedding", tier: "free", provider: "cloudflare" },
  { id: "@cf/baai/bge-large-en-v1.5", name: "BGE Large EN v1.5", type: "embedding", tier: "free", provider: "cloudflare" },
];

// 静态资源列表（Vite 构建产物）用 AGNES_MODELS 时前端展示 Agnes 模型
const AGNES_MODELS = [
  // 文本生成 - 免费
  { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash", type: "text", tier: "free", provider: "agnes-ai" },
  { id: "agnes-2.0-flash", name: "Agnes 2.0 Flash", type: "text", tier: "free", provider: "agnes-ai" },
  { id: "agnes-2.5-pro-beta", name: "Agnes 2.5 Pro Beta", type: "text", tier: "free", provider: "agnes-ai" },
  { id: "agnes-2.5-pro", name: "Agnes 2.5 Pro", type: "text", tier: "free", provider: "agnes-ai" },
  { id: "agnes-3.0-flash", name: "Agnes 3.0 Flash", type: "text", tier: "free", provider: "agnes-ai" },
  // 图片生成 - 免费
  { id: "agnes-image-2.0-flash", name: "Agnes Image 2.0 Flash", type: "image", tier: "free", provider: "agnes-ai" },
  { id: "agnes-image-2.1-flash", name: "Agnes Image 2.1 Flash", type: "image", tier: "free", provider: "agnes-ai" },
  { id: "agnes-image-2.5-flash", name: "Agnes Image 2.5 Flash", type: "image", tier: "free", provider: "agnes-ai" },
  // 视频生成 - 免费
  { id: "agnes-video-v2.0", name: "Agnes Video V2.0", type: "video", tier: "free", provider: "agnes-ai" },
  { id: "agnes-video-2.5", name: "Agnes Video 2.5", type: "video", tier: "free", provider: "agnes-ai" },
  { id: "agnes-video-2.5-flash", name: "Agnes Video 2.5 Flash", type: "video", tier: "free", provider: "agnes-ai" },
];

export async function handleAIModels(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  // 自定义提供商（如 Agnes）：直接返回其模型列表
  const reqUrl = new URL(request.url);
  const provider = reqUrl.searchParams.get("provider") || "";
  const baseUrl = reqUrl.searchParams.get("baseUrl") || "";
  if (provider.toLowerCase().includes("agnes") || baseUrl.toLowerCase().includes("agnes")) {
    return json({ models: AGNES_MODELS, source: "agnes-static" });
  }

  try {
    // 尝试从 Cloudflare REST API 获取实际可用模型
    const accountId = env.ACCOUNT_ID;
    const apiToken = env.CF_API_TOKEN;

    if (accountId && apiToken) {
      const resp = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
        { headers: { Authorization: `Bearer ${apiToken}` } }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        if (data?.result) {
          return json({
            models: data.result.map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              type: m.task?.name || "unknown",
              tier: m.pricing?.paid ? "paid" : "free",
              provider: "cloudflare",
            })),
            source: "api",
          });
        }
      }
    }

    // 回退到已知模型列表
    return json({ models: CLOUDFLARE_MODELS, source: "static" });
  } catch (e: any) {
    return json({ models: CLOUDFLARE_MODELS, source: "static", error: e.message });
  }
}
