// 通用工具函数
export function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// 生成随机 session token
export function generateSessionToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// 创建 session cookie
export function createSessionCookie(token: string): string {
  return `clawbot_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`;
}

// 清除 session cookie
export function clearSessionCookie(): string {
  return "clawbot_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

// 验证管理员密码或 session
export async function verifyAdmin(request: Request, env: any): Promise<{ ok: boolean; error?: string }> {
  // 动态导入避免循环依赖
  const { getUpstashService } = await import("./services/upstash");

  // 先检查 session cookie（优先用 Upstash，兜底用 KV）
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
  if (sessionMatch) {
    const sessionToken = sessionMatch[1];
    const upstash = getUpstashService(env);

    // 优先从 Upstash 读 session
    let sessionValid = await upstash.get(`clawbot:session:${sessionToken}`);
    if (sessionValid === null) {
      // 兜底从 KV 读（兼容旧 session）
      sessionValid = await env.CLAWBOT_KV?.get(`clawbot:session:${sessionToken}`);
    }

    if (sessionValid) {
      return { ok: true };
    }
  }

  // 检查是否有登录凭证（已通过微信扫码登录）
  // 优先从 DO SQLite 读（代码已迁移），兜底从 KV 读
  if (env.CLAWBOT_KV) {
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      return { ok: true };
    }
  }

  // 再检查管理员密码（兼容旧方式和初始登录）
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 3) {
    return { ok: false, error: "请先配置 ADMIN_PASSWORD（wrangler secret put ADMIN_PASSWORD）" };
  }
  const url = new URL(request.url);
  const queryPwd = url.searchParams.get("pwd") || "";

  const authHeader = request.headers.get("Authorization") || "";
  let headerOk = false;
  const m = authHeader.match(/^Basic\s+(.+)$/i);
  if (m) {
    try {
      const decoded = atob(m[1]);
      const colon = decoded.indexOf(":");
      const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      headerOk = pass === env.ADMIN_PASSWORD;
    } catch {}
  }

  if (queryPwd === env.ADMIN_PASSWORD || headerOk) {
    return { ok: true };
  }
  return { ok: false, error: "管理员密码不正确" };
}

// 从请求中提取密码（用于前端传递）
export function extractPassword(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("pwd") || "";
}
