// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（v2.0）
//  架构参考 bee-swarm:
//    - src/worker/   后端路由和服务
//    - web/          Vue 前端源码（通过 vite build 构建到 dist/）
// ======================================================================

import { router, metrics, errorTracker } from "./utils";

export interface Env {
  AI: any;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_DB?: D1Database;
  CLAWBOT_R2?: R2Bucket;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 初始化（延迟初始化）
    if (!metrics.getCounters()['init']) {
      metrics.init(env.CLAWBOT_KV);
      errorTracker.init(env.CLAWBOT_KV);
      router.init(env);
      metrics.incr('init');
    }

    return router.route(request, env);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    console.log("[cron] scheduled event triggered at", new Date().toISOString());
    try {
      const { processIncomingMessages } = await import("./services/messaging");
      const result = await processIncomingMessages(env);
      console.log("[cron] result:", JSON.stringify(result));
    } catch (e: any) {
      console.error("[cron] error:", e);
      errorTracker.trackError('CRON_ERROR', e.message, 'scheduled');
    }
  },
};
