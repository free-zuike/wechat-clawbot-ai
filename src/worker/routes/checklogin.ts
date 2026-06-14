// 检查登录状态 - 前端通过此接口判断是否已扫码登录

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

// 检查登录状态
export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";
    let loginAgeText: string | undefined;
    let hasSession = false;

    // 1. 检查 session cookie
    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
    if (sessionMatch) {
      const sessionToken = sessionMatch[1];
      // 先查 KV，再查 DO SQLite
      const sessionValid = await env.CLAWBOT_KV.get(`clawbot:session:${sessionToken}`);
      if (sessionValid) {
        hasSession = true;
        loggedIn = true;
      } else {
        try {
          const doId = env.ILINK_CONNECTION.idFromName("main");
          const doStub = env.ILINK_CONNECTION.get(doId);
          const resp = await doStub.fetch(new Request(`http://localhost/check-session?token=${sessionToken}`));
          const data = await resp.json() as any;
          if (data.valid) {
            hasSession = true;
            loggedIn = true;
          }
        } catch {}
      }
    }

    // 2. 检查 KV 凭证
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      try {
        const creds = JSON.parse(credsRaw);
        accountId = creds.accountId;
        if (creds.createdAt) {
          const age = Date.now() - creds.createdAt;
          const mins = Math.floor(age / 60000);
          loginAgeText = mins < 60 ? `已登录 ${mins} 分钟` : `已登录 ${Math.floor(mins / 60)} 小时`;
        }
        if (creds.createdAt) {
          const hours = (Date.now() - creds.createdAt) / 3600000;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      } catch {}
    }

    // 3. KV 无凭证时，检查 DO SQLite（兜底）
    if (!loggedIn) {
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        const resp = await doStub.fetch(new Request("http://localhost/status"));
        const data = await resp.json() as any;
        if (data.hasCredentials) {
          loggedIn = true;
          tokenHealth = "valid";
          accountId = data.accountId;
        }
      } catch {}
    }

    Logger.info("[check-login] status", { loggedIn, hasAccountId: !!accountId, tokenHealth, hasSession });

    return json({
      loggedIn,
      accountId,
      tokenHealth,
      loginAgeText,
      hasCredentials: loggedIn,
      hasSession,
    });
  } catch (e: any) {
    Logger.error("[check-login] error", { error: e?.message || String(e) });
    return json({ loggedIn: false, error: String(e) });
  }
}
