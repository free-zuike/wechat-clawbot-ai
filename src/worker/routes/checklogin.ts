// 检查登录状态

import { json } from "../utils";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export async function handleCheckLogin(request: Request, env: Env): Promise<Response> {
  try {
    let loggedIn = false;
    let accountId: string | undefined;
    let tokenHealth: string = "unknown";

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

    Logger.info("[check-login] result", { loggedIn });
    return json({ loggedIn, tokenHealth, hasCredentials: loggedIn, hasSession: loggedIn });
  } catch (e: any) {
    return json({ loggedIn: false, error: e?.message || String(e) });
  }
}
