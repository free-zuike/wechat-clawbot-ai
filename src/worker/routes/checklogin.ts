// 检查登录状态

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";
    let loginAgeText: string | undefined;

    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      try {
        const creds = JSON.parse(credsRaw);
        accountId = creds.accountId;
        if (creds.createdAt) {
          const hours = (Date.now() - creds.createdAt) / 3600000;
          const mins = Math.floor(hours * 60);
          loginAgeText = mins < 60 ? `已登录 ${mins} 分钟` : `已登录 ${Math.floor(hours)} 小时`;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      } catch {}
    }

    Logger.info("[check-login] result", { loggedIn });
    return json({ loggedIn, tokenHealth, loginAgeText, hasCredentials: loggedIn, hasSession: loggedIn });
  } catch (e: any) {
    Logger.error("[check-login] error", { error: e?.message || String(e) });
    return json({ loggedIn: false, error: String(e) });
  }
}
