// 登出路由 - 仅清除管理员 session，不影响微信凭证

import { json, verifyAdmin, clearSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[logout] user requested logout");

  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);

  // 仅删除管理员 session，保留微信凭证
  if (sessionMatch) {
    const token = sessionMatch[1];
    await env.CLAWBOT_KV.delete(`clawbot:session:${token}`);
  }

  Logger.info("[logout] session cleared");
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
