// 检查登录状态 - 前端通过此接口判断是否已扫码登录

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";
    let loginAgeText: string | undefined;

    // 1. KV 凭证检查
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      try {
        const creds = JSON.parse(credsRaw);
        accountId = creds.accountId;
        if (creds.createdAt) {
          const hours = (Date.now() - creds.createdAt) / 3600000;
          const mins = Math.floor((Date.now() - creds.createdAt) / 60000);
          loginAgeText = mins < 60 ? `已登录 ${mins} 分钟` : `已登录 ${Math.floor(hours)} 小时`;
          tokenHealth = hours < 6 ? "valid" : hours < 12 ? "expiring" : "expired";
        }
      } catch {}
    }

    // 2. DO 凭证检查（KV 无凭证时的兜底，也用于 KV 配额耗尽的场景）
    if (!loggedIn) {
      try {
        const doId = env.ILINK_CONNECTION.idFromName("main");
        const doStub = env.ILINK_CONNECTION.get(doId);
        const resp = await doStub.fetch(new Request("http://localhost/status"));
        const data = await resp.json() as any;
        if (data.hasCredentials) {
          loggedIn = true;
          tokenHealth = "valid";
        }
      } catch (e: any) {
        Logger.warn("[check-login] DO status check failed", { error: e.message });
      }
    }

    Logger.info("[check-login] result", { loggedIn });
    return json({ loggedIn, tokenHealth, loginAgeText, hasCredentials: loggedIn, hasSession: loggedIn });
  } catch (e: any) {
    Logger.error("[check-login] error", { error: e?.message || String(e) });
    return json({ loggedIn: false, error: String(e) });
  }
}
