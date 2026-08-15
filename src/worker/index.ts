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
import { refreshAllMCPToolsIfStale } from "./services/mcp";
import { handleQueueMessage } from "./services/queue-handler";

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
  ILINK_CONNECTION: DurableObjectNamespace;
  ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  BROWSER?: any;
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
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);

    // 三个独立任务并行执行：MCP 工具刷新（worker 本地）+ 消息轮询（DO）+ 视频检查（DO）
    // 注意 /poll 与 /check-pending-videos 打同一 DO（单实例串行处理），真正并行收益来自
    // MCP 刷新与 DO 请求并行；用 allSettled 保证单项失败不影响其他任务
    const [mcp, poll, videoCheck] = await Promise.allSettled([
      refreshAllMCPToolsIfStale(env.DB),
      doStub.fetch(new Request("http://localhost/poll")).then((r) => r.json()),
      doStub.fetch(new Request("http://localhost/check-pending-videos")).then((r) => r.json()),
    ]);

    if (mcp.status === "rejected") {
      console.error("[cron] MCP refresh error:", mcp.reason);
      errorTracker.trackError("CRON_MCP_REFRESH_ERROR", mcp.reason?.message || String(mcp.reason), "scheduled");
    }
    if (poll.status === "rejected") {
      console.error("[cron] /poll error:", poll.reason);
      errorTracker.trackError("CRON_POLL_ERROR", poll.reason?.message || String(poll.reason), "scheduled");
    } else {
      console.log("[cron] /poll:", JSON.stringify(poll.value));
    }
    if (videoCheck.status === "rejected") {
      console.error("[cron] /check-pending-videos error:", videoCheck.reason);
      errorTracker.trackError("CRON_VIDEO_CHECK_ERROR", videoCheck.reason?.message || String(videoCheck.reason), "scheduled");
    } else {
      console.log("[cron] /check-pending-videos:", JSON.stringify(videoCheck.value));
    }
  },

  // 队列消费者：处理图片/视频生成任务
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    await handleQueueMessage(batch, env);
  },
};