// 路由模块

import type { Env } from "../index";
import { handleQRCode, handleQRCodeStatus } from "../routes/qrcode";
import { handleCheckLogin } from "../routes/checklogin";
import { handleStatus } from "../routes/status";
import { handleChat } from "../routes/chat";
import { handleTriggerPoll } from "../routes/trigger";
import { handleLogout } from "../routes/logout";
import { handleConfig } from "../routes/config";
import { handleDebugLogin } from "../routes/debug";
import {
  handleRecentMessages,
  handleSessions,
  handleAlerts,
  handleResolveAlert,
  handleResolveAllAlerts,
  handleStats,
  handleHealth,
} from "../routes/admin";
import {
  handleD1Messages,
  handleD1Sessions,
  handleD1Stats,
  handleD1Summary,
} from "../routes/d1";
import {
  handleDOPoll,
  handleDOSend,
  handleDOStatus,
  handleDOFlush,
} from "../routes/do";
import { json, html } from "../utils";
import { metrics, runHealthChecks, errorTracker } from "../utils/metrics";
import { rateLimiters, applyRateLimit } from "../utils/security";
import { handleError } from "../utils/error";

const NOT_LOGGED_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>请登录 · ClawBot AI</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5,#f0f7ff);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:40px 32px;box-shadow:0 8px 28px rgba(0,0,0,.08);text-align:center;max-width:420px;width:100%}
h1{color:#ff4d8d;margin:0 0 12px;font-size:26px}
.desc{color:#666;font-size:14px;line-height:1.7;margin-bottom:24px}
.btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:14px 32px;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
</style>
</head>
<body>
<div class="card">
  <h1>🦞 ClawBot AI</h1>
  <p class="desc">您还未登录微信账号<br/>请点击下方按钮进行扫码登录</p>
  <a href="/login" class="btn">去登录</a>
</div>
</body>
</html>`;

interface RouteHandler {
  (request: Request, env: Env): Promise<Response>;
}

interface Route {
  path: string;
  method?: string;
  handler: RouteHandler;
  requireAuth?: boolean;
  rateLimit?: boolean;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export class Router {
  private routes: Route[] = [];

  init(_env: Env): void {
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.routes = [
      { path: "/api/check-login", method: "GET", handler: handleCheckLogin, rateLimit: true, rateLimitMax: 60, rateLimitWindowMs: 60000 },
      { path: "/api/qrcode", method: "GET", handler: handleQRCode, rateLimit: true, rateLimitMax: 5, rateLimitWindowMs: 60000 },
      { path: "/api/qrcode-status", method: "GET", handler: handleQRCodeStatus, rateLimit: true, rateLimitMax: 20, rateLimitWindowMs: 60000 },
      { path: "/api/status", handler: handleStatus, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/chat", method: "POST", handler: handleChat, requireAuth: true, rateLimit: true, rateLimitMax: 15, rateLimitWindowMs: 60000 },
      { path: "/api/trigger-poll", method: "POST", handler: handleTriggerPoll, requireAuth: true, rateLimit: true, rateLimitMax: 5, rateLimitWindowMs: 60000 },
      { path: "/api/logout", method: "POST", handler: handleLogout, requireAuth: true },
      { path: "/api/config", handler: handleConfig, requireAuth: true, rateLimit: true, rateLimitMax: 10, rateLimitWindowMs: 60000 },
      { path: "/api/debug-login", method: "GET", handler: handleDebugLogin, requireAuth: true },
      // 管理后台路由
      { path: "/api/admin/messages", method: "GET", handler: handleRecentMessages, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/sessions", method: "GET", handler: handleSessions, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/alerts", method: "GET", handler: handleAlerts, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/alerts/resolve", method: "POST", handler: handleResolveAlert, requireAuth: true, rateLimit: true, rateLimitMax: 20, rateLimitWindowMs: 60000 },
      { path: "/api/admin/alerts/resolve-all", method: "POST", handler: handleResolveAllAlerts, requireAuth: true, rateLimit: true, rateLimitMax: 5, rateLimitWindowMs: 60000 },
      { path: "/api/admin/stats", method: "GET", handler: handleStats, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/health", method: "GET", handler: handleHealth, requireAuth: true, rateLimit: true, rateLimitMax: 60, rateLimitWindowMs: 60000 },
      // D1 数据库查询路由
      { path: "/api/admin/d1/messages", method: "GET", handler: handleD1Messages, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/d1/sessions", method: "GET", handler: handleD1Sessions, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/d1/stats", method: "GET", handler: handleD1Stats, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/admin/d1/summary", method: "GET", handler: handleD1Summary, requireAuth: true, rateLimit: true, rateLimitMax: 60, rateLimitWindowMs: 60000 },
      // Durable Objects 实时消息路由
      { path: "/api/do/poll", method: "GET", handler: handleDOPoll, requireAuth: true, rateLimit: true, rateLimitMax: 60, rateLimitWindowMs: 60000 },
      { path: "/api/do/send", method: "POST", handler: handleDOSend, requireAuth: true, rateLimit: true, rateLimitMax: 30, rateLimitWindowMs: 60000 },
      { path: "/api/do/status", method: "GET", handler: handleDOStatus, requireAuth: true, rateLimit: true, rateLimitMax: 60, rateLimitWindowMs: 60000 },
      { path: "/api/do/flush", method: "POST", handler: handleDOFlush, requireAuth: true, rateLimit: true, rateLimitMax: 10, rateLimitWindowMs: 60000 },
    ];
  }

  async route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 健康检查
    if (path === "/healthz") {
      const health = await runHealthChecks(env);
      return json(health, health.ok ? 200 : 503);
    }

    // 指标端点
    if (path === "/metrics") {
      const data = await metrics.export();
      return json(data);
    }

    // 错误统计端点
    if (path === "/errors") {
      const stats = await errorTracker.getStats();
      return json(stats);
    }

    // API 路由
    if (path.startsWith("/api/")) {
      // 查找路由
      const route = this.findRoute(path, method);
      if (!route) {
        return json({ error: "Not Found" }, 404);
      }

      // 全局 IP 限流（使用 Upstash，支持 60 请求/分钟）
      if (route.rateLimit) {
        const limitResult = await applyRateLimit(request, env, "ip");
        if (limitResult) return limitResult;
      }

      // 指标计数
      metrics.incr(`requests.${method}.${path}`);

      // 执行路由（已有认证在 handler 内实现，这里额外 requireAuth 标志）
      return this.executeHandler(route.handler, request, env, path);
    }

    // 静态资源
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
      }
      return res;
    }

    // fallback
    try {
      const staticRes = await fetch(request.url, { cf: { cacheEverything: false } as any });
      if (staticRes.ok) {
        return staticRes;
      }
    } catch {}

    return html(NOT_LOGGED_HTML);
  }

  private findRoute(path: string, method: string): Route | undefined {
    return this.routes.find(r => {
      const pathMatch = r.path === path || (r.path.endsWith('/') && path === r.path.slice(0, -1));
      const methodMatch = !r.method || r.method === method;
      return pathMatch && methodMatch;
    });
  }

  private async executeHandler(
    handler: RouteHandler,
    request: Request,
    env: Env,
    endpoint: string
  ): Promise<Response> {
    metrics.startTimer(endpoint);
    try {
      const response = await handler(request, env);
      metrics.stopTimer(endpoint);
      return response;
    } catch (error) {
      metrics.stopTimer(endpoint);
      metrics.incr(`errors.${endpoint}`);
      
      // 追踪错误
      if (error instanceof Error) {
        await errorTracker.trackError(error.name, error.message, endpoint, error.stack);
      }
      
      return handleError(error);
    }
  }
}

// 全局路由实例
export const router = new Router();