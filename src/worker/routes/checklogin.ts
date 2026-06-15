// 检查登录状态 — 只查 DO

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

interface CheckLoginResponse {
  loggedIn: boolean;
  tokenHealth: string;
  hasCredentials: boolean;
  hasSession: boolean;
}

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  let loggedIn = false;
  let tokenHealth = "unknown";

  // 检查 session cookie（KV + DO）
  const cookieHeader = request.headers.get("Cookie") || "";
  const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
  if (sessionMatch) {
    const sessionToken = sessionMatch[1];
    try {
      const sessionValid = await env.CLAWBOT_KV.get(`clawbot:session:${sessionToken}`);
      if (sessionValid) loggedIn = true;
    } catch (_e) {}
    if (!loggedIn) {
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        const resp = await doStub.fetch(new Request(`http://localhost/check-session?token=${sessionToken}`), { signal: AbortSignal.timeout(3000) });
        const data = await resp.json() as any;
        if (data.valid) loggedIn = true;
      } catch (_e) {}
    }
  }

  if (loggedIn) tokenHealth = "valid";

  Logger.info("[check-login] result", { loggedIn });

  const result: CheckLoginResponse = { loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn };
  return json(result);
}
