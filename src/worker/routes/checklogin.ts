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

  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const resp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
    const data = await resp.json() as any;
    if (data.hasCredentials) {
      loggedIn = true;
      tokenHealth = "valid";
    }
  } catch (e) {
    Logger.warn("[check-login] DO status check failed", { error: (e as Error).message });
  }

  Logger.info("[check-login] result", { loggedIn });

  const result: CheckLoginResponse = { loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn };
  return json(result);
}
