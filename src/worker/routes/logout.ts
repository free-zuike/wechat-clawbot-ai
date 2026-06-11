import { json, verifyAdmin } from "../utils";
import type { Env } from "../index";

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const v = verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);
  await env.CLAWBOT_KV.delete("clawbot:credentials");
  return json({ ok: true });
}
