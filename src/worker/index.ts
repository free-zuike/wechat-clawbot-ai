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

  // 队列消费者：提交视频生成任务（不等待完成）
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { type, prompt, model, provider, baseUrl, apiKey } = msg.body;
      Logger.info("[queue] Task received", { type, prompt: prompt?.slice(0, 50), model, provider });

      try {
        if (type === "video_generation") {
          // 提交视频生成任务到 Agnes AI
          const base = (baseUrl || "").replace(/\/+$/, "").replace(/\/v1\/(chat\/completions|video\/generations)$/i, "");
          const resp = await fetch(`${base}/v1/video/generations`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model, prompt, duration: 5 }),
          });

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            Logger.error("[queue] Video submit failed", { status: resp.status, body: errBody.slice(0, 200) });
            continue;
          }

          const data = await resp.json() as any;
          const taskId = data.task_id || data.id;
          if (!taskId) {
            Logger.error("[queue] No task_id in response", { keys: Object.keys(data || {}) });
            continue;
          }

          // 存储到 DO SQLite
          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);
          await doStub.fetch(new Request("http://localhost/store-pending-video", {
            method: "POST",
            body: JSON.stringify({ taskId, prompt, model, provider, baseUrl, apiKey }),
          }));

          Logger.info("[queue] Video task submitted and stored", { taskId });
        }
      } catch (e: any) {
        Logger.error("[queue] Task error", { error: e?.message });
      }
    }
  },
};
