import { json, verifyAdmin } from "../utils";
import { D1Service } from "../services/d1";
import { Logger } from "../utils/error";
import type { Env } from "../index";

// 统计数据结构（与 messaging.ts 一致）
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

// 状态查询：只读当前状态，不再调用 getUpdates 推进消息游标
export async function handleStatus(request: Request, env: Env): Promise<Response> {
  // 鉴权（通过 session cookie 或管理员密码）
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  let doStatus: any = null;
  try {
    const doId = env.ILINK_CONNECTION.idFromName("main");
    const doStub = env.ILINK_CONNECTION.get(doId);
    const doResp = await doStub.fetch(new Request("http://localhost/status"));
    doStatus = await doResp.json();
  } catch (e) {
    Logger.warn("[status] Failed to query DO status", { error: (e as Error).message });
  }

  if (!credsRaw && !doStatus?.hasCredentials) {
    return json({
      loggedIn: false,
      status: "not_logged_in",
      stats: {
        polls: 0,
        handled: 0,
        aiCalls: 0,
        aiFails: 0,
        lastPollAt: doStatus?.lastPollAt || "",
        lastLatencyMs: 0,
      },
    });
  }

  let creds: any = null;
  if (credsRaw) {
    try {
      creds = JSON.parse(credsRaw);
    } catch {
      return json({ status: "error", message: "凭证格式错误" });
    }
  }

  const loginAgeMs = creds?.createdAt ? Date.now() - creds.createdAt : null;
  
  // 统计以 D1 + DO 为准，不再读旧 KV stats
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
  
  const result: any = {
    loggedIn: !!(credsRaw || doStatus?.hasCredentials),
    status: "logged_in",
    accountId: creds?.accountId,
    baseUrl: creds?.baseUrl,
    userId: creds?.userId,
    loginAgeMs,
    loginAgeText: loginAgeMs ? formatAge(loginAgeMs) : null,
    tokenHealth: getTokenHealth(creds?.createdAt),
    hasSyncBuf: !!(creds?.syncBuf || doStatus?.syncBuf),
    doRunning: !!doStatus?.isRunning,
    consecutiveErrors: doStatus?.consecutiveErrors || 0,
    stats: {
      polls: stats.polls,
      handled: stats.handled,
      aiCalls: stats.aiCalls,
      aiFails: stats.aiFails,
      lastPollAt: stats.lastPollAt,
      lastLatencyMs: stats.lastLatencyMs
    }
  };

  return json(result);
}
