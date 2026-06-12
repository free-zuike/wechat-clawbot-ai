// 检查登录状态 - 前端通过此接口判断是否已扫码登录
// 优化：session 检查优先用 Upstash，兜底用 KV

import { json } from "../utils";
import { Logger } from "../utils/error";
import { getUpstashService } from "../services/upstash";
import type { Env } from "../index";

// 检查登录状态
export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";
    let loginAgeText: string | undefined;
    let hasSession = false;

    // 检查凭证（从 KV 读）
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      try {
        const creds = JSON.parse(credsRaw);
        accountId = creds.accountId;
        if (creds.createdAt) {
          const age = Date.now() - creds.createdAt;
          const mins = Math.floor(age / 60000);
          if (mins < 60) {
            loginAgeText = `已登录 ${mins} 分钟`;
          } else {
            const hours = Math.floor(mins / 60);
            loginAgeText = `已登录 ${hours} 小时`;
          }
        }
        // ILink token 有效期判断
        if (creds.createdAt) {
          const age = Date.now() - creds.createdAt;
          const hours = age / 3600000;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      } catch {
        // ignore
      }
    }

    // 检查 session cookie（优先 Upstash，兜底 KV）
    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
    if (sessionMatch) {
      const sessionToken = sessionMatch[1];
      const upstash = getUpstashService(env);
      let sessionValid = await upstash.get(`clawbot:session:${sessionToken}`);
      if (sessionValid === null) {
        sessionValid = await env.CLAWBOT_KV?.get(`clawbot:session:${sessionToken}`);
      }
      if (sessionValid) {
        hasSession = true;
        loggedIn = true;
      }
    }

    Logger.info("[check-login] status", { loggedIn, hasAccountId: !!accountId, tokenHealth, hasSession });

    return json({
      loggedIn,
      accountId,
      tokenHealth,
      loginAgeText,
      hasCredentials: !!credsRaw,
      hasSession,
    });
  } catch (e: any) {
    Logger.error("[check-login] error", { error: e?.message || String(e) });
    return json({ loggedIn: false, error: String(e) });
  }
}
