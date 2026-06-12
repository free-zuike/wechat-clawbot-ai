import { json, verifyAdmin } from "../utils";
import { getUpdates } from "../services/ilink";
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

// 状态查询：检查是否登录及 token 健康状态
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

  // 可选：检查 token 健康状态
  const url = new URL(request.url);
  const shouldCheck = url.searchParams.get("check") === "1" || url.searchParams.get("checkToken") === "true";
  if (shouldCheck && creds?.botToken) {
    Logger.info("[status] Checking token health");
    try {
      const ilinkCreds = {
        botToken: creds.botToken,
        accountId: creds.accountId,
        baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
        userId: creds.userId,
      };
      const updates = await getUpdates(ilinkCreds, creds.syncBuf || "");
      const ret = updates.ret !== undefined ? updates.ret : updates.errcode;
      result.tokenHealth = ret === 0 ? "valid" : `invalid(ret=${ret}: ${updates.errmsg || ""}`;
      result.msgsCount = updates.msgs?.length || 0;
      if (updates.get_updates_buf && updates.get_updates_buf !== creds.syncBuf) {
        creds.syncBuf = updates.get_updates_buf;
        await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
        result.bufUpdated = true;
      }
    } catch (e: any) {
      Logger.error("[status] Token health check failed", { error: e.message });
      result.tokenHealth = "error: " + e.message;
    }
  }

  return json(result);
}
