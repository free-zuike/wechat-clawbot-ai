// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（优化版 v2）
// ----------------------------------------------------------------------
//  架构参考 bee-swarm：
//    - src/worker/      后端逻辑
//    - src/frontend/    前端页面（CDN Vue 3，无需构建）
//    - public/          静态资源
//  登录流程：/ 检测到未登录自动跳 /login
// ======================================================================

import { handleQRCode, handleQRCodeStatus } from "./routes/qrcode";
import { handleStatus } from "./routes/status";
import { handleChat } from "./routes/chat";
import { handleTriggerPoll } from "./routes/trigger";
import { handleLogout } from "./routes/logout";
import { handleConfig } from "./routes/config";
import { renderLoginPage, renderAdminPage } from "./frontend/pages";

export interface Env {
  AI: any;
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_DB?: D1Database;
  CLAWBOT_R2?: R2Bucket;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // === 登录检查 ===
    const creds = await env.CLAWBOT_KV.get("clawbot:credentials");
    const isLoggedIn = !!creds;

    // 登录页面（优先级最高）
    if (path === "/login" || path === "/login/") {
      return renderLoginPage();
    }

    // === API 路由 ===
    if (path.startsWith("/api/")) {
      if (path === "/api/qrcode" && method === "GET") {
        return handleQRCode(request, env);
      }
      if (path === "/api/qrcode-status" && method === "GET") {
        return handleQRCodeStatus(request, env);
      }
      if (path === "/api/status") {
        return handleStatus(request, env);
      }
      if (path === "/api/chat" && method === "POST") {
        return handleChat(request, env);
      }
      if (path === "/api/trigger-poll" && method === "POST") {
        return handleTriggerPoll(request, env);
      }
      if (path === "/api/logout" && method === "POST") {
        return handleLogout(request, env);
      }
      if (path === "/api/config") {
        return handleConfig(request, env);
      }
      return json({ error: "Not Found" }, 404);
    }

    // === 根路径 - 登录检查 ===
    if (path === "/" || path === "/index.html") {
      if (!isLoggedIn) {
        return Response.redirect(new URL("/login", request.url), 302);
      }
      return renderAdminPage();
    }

    // === 健康检查 ===
    if (path === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // === 其他路径 - 默认返回管理面板（SPA）===
    if (!isLoggedIn) {
      return Response.redirect(new URL("/login", request.url), 302);
    }
    return renderAdminPage();
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      // 定时轮询（如果启用 cron 触发器）
      const { processIncomingMessages } = await import("./services/messaging");
      await processIncomingMessages(env);
    } catch (e) {
      console.error("[cron] error:", e);
    }
  },
};

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
