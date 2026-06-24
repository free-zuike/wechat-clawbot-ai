// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（v2.0）
//  架构参考 bee-swarm:
//    - src/worker/   后端路由和服务
//    - web/          Vue 前端源码（通过 vite build 构建到 dist/）
// ======================================================================

import { router } from "./utils/router";
import { metrics } from "./utils/metrics";
import { errorTracker } from "./utils/metrics";
import { parseApiUrl } from "./services/ai";
import { Logger } from "./utils/error";
import { ILinkConnectionDO } from "./services/ilink-do";

// 导出 Durable Objects 类
export { ILinkConnectionDO };

export interface Env {
  AI: any;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_QUEUE: Queue;
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
  ILINK_CONNECTION: DurableObjectNamespace<ILinkConnectionDO>;
  ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}

function detectImageMime(data: Uint8Array): string {
  if (data[0] === 0xFF && data[1] === 0xD8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data[0] === 0x52 && data[1] === 0x49) return "image/webp";
  return "image/png";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!metrics.getCounters()['init']) {
      metrics.init();
      errorTracker.init();
      metrics.incr('init');
    }

    return router.route(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);

      const response = await doStub.fetch(new Request("http://localhost/poll"));
      const data = await response.json();
      console.log("[cron] /poll:", JSON.stringify(data));

      const videoCheckResponse = await doStub.fetch(new Request("http://localhost/check-pending-videos"));
      const videoCheckData = await videoCheckResponse.json();
      console.log("[cron] /check-pending-videos:", JSON.stringify(videoCheckData));

    } catch (e: any) {
      console.error("[cron] error:", e);
      errorTracker.trackError('CRON_ERROR', e.message, 'scheduled');
    }
  },

  // 队列消费者：处理图片/视频生成任务
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { type, prompt, model, provider, baseUrl, apiKey, source, allKeys, maxRetries, imageUrl: refImageUrl, imageUrls: refImageUrls, capabilities: refCaps } = msg.body;
      const isFromChat = source === "chat";
      Logger.info("[queue] Task received", { type, prompt: prompt?.slice(0, 50), model, provider, source });

      async function logGen(tp: string, pr: string, rs: string, pv: string, md: string, st: string, er?: string, src?: string) {
        try {
          const p = new URLSearchParams({ t: tp, p: pr.slice(0, 200), r: rs.slice(0, 200), pv, m: md, s: st, e: er || "", src: src || source || "" });
          const doStub = env.ILINK_CONNECTION.get(env.ILINK_CONNECTION.idFromName("main"));
          await doStub.fetch(new Request(`http://localhost/log-generation?${p}`));
        } catch (e: any) {
          console.error("[queue] logGen failed:", e?.message);
        }
      }

      try {
        if (type === "image_generation") {
          const { generateImage } = await import("./services/ai");
          const imageDataResult = await generateImage(env.AI, prompt, model, provider, baseUrl, apiKey, refImageUrl, undefined, allKeys, maxRetries, refImageUrls, refCaps);
          const imageData = imageDataResult.data;
            if (imageData) {
              const dataLen = imageData instanceof Uint8Array ? imageData.length : (typeof imageData === "string" ? imageData.length : 0);
              if (dataLen === 0) {
                Logger.error("[queue] Image data is empty", { type: typeof imageData, constructor: imageData?.constructor?.name });
              } else {
                const doId = env.ILINK_CONNECTION.idFromName("main");
                const doStub = env.ILINK_CONNECTION.get(doId);
                let imageUrl: string;
                if (typeof imageData === "string") {
                  imageUrl = imageData;
                } else {
                  const arr = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
                  let binary = "";
                  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
                  const mime = detectImageMime(arr);
                  imageUrl = `data:${mime};base64,${btoa(binary)}`;
                }
                Logger.info("[queue] Broadcasting image", { imageUrlLength: imageUrl.length, isDataUrl: imageUrl.startsWith("data:") });
                const broadcastResp = await doStub.fetch(new Request("http://localhost/broadcast-image", {
                  method: "POST",
                  body: JSON.stringify({ imageData: imageUrl, model, provider, source, keyIndex: imageDataResult.keyIndex, prompt }),
                }));
                if (!broadcastResp.ok) {
                  const errText = await broadcastResp.text().catch(() => "unknown");
                  Logger.error("[queue] Broadcast image failed", { status: broadcastResp.status, body: errText });
                }
                Logger.info("[queue] Image generated" + (isFromChat ? " (chat)" : " and broadcast"));
              }
            } else {
              Logger.error("[queue] Image generation returned null");
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              const errMsg = `图片生成失败 (${provider} · ${model})`;
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ error: true, message: errMsg, model, provider, source, prompt }),
              }));
              // 如果有微信来源信息，也发送错误给用户
              if (isFromChat && msg.body.toUserId) {
                await doStub.fetch(new Request("http://localhost/send-text", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ text: `❌ ${errMsg}\n请稍后重试`, toUserId: msg.body.toUserId, contextToken: msg.body.contextToken, accountId: msg.body.accountId }),
                }));
              }
            }
        } else if (type === "video_generation") {
          const isCloudflare = !provider || provider === "cloudflare";
          // Cloudflare AI：直接使用 aiBinding
          if (isCloudflare && env.AI) {
            try {
              const { submitVideoTask } = await import("./services/ai");
              const result = await submitVideoTask(env.AI, prompt, model, provider, baseUrl, apiKey);
              if (result) {
                const doId = env.ILINK_CONNECTION.idFromName("main");
                const doStub = env.ILINK_CONNECTION.get(doId);
                await doStub.fetch(new Request("http://localhost/store-pending-video", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ taskId: result.taskId, videoId: result.videoId, prompt: result.prompt, model: result.model, provider: result.provider, baseUrl: result.baseUrl, apiKey: result.apiKey, source }),
                }));
                if (result.url) {
                  // 同步返回了视频 URL
                  const broadcastResp = await doStub.fetch(new Request("http://localhost/broadcast-image", {
                    method: "POST",
                    body: JSON.stringify({ imageData: result.url, model: result.model, provider: result.provider, source, mediaType: "video", prompt: result.prompt }),
                  }));
                  Logger.info("[queue] Cloudflare video sync completed");
                } else {
                  // 异步任务，调度检查
                  await env.CLAWBOT_QUEUE.send({
                    type: "video_check",
                    taskId: result.taskId, videoId: result.videoId, prompt: result.prompt, model: result.model, provider: result.provider, baseUrl: result.baseUrl, apiKey: result.apiKey, source,
                  }, { delaySeconds: 30 });
                  Logger.info("[queue] Cloudflare video task submitted", { taskId: result.taskId });
                }
              } else {
                Logger.error("[queue] Cloudflare video submit returned null");
                const doId = env.ILINK_CONNECTION.idFromName("main");
                const doStub = env.ILINK_CONNECTION.get(doId);
                await doStub.fetch(new Request("http://localhost/broadcast-image", {
                  method: "POST",
                  body: JSON.stringify({ error: true, message: `视频生成失败 (${provider} · ${model})`, model, provider, source, mediaType: "video", prompt }),
                }));
              }
            } catch (e: any) {
              Logger.error("[queue] Cloudflare video error", { error: e?.message });
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ error: true, message: `视频生成失败: ${e?.message || String(e)}`, model, provider, source, mediaType: "video", prompt }),
              }));
            }
          } else {
          // 非 Cloudflare 提供商：REST API
          // 提交视频生成任务
          const { base: vBase, version: vVer } = parseApiUrl(baseUrl || "");
          const isZhipu = (baseUrl || "").includes("bigmodel.cn");
          const submitUrl = isZhipu ? `${vBase}/${vVer}/videos/generations` : `${vBase}/${vVer}/videos`;
          const resp = await fetch(submitUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt, num_frames: 121, frame_rate: 24 }),
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            Logger.error("[queue] Video submit failed", { status: resp.status, body: errBody.slice(0, 200), url: submitUrl, apiKeyPrefix: apiKey.slice(0, 6) });
            continue;
          }

          const data = await resp.json() as any;
          const taskId = data.task_id || data.id;
          const videoId = data.video_id;
          if (!taskId && !videoId) {
            Logger.error("[queue] No task_id or video_id in response", { keys: Object.keys(data || {}) });
            continue;
          }

          // 存储到 DO SQLite（包含 video_id，优先用于查询）
          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);
          await doStub.fetch(new Request("http://localhost/store-pending-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, videoId, prompt, model, provider, baseUrl, apiKey, source }),
          }));

          // 调度首次检查：30 秒后通过 Queue 检查视频状态
          await env.CLAWBOT_QUEUE.send({
            type: "video_check",
            taskId, videoId, prompt, model, provider, baseUrl, apiKey, source,
          }, { delaySeconds: 30 });

          Logger.info("[queue] Video task submitted and stored", { taskId, videoId });
          }

        } else if (type === "video_check") {
          // 轮询视频状态
          const { taskId, videoId } = msg.body;
          if (!taskId && !videoId) {
            Logger.error("[queue] video_check missing taskId/videoId");
            continue;
          }

          // 查询视频状态
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
          const { base: cBase, version: cVer } = parseApiUrl(baseUrl || "");
          // 智谱AI用 /async-result/{id}，其他提供商用旧版兼容格式
          const isZhipu = (baseUrl || "").includes("bigmodel.cn");
          const checkUrl = isZhipu
            ? `${cBase}/${cVer}/async-result/${encodeURIComponent(taskId || videoId)}`
            : videoId
              ? `${cBase}/agnesapi?video_id=${encodeURIComponent(videoId)}`
              : `${cBase}/${cVer}/videos/${taskId}`;
          const checkResp = await fetch(checkUrl, {
            headers: { "Authorization": `Bearer ${apiKey}` },
          });

          if (!checkResp.ok) {
            Logger.error("[queue] video_check status query failed", { status: checkResp.status, taskId, url: checkUrl });
            continue;
          }

          const statusData = await checkResp.json() as any;
          // 智谱AI: task_status (SUCCESS/PROCESSING/FAIL), 其他: status (completed/failed)
          const taskStatus = statusData.task_status || statusData.status;
          Logger.info("[queue] video_check status", { taskId, taskStatus, model });

          // 统一判断：完成
          const isCompleted = taskStatus === "completed" || taskStatus === "SUCCESS" || taskStatus === "success";
          const isFailed = taskStatus === "failed" || taskStatus === "FAIL" || taskStatus === "fail";

          if (isCompleted) {
            // 视频完成 — 智谱AI: video_result[0].url, Agnes: remixed_from_video_id
            const videoUrl = statusData.video_result?.[0]?.url
              || statusData.remixed_from_video_id
              || statusData.url;
            if (!videoUrl) {
              Logger.error("[queue] video_check completed but no URL", { data: JSON.stringify(statusData).slice(0, 300) });
              continue;
            }

            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);

            if (source !== "chat" && msg.body.toUserId && msg.body.contextToken) {
              // 微信来源：发送到微信
              try {
                await doStub.fetch(new Request("http://localhost/send-video", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ videoUrl, toUserId: msg.body.toUserId, contextToken: msg.body.contextToken, accountId: msg.body.accountId, model, provider, prompt, source }),
                }));
                await doStub.fetch(new Request("http://localhost/store-pending-video", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ taskId, videoId, status: "completed", videoUrl }),
                }));
                Logger.info("[queue] Video sent to WeChat", { taskId });
              } catch (e: any) {
                Logger.error("[queue] Video send failed", { error: e?.message, taskId });
              }
            } else {
              // AI测试来源：广播到 WebSocket
              try {
                await doStub.fetch(new Request("http://localhost/broadcast-image", {
                  method: "POST",
                  body: JSON.stringify({ imageData: videoUrl, model, provider, source, mediaType: "video", prompt }),
                }));
                Logger.info("[queue] Video broadcasted to WebSocket", { taskId });
              } catch (e: any) {
                Logger.error("[queue] Video broadcast failed", { error: e?.message, taskId });
              }
              // 更新状态防止 checkPendingVideos 重复处理
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId, videoId, status: "completed", videoUrl }),
              }));
            }
          } else if (isFailed) {
            Logger.error("[queue] Video generation failed", { taskId, error: JSON.stringify(statusData.error).slice(0, 200) });
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            const errMsg = `视频生成失败 (${provider} · ${model})`;
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: errMsg, model, provider, source, mediaType: "video", prompt }),
            }));
            await doStub.fetch(new Request("http://localhost/store-pending-video", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId, status: "failed" }),
            }));
          } else {
            // 仍在处理中，30 秒后再检查
            const retryCount = (msg.body.retryCount || 0) + 1;
            if (retryCount >= 40) {
              // 最多重试 40 次（约 20 分钟），超过则放弃
              Logger.error("[queue] Video check timeout (>20min)", { taskId });
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ error: true, message: `视频生成超时 (${provider} · ${model})`, model, provider, source, mediaType: "video", prompt }),
              }));
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId, status: "failed" }),
              }));
            } else {
              await env.CLAWBOT_QUEUE.send({
                ...msg.body,
                retryCount,
              }, { delaySeconds: 30 });
            }
          }
        }
      } catch (e: any) {
        Logger.error("[queue] Task error", { error: e?.message });
      }
    }
  },
};
