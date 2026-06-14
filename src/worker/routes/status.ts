// 状态查询

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import type { Env } from "../index";

interface StatusResponse {
  loggedIn: boolean;
  accountId?: string;
  doRunning: boolean;
  consecutiveErrors: number;
  stats: { polls: number; handled: number; aiCalls: number; aiFails: number; lastPollAt: string; lastLatencyMs: number };
  alerts: { unresolved: number; critical: number; error: number; warning: number };
  timestamp: string;
}

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
  } catch (e) {
    Logger.warn("[status] KV read failed", { error: (e as Error).message });
  }

  let doStatus: Record<string, unknown> | null = null;
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const doResp = await doStub.fetch(new Request("http://localhost/status"), { signal: AbortSignal.timeout(3000) });
    doStatus = await doResp.json() as Record<string, unknown>;
  } catch (e) {
    Logger.warn("[status] DO status query failed", { error: (e as Error).message });
  }

  const alertSummary = alertService.getSummary();

  const result: StatusResponse = {
    loggedIn,
    accountId,
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: (doStatus?.consecutiveErrors as number) || 0,
    stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: (doStatus?.lastPollAt as string) || "", lastLatencyMs: 0 },
    alerts: { unresolved: alertSummary.unresolved, critical: alertSummary.byLevel.critical, error: alertSummary.byLevel.error, warning: alertSummary.byLevel.warning },
    timestamp: new Date().toISOString(),
  };

  return json(result);
}
