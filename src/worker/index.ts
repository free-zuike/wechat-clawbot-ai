// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（v2.0）
//  架构参考 bee-swarm:
//    - src/worker/   后端路由和服务
//    - web/          Vue 前端源码（通过 vite build 构建到 dist/）
// ======================================================================

import { router } from "./utils/router";
import { metrics } from "./utils/metrics";
import { errorTracker } from "./utils/metrics";
import { ILinkConnectionDO } from "./services/ilink-do";

// 导出 Durable Objects 类
export { ILinkConnectionDO };

export interface Env {
  AI: any;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_DB?: D1Database;
  CLAWBOT_R2?: R2Bucket;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
  ILINK_CONNECTION: DurableObjectNamespace<ILinkConnectionDO>;
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
      // 通过 Durable Object 实现实时消息接收
      // 使用固定 ID "main" 确保只有一个 DO 实例处理 iLink 连接
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);

      // 调用 DO 的状态接口，触发轮询循环启动（如果尚未启动）
      const response = await doStub.fetch(new Request("http://localhost/status"));
      const status = await response.json();
      console.log("[cron] DO status:", JSON.stringify(status));

    } catch (e: any) {
      console.error("[cron] error:", e);
      errorTracker.trackError('CRON_ERROR', e.message, 'scheduled');
    }
  },
};
