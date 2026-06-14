// 状态查询 - KV为主

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import type { Env } from "../index";

export async function handleStatus(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  let loggedIn = false;
  let accountId: string | undefined;

  try {
    const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
    if (credsRaw) {
      loggedIn = true;
      const creds = JSON.parse(credsRaw);
      accountId = creds.accountId;
    }
  } catch (_e) {}

  // DO 状态（后台轮询信息）
  let doStatus: any = null;
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const doResp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
    doStatus = await doResp.json();
  } catch (_e) {}

  const alertSummary = alertService.getSummary();

  return json({
    loggedIn,
    accountId,
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: doStatus?.consecutiveErrors || 0,
    stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: doStatus?.lastPollAt || "", lastLatencyMs: 0 },
    alerts: { unresolved: alertSummary.unresolved, critical: alertSummary.byLevel.critical, error: alertSummary.byLevel.error, warning: alertSummary.byLevel.warning },
    timestamp: new Date().toISOString(),
  });
}
