// 登出路由 - 清除 session 和登录凭证
// 优化：session 改用 Upstash 删除

import { json, verifyAdmin, clearSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import { getUpstashService } from "../services/upstash";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[logout] user requested logout");

  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);

  // 删除 session（优先从 Upstash 删，兜底从 KV 删）
  if (sessionMatch) {
    const token = sessionMatch[1];
    const upstash = getUpstashService(env);
    await upstash.del(`clawbot:session:${token}`);
    await env.CLAWBOT_KV?.delete(`clawbot:session:${token}`);
  }

  // 删除登录凭证（保留，方便重新登录）
  await env.CLAWBOT_KV?.delete("clawbot:credentials");

  Logger.info("[logout] session cleared");
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
