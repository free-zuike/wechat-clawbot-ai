// 状态查询 - 只读 DO 状态

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import type { Env } from "../index";

export async function handleStatus(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  let doStatus: any = null;
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const doResp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
    doStatus = await doResp.json();
  } catch (e) {
    Logger.warn("[status] Failed to query DO", { error: (e as Error).message });
  }

  const loggedIn = !!doStatus?.hasCredentials;

  if (!loggedIn) {
    return json({ loggedIn: false, stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "", lastLatencyMs: 0 }, alerts: { unresolved: 0, critical: 0, error: 0, warning: 0 }, timestamp: new Date().toISOString() });
  }

  const alertSummary = alertService.getSummary();

  return json({
    loggedIn: true,
    accountId: doStatus?.accountId,
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: doStatus?.consecutiveErrors || 0,
    stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: doStatus?.lastPollAt || "", lastLatencyMs: 0 },
    alerts: { unresolved: alertSummary.unresolved, critical: alertSummary.byLevel.critical, error: alertSummary.byLevel.error, warning: alertSummary.byLevel.warning },
    timestamp: new Date().toISOString(),
  });
}
