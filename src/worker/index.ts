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
  VIDEO_QUEUE: Queue;
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
      // （之前调用 /status 只返回状态，不会启动轮询，导致 DO eviction 后消息永远不被拉取）
      const response = await doStub.fetch(new Request("http://localhost/poll"));
      const data = await response.json();
      console.log("[cron] DO /poll:", JSON.stringify(data));

    } catch (e: any) {
      console.error("[cron] error:", e);
      errorTracker.trackError('CRON_ERROR', e.message, 'scheduled');
    }
  },

  // 队列消费者：处理视频生成等长任务
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { type, prompt, videoModel, provider, baseUrl, apiKey, toUserId, contextToken, accountId } = msg.body;
      Logger.info("[queue] Processing video generation", { type, prompt: prompt?.slice(0, 50) });

      if (type === "video_generation") {
        try {
          const { generateVideo } = await import("./services/ai");
          const videoUrl = await generateVideo(env.AI, prompt, videoModel, provider, baseUrl, apiKey);

          if (videoUrl) {
            // 通过 DO 发送视频消息
            const doId = env.ILINK_CONNECTION.idFromName("main");
            const doStub = env.ILINK_CONNECTION.get(doId);
            await doStub.fetch(new Request("http://localhost/send-video", {
              method: "POST",
              body: JSON.stringify({ videoUrl, toUserId, contextToken, accountId, model: videoModel, provider }),
            }));
            Logger.info("[queue] Video generated and sent", { videoUrl: videoUrl.slice(0, 50) });
          } else {
            Logger.error("[queue] Video generation failed");
          }
        } catch (e: any) {
          Logger.error("[queue] Video generation error", { error: e?.message });
        }
      }
    }
  },
};
