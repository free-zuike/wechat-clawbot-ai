// 检查登录状态

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";

    // 1. 查 DO 状态（主存储）
    try {
      const doId = env.ILINK_CONNECTION.idFromName("main");
      const doStub = env.ILINK_CONNECTION.get(doId);
      const resp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
      const data = await resp.json() as any;
      if (data.hasCredentials) {
        loggedIn = true;
        tokenHealth = "valid";
        accountId = data.accountId;
      }
    } catch (_e) {}

    // 2. 兜底查 KV（遗留数据）
    if (!loggedIn) {
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
    }

    Logger.info("[check-login] result", { loggedIn });
    return json({ loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn });
  } catch (e: any) {
    Logger.error("[check-login] error", { error: e?.message || String(e) });
    return json({ loggedIn: false, error: String(e) });
  }
}
