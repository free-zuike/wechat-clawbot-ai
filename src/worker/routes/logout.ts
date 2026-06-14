// 登出路由 - 清除 session 和登录凭证

import { json, verifyAdmin, clearSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[logout] user requested logout");

  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);

  // 删除 session（从 KV 删）
  if (sessionMatch) {
    const token = sessionMatch[1];
    await env.CLAWBOT_KV.delete(`clawbot:session:${token}`);
  }

  // 删除登录凭证（KV）
  await env.CLAWBOT_KV.delete("clawbot:credentials");

  // 删除 DO 中的凭证
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    await doStub.fetch(new Request("http://localhost/clear-creds"));
  } catch {}

  Logger.info("[logout] session cleared");
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
