// 状态查询 — 只查 DO

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
  // status 是只读端点，不需要严格认证

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

  const result = {
    loggedIn: !!doStatus?.hasCredentials,
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: (doStatus?.consecutiveErrors as number) || 0,
    stats: {
      polls: (doStatus?.stats as any)?.polls || 0,
      handled: (doStatus?.stats as any)?.handled || 0,
      aiCalls: (doStatus?.stats as any)?.aiCalls || 0,
      aiFails: (doStatus?.stats as any)?.aiFails || 0,
      lastPollAt: (doStatus?.lastPollAt as string) || "",
      lastLatencyMs: (doStatus?.stats as any)?.lastLatencyMs || 0,
    },
    alerts: { unresolved: alertSummary.unresolved, critical: alertSummary.byLevel.critical, error: alertSummary.byLevel.error, warning: alertSummary.byLevel.warning },
    kv: "OK",
    hasBotCredentials: !!doStatus?.hasCredentials,
    timestamp: new Date().toISOString(),
  };

  return json(result);
}
