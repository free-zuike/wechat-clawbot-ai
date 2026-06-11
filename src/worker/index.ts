// ======================================================================
//  ClawBot AI - Cloudflare Worker 入口（v2.0）
//  架构参考 bee-swarm:
//    - src/worker/   后端路由和服务
//    - web/          Vue 前端源码（通过 vite build 构建到 dist/）
// ======================================================================

import { handleQRCode, handleQRCodeStatus } from "./routes/qrcode";
import { handleStatus } from "./routes/status";
import { handleChat } from "./routes/chat";
import { handleTriggerPoll } from "./routes/trigger";
import { handleLogout } from "./routes/logout";
import { handleConfig } from "./routes/config";

export interface Env {
  AI: any;
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_DB?: D1Database;
  CLAWBOT_R2?: R2Bucket;
  ADMIN_PASSWORD?: string;
  AI_SYSTEM_PROMPT?: string;
  AI_MODEL?: string;
}

// 简单路由匹配
function matchRoute(path: string, pattern: string): boolean {
  if (pattern === "/") return path === "/" || path === "/index.html";
  return path === pattern || path === pattern + "/";
}

// 读取构建后的静态文件
const STATIC_FILES: Record<string, string> = {
  // Worker 会通过 assets 方式提供静态文件
};

async function serveStatic(url: URL): Promise<Response | null> {
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  
  // 常见静态文件类型
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const ext = path.substring(path.lastIndexOf("."));
  const contentType = mimeTypes[ext] || "text/plain";

  try {
    // 尝试从 dist 目录读取
    const filePath = path.startsWith("/") ? path.slice(1) : path;
    const res = await fetch(url.origin + "/" + filePath, { cf: { cacheEverything: false } as any });
    if (res.ok) {
      return new Response(res.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  } catch {}
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // API 路由
    if (path.startsWith("/api/")) {
      // 登录检查（用于 check-login 接口）
      const creds = await env.CLAWBOT_KV.get("clawbot:credentials");
      const isLoggedIn = !!creds;

      if (path === "/api/qrcode" && method === "GET") return handleQRCode(request, env);
      if (path === "/api/qrcode-status" && method === "GET") return handleQRCodeStatus(request, env);
      if (path === "/api/status") return handleStatus(request, env);
      if (path === "/api/chat" && method === "POST") return handleChat(request, env);
      if (path === "/api/trigger-poll" && method === "POST") return handleTriggerPoll(request, env);
      if (path === "/api/logout" && method === "POST") return handleLogout(request, env);
      if (path === "/api/config") return handleConfig(request, env);
      if (path === "/api/check-login" && method === "GET") return json({ loggedIn: isLoggedIn });
      return json({ error: "Not Found" }, 404);
    }

    // 健康检查
    if (path === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // 静态资源（JS/CSS/图片等）- 尝试获取
    const staticRes = await fetch(request.url, { cf: { cacheEverything: true } as any });
    if (staticRes.ok) {
      return staticRes;
    }

    // SPA 路由 - 所有未匹配的路由返回 index.html
    const indexHtml = await fetch(request.url.replace(/\/[^/]*$/, "/index.html"), { cf: { cacheEverything: false } as any }).catch(() => null);
    if (indexHtml?.ok) {
      return new Response(indexHtml.body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return html(NOT_LOGGED_HTML);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// 未登录提示页
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
