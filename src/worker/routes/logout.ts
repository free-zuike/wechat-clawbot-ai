import { json, verifyAdmin, clearSessionCookie } from "../utils";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  await env.CLAWBOT_KV.delete("clawbot:credentials");
  
  // 删除所有 session
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
  if (sessionMatch && env.CLAWBOT_KV) {
    await env.CLAWBOT_KV.delete(`clawbot:session:${sessionMatch[1]}`);
  }
  
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
