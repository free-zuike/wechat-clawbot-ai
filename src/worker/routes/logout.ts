import { json, clearSessionCookie } from "../utils";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  // 无论 session 是否有效，都尝试清除客户端 cookie
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
  
  // 删除 session（如果存在）
  if (sessionMatch && env.CLAWBOT_KV) {
    await env.CLAWBOT_KV.delete(`clawbot:session:${sessionMatch[1]}`);
  }
  
  // 删除登录凭证
  await env.CLAWBOT_KV.delete("clawbot:credentials");
  
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
