// 检查登录状态 - 前端通过此接口判断是否已扫码登录

import { json, verifyAdmin, clearSessionCookie } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

// 检查登录状态
// 返回 { loggedIn: boolean, accountId?: string, tokenHealth?: string, loginAgeText?: string }
export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    // 优先使用 verifyAdmin（支持 cookie session 和 密码），但我们这里不返回 401，而是返回状态
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";
    let loginAgeText: string | undefined;

    // 检查凭证
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
        // ILink token 有效期通常较短，简单判断
        if (creds.createdAt) {
          const age = Date.now() - creds.createdAt;
          const hours = age / 3600000;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      } catch {
        // ignore
      }
    }

    // 检查 session cookie（前端面板鉴权）
    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionMatch = cookieHeader.match(/clawbot_session=([^;]+)/);
    if (sessionMatch) {
      const sessionToken = sessionMatch[1];
      const sessionValid = await env.CLAWBOT_KV.get(`clawbot:session:${sessionToken}`);
      if (sessionValid) {
        loggedIn = loggedIn || true;
      }
    }

    Logger.info('[check-login] status', { loggedIn, hasAccountId: !!accountId, tokenHealth });

    return json({
      loggedIn,
      accountId,
      tokenHealth,
      loginAgeText,
      hasCredentials: !!credsRaw,
      hasSession: !!sessionMatch,
    });
  } catch (e: any) {
    Logger.error('[check-login] error', { error: e?.message || String(e) });
    // 出错时不要返回错误，而是返回未登录状态，避免前端卡死
    return json({ loggedIn: false, error: String(e) });
  }
}
