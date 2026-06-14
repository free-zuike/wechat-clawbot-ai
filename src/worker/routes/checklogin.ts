// 检查登录状态

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
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      const creds = JSON.parse(credsRaw);
      if (creds.createdAt) {
        const hours = (Date.now() - creds.createdAt) / 3600000;
        tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
      }
    }
  } catch (e) {
    Logger.warn("[check-login] KV read failed", { error: (e as Error).message });
  }

  Logger.info("[check-login] result", { loggedIn });

  const result: CheckLoginResponse = { loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn };
  return json(result);
}
