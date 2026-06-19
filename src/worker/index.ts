// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（v2.0）
//  架构参考 bee-swarm:
//    - src/worker/   后端路由和服务
//    - web/          Vue 前端源码（通过 vite build 构建到 dist/）
// ======================================================================

import { router } from "./utils/router";
import { metrics } from "./utils/metrics";
import { errorTracker } from "./utils/metrics";
import { Logger } from "./utils/error";
import { ILinkConnectionDO } from "./services/ilink-do";

// 导出 Durable Objects 类
export { ILinkConnectionDO };

export interface Env {
  AI: any;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_QUEUE: Queue;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
  ILINK_CONNECTION: DurableObjectNamespace<ILinkConnectionDO>;
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
    console.log("[cron] scheduled event triggered at", new Date().toISOString());
    try {
      // 通过 Durable Object 实现实时消息接收
      // 使用固定 ID "main" 确保只有一个 DO 实例处理 iLink 连接
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);

      // 调用 DO 的 /poll 接口：会初始化凭证 + 启动轮询循环
      const response = await doStub.fetch(new Request("http://localhost/poll"));
      const data = await response.json();
      console.log("[cron] DO /poll:", JSON.stringify(data));

      // 检查待处理的视频生成任务
      const videoCheckResponse = await doStub.fetch(new Request("http://localhost/check-pending-videos"));
      const videoCheckData = await videoCheckResponse.json();
      console.log("[cron] DO /check-pending-videos:", JSON.stringify(videoCheckData));

    } catch (e: any) {
      console.error("[cron] error:", e);
      errorTracker.trackError('CRON_ERROR', e.message, 'scheduled');
    }
  },

  // 队列消费者：处理图片/视频生成任务
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { type, prompt, model, provider, baseUrl, apiKey, source } = msg.body;
      const isFromChat = source === "chat";
      Logger.info("[queue] Task received", { type, prompt: prompt?.slice(0, 50), model, provider, source });

      try {
        if (type === "image_generation") {
          const { generateImage } = await import("./services/ai");
          const imageData = await generateImage(env.AI, prompt, model, provider, baseUrl, apiKey);
            if (imageData) {
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ imageData: typeof imageData === "string" ? imageData : null, model, provider, source }),
              }));
              Logger.info("[queue] Image generated" + (isFromChat ? " (chat)" : " and broadcast"));
            } else {
              Logger.error("[queue] Image generation returned null");
              const doId = env.ILINK_CONNECTION.idFromName("main");
              const doStub = env.ILINK_CONNECTION.get(doId);
              await doStub.fetch(new Request("http://localhost/broadcast-image", {
                method: "POST",
                body: JSON.stringify({ error: true, message: `图片生成失败 (${provider} · ${model})`, model, provider, source }),
              }));
            }
        } else if (type === "video_generation") {
          // 检查必要的配置参数
          if (!baseUrl || !apiKey) {
            Logger.error("[queue] Video task missing config", { provider, hasBaseUrl: !!baseUrl, hasApiKey: !!apiKey, apiKeyPrefix: apiKey ? apiKey.slice(0, 6) : "EMPTY" });
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: `视频任务提交失败: 缺少配置参数 (${provider})`, model, provider }),
            }));
            continue;
          }
          // 提交视频生成任务到 Agnes AI（使用 /v1/videos，非标准 /v1/video/generations）
          let base = (baseUrl || "").replace(/\/+$/, "");
          base = base.replace(/\/v1\/(chat\/completions|images\/generations|videos?\/generations|videos\/?|videos)$/i, "");
          base = base.replace(/\/v1$/, "");
          const resp = await fetch(`${base}/v1/videos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt, num_frames: 121, frame_rate: 24 }),
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            Logger.error("[queue] Video submit failed", { status: resp.status, body: errBody.slice(0, 200), url: `${base}/v1/videos`, apiKeyPrefix: apiKey.slice(0, 6) });
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

        } else if (type === "video_check") {
          // 轮询视频状态
          const { taskId, videoId } = msg.body;
          if (!taskId && !videoId) {
            Logger.error("[queue] video_check missing taskId/videoId");
            continue;
          }

          // 查询视频状态
          let base = (baseUrl || "").replace(/\/+$/, "");
          base = base.replace(/\/v1\/(chat\/completions|images\/generations|videos?\/generations|videos\/?|videos)$/i, "");
          base = base.replace(/\/v1$/, "");
          const checkUrl = videoId
            ? `${base}/agnesapi?video_id=${encodeURIComponent(videoId)}`
            : `${base}/v1/videos/${taskId}`;
          const checkResp = await fetch(checkUrl, {
            headers: { "Authorization": `Bearer ${apiKey}` },
          });

          if (!checkResp.ok) {
            Logger.error("[queue] video_check status query failed", { status: checkResp.status, taskId });
            continue;
          }

          const statusData = await checkResp.json() as any;
          Logger.info("[queue] video_check status", { taskId, status: statusData.status, progress: statusData.progress });

          if (statusData.status === "completed") {
            // 视频完成，下载并发送
            const videoUrl = statusData.remixed_from_video_id || statusData.url;
            if (!videoUrl) {
              Logger.error("[queue] video_check completed but no URL", { data: JSON.stringify(statusData).slice(0, 200) });
              continue;
            }

            // 下载视频并发送到微信
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            try {
              await doStub.fetch(new Request("http://localhost/send-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videoUrl, toUserId: msg.body.toUserId, contextToken: msg.body.contextToken, accountId: msg.body.accountId, source }),
              }));
              // 标记完成
              await doStub.fetch(new Request("http://localhost/store-pending-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId, status: "completed" }),
              }));
              Logger.info("[queue] Video sent to WeChat", { taskId });
            } catch (e: any) {
              Logger.error("[queue] Video send failed", { error: e?.message, taskId });
            }
          } else if (statusData.status === "failed") {
            Logger.error("[queue] Video generation failed", { taskId, error: JSON.stringify(statusData.error).slice(0, 200) });
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            await doStub.fetch(new Request("http://localhost/broadcast-image", {
              method: "POST",
              body: JSON.stringify({ error: true, message: `视频生成失败 (${provider} · ${model})`, model, provider, source }),
            }));
            // 标记失败
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
                body: JSON.stringify({ error: true, message: `视频生成超时 (${provider} · ${model})`, model, provider, source }),
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
