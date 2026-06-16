// 路由模块

import type { Env } from "../index";
import { handleQRCode, handleQRCodeStatus, handleUnbindWechat } from "../routes/qrcode";
import { handleCheckLogin } from "../routes/checklogin";
import { handleStatus } from "../routes/status";
import { handleChat } from "../routes/chat";
import { handleTriggerPoll } from "../routes/trigger";
import { handleLogout } from "../routes/logout";
import { handleConfig } from "../routes/config";
import { handleDebugLogin } from "../routes/debug";
import { handleRecentMessages, handleSessions, handleAlerts, handleResolveAlert, handleResolveAllAlerts, handleStats, handleHealth } from "../routes/admin";
import { handleDOPoll, handleDOSend, handleDOStatus, handleDOFlush } from "../routes/do";
import { handleWebSocket } from "../routes/websocket";
import { handleTemplates } from "../routes/templates";
import { json } from "../utils";
import { metrics, runHealthChecks, errorTracker } from "../utils/metrics";
import { applyRateLimit } from "../utils/security";
import { handleError } from "../utils/error";

type Handler = (request: Request, env: Env) => Promise<Response>;

interface Route { path: string; method?: string; handler: Handler; rateLimit?: boolean; rateLimitMax?: number }

export class Router {
  private routes: Route[] = [
    { path: "/api/check-login", handler: handleCheckLogin, rateLimit: true, rateLimitMax: 120 },
    { path: "/api/qrcode", method: "GET", handler: handleQRCode, rateLimit: true, rateLimitMax: 20 },
    { path: "/api/qrcode-status", method: "GET", handler: handleQRCodeStatus, rateLimit: true, rateLimitMax: 60 },
    { path: "/api/status", handler: handleStatus, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/chat", method: "POST", handler: handleChat, rateLimit: true, rateLimitMax: 15 },
    { path: "/api/trigger-poll", method: "POST", handler: handleTriggerPoll, rateLimit: true, rateLimitMax: 5 },
    { path: "/api/logout", method: "POST", handler: handleLogout },
    { path: "/api/config", handler: handleConfig, rateLimit: true, rateLimitMax: 10 },
    { path: "/api/debug-login", method: "GET", handler: handleDebugLogin },
    { path: "/api/unbind-wechat", method: "POST", handler: handleUnbindWechat },
    { path: "/api/admin/messages", method: "GET", handler: handleRecentMessages, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/admin/sessions", method: "GET", handler: handleSessions, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/admin/alerts", method: "GET", handler: handleAlerts, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/admin/alerts/resolve", method: "POST", handler: handleResolveAlert, rateLimit: true, rateLimitMax: 20 },
    { path: "/api/admin/alerts/resolve-all", method: "POST", handler: handleResolveAllAlerts, rateLimit: true, rateLimitMax: 5 },
    { path: "/api/admin/stats", method: "GET", handler: handleStats, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/admin/health", method: "GET", handler: handleHealth, rateLimit: true, rateLimitMax: 60 },
    { path: "/api/do/poll", method: "GET", handler: handleDOPoll, rateLimit: true, rateLimitMax: 60 },
    { path: "/api/do/send", method: "POST", handler: handleDOSend, rateLimit: true, rateLimitMax: 30 },
    { path: "/api/do/status", method: "GET", handler: handleDOStatus, rateLimit: true, rateLimitMax: 60 },
    { path: "/api/do/flush", method: "POST", handler: handleDOFlush, rateLimit: true, rateLimitMax: 10 },
    { path: "/api/ws", handler: handleWebSocket },
    { path: "/api/templates", handler: handleTemplates, rateLimit: true, rateLimitMax: 30 },
  ];

  async route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz") {
      const health = await runHealthChecks(env);
      return json(health, health.ok ? 200 : 503);
    }
    if (path === "/metrics") return json(await metrics.export());
    if (path === "/errors") return json(await errorTracker.getStats());

    if (path.startsWith("/api/")) {
      const route = this.routes.find(r => {
        const pathMatch = r.path === path || (r.path.endsWith('/') && path === r.path.slice(0, -1));
        return pathMatch && (!r.method || r.method === method);
      });
      if (!route) return json({ error: "Not Found" }, 404);

      if (route.rateLimit) {
        const limitResult = await applyRateLimit(request, env, "ip");
        if (limitResult) return limitResult;
      }

      metrics.incr(`requests.${method}.${path}`);
      metrics.startTimer(path);
      try {
        const response = await route.handler(request, env);
        metrics.stopTimer(path);
        return response;
      } catch (error) {
        metrics.stopTimer(path);
        metrics.incr(`errors.${path}`);
        if (error instanceof Error) {
          await errorTracker.trackError(error.name, error.message, path, error.stack);
        }
        return handleError(error);
      }
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      return res.status === 404 ? env.ASSETS.fetch(new Request(new URL("/index.html", request.url))) : res;
    }

    return json({ error: "Not Found" }, 404);
  }
}

export const router = new Router();
