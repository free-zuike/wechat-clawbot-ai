import { json, verifyAdmin } from "../utils";
import { D1Service } from "../services/d1";
import { Logger } from "../utils/error";
import { alertService } from "../utils/alert";
import type { Env } from "../index";

interface Stats {
  polls: number;
  handled: number;
  aiCalls: number;
  aiFails: number;
  lastPollAt: string;
  lastLatencyMs: number;
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分钟";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "小时";
  const d = Math.floor(h / 24);
  return d + "天";
}

function getTokenHealth(createdAt?: number): string {
  if (!createdAt) return "unknown";
  const ageHours = (Date.now() - createdAt) / 3600000;
  if (ageHours < 6) return "valid";
  if (ageHours < 12) return "expiring";
  return "expired";
}

export async function handleStatus(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  // KV 状态
  let kvOk = true;
  let credsRaw: string | null = null;
  try {
    credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  } catch {
    kvOk = false;
  }

  // DO 状态
  let doStatus: any = null;
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const doResp = await doStub.fetch(new Request("http://localhost/status"));
    doStatus = await doResp.json();
  } catch (e) {
    Logger.warn("[status] Failed to query DO status", { error: (e as Error).message });
  }

  const loggedIn = !!(credsRaw || doStatus?.hasCredentials);

  if (!loggedIn) {
    return json({
      loggedIn: false,
      kv: kvOk ? "OK" : "FAIL",
      stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "", lastLatencyMs: 0 },
      alerts: { unresolved: 0, critical: 0, error: 0, warning: 0 },
      timestamp: new Date().toISOString(),
    });
  }

  let creds: any = null;
  if (credsRaw) {
    try { creds = JSON.parse(credsRaw); } catch {}
  }

  const loginAgeMs = creds?.createdAt ? Date.now() - creds.createdAt : null;

  // D1 统计
  let stats: Stats = { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "", lastLatencyMs: 0 };
  try {
    if (env.CLAWBOT_DB) {
      const d1 = new D1Service(env.CLAWBOT_DB);
      await d1.init();
      const totalStats = await d1.getTotalStats();
      stats = {
        polls: totalStats.polls,
        handled: totalStats.handled,
        aiCalls: totalStats.aiCalls,
        aiFails: totalStats.aiFails,
        lastPollAt: doStatus?.lastPollAt || "",
        lastLatencyMs: 0,
      };
    } else if (doStatus?.lastPollAt) {
      stats.lastPollAt = doStatus.lastPollAt;
    }
  } catch (e) {
    Logger.warn("[status] Error loading D1 stats", { error: (e as Error).message });
  }

  // 报警统计
  const alertSummary = alertService.getSummary();

  return json({
    loggedIn: true,
    kv: kvOk ? "OK" : "FAIL",
    accountId: creds?.accountId,
    baseUrl: creds?.baseUrl,
    userId: creds?.userId,
    loginAgeMs,
    loginAgeText: loginAgeMs ? formatAge(loginAgeMs) : null,
    tokenHealth: getTokenHealth(creds?.createdAt),
    hasSyncBuf: !!(creds?.syncBuf || doStatus?.syncBuf),
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: doStatus?.consecutiveErrors || 0,
    stats,
    alerts: {
      unresolved: alertSummary.unresolved,
      critical: alertSummary.byLevel.critical,
      error: alertSummary.byLevel.error,
      warning: alertSummary.byLevel.warning,
    },
    timestamp: new Date().toISOString(),
  });
}
