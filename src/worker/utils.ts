// 通用工具函数
export function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export function generateSessionToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function createSessionCookie(token: string): string {
  return `clawbot_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`;
}

export function clearSessionCookie(): string {
  return "clawbot_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
}

// 验证管理员：DO凭证 → 管理员密码（凭证只存DO，不存KV）
export async function verifyAdmin(request: Request, env: any): Promise<{ ok: boolean; error?: string }> {
  // 1. DO 凭证
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const resp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
    const data = await resp.json() as any;
    if (data.hasCredentials) return { ok: true };
  } catch (_e) {}

  // 2. 管理员密码
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 3) {
    return { ok: false, error: "请先配置 ADMIN_PASSWORD" };
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
      headerOk = (colon >= 0 ? decoded.slice(colon + 1) : decoded) === env.ADMIN_PASSWORD;
    } catch (_e) {}
  }
  if (queryPwd === env.ADMIN_PASSWORD || headerOk) return { ok: true };
  return { ok: false, error: "管理员密码不正确" };
}

export function extractPassword(request: Request): string {
  return new URL(request.url).searchParams.get("pwd") || "";
}
