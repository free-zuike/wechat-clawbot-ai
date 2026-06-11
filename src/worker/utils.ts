// 通用工具函数
export function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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

// 验证管理员密码
export function verifyAdmin(request: Request, env: any): { ok: boolean; error?: string } {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 3) {
    return { ok: false, error: "请先配置 ADMIN_PASSWORD（wrangler secret put ADMIN_PASSWORD）" };
  }
  const url = new URL(request.url);
  const queryPwd = url.searchParams.get("pwd") || "";

  // 支持 Query 参数或 Authorization header
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
