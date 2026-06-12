import { json, verifyAdmin, clearSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info('[logout] user requested logout');

  // 无论 session 是否有效，都尝试清除客户端 cookie
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);

  // 删除 session（如果存在）
  if (sessionMatch && env.CLAWBOT_KV) {
    await env.CLAWBOT_KV.delete(`clawbot:session:${sessionMatch[1]}`);
  }

  // 删除登录凭证
  await env.CLAWBOT_KV.delete("clawbot:credentials");

  Logger.info('[logout] credentials cleared');
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
