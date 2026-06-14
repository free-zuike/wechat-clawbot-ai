// 检查登录状态 - 直接查 KV（快速，无网络延迟）

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";

    try {
      const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
      if (credsRaw) {
        loggedIn = true;
        const creds = JSON.parse(credsRaw);
        accountId = creds.accountId;
        if (creds.createdAt) {
          const hours = (Date.now() - creds.createdAt) / 3600000;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      }
    } catch (_e) {}

    Logger.info("[check-login] result", { loggedIn });
    return json({ loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn });
  } catch (e: any) {
    return json({ loggedIn: false, error: e?.message || String(e) });
  }
}
