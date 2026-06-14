// 诊断路由

import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

interface DebugResult {
  ok: boolean;
  message?: string;
  networkTest?: boolean;
  getUpdatesResult?: Record<string, unknown>;
  serverTime: string;
}

export async function handleDebugLogin(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[debug] diagnostic request");

  let credsRaw: string | null = null;
  try {
    credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  } catch (e) {
    Logger.warn("[debug] KV read failed", { error: (e as Error).message });
  }

  if (!credsRaw) return json({ ok: false, error: "未登录，没有凭证", serverTime: new Date().toISOString() } satisfies DebugResult);

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(credsRaw);
  } catch (e) {
    return json({ ok: false, error: "凭证格式错误", serverTime: new Date().toISOString() } satisfies DebugResult);
  }

  if (!creds.botToken || !creds.accountId) {
    return json({ ok: false, error: "凭证缺少 botToken 或 accountId", serverTime: new Date().toISOString() } satisfies DebugResult);
  }

  const ilinkCreds = {
    botToken: creds.botToken as string,
    accountId: creds.accountId as string,
    baseUrl: (creds.baseUrl as string) || "https://ilinkai.weixin.qq.com",
    userId: (creds.userId as string) || "",
  };

  let networkOk = false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(ilinkCreds.baseUrl, { signal: ctrl.signal });
    networkOk = r.status < 500;
  } catch (e) {
    Logger.warn("[debug] network test failed", { error: (e as Error).message });
  }

  let getUpdatesResult: Record<string, unknown> = { error: "未执行" };
  try {
    const updates = await getUpdates(ilinkCreds, (creds.syncBuf as string) || "");
    getUpdatesResult = {
      ret: updates.ret,
      errcode: updates.errcode,
      errmsg: updates.errmsg,
      msgsCount: updates.msgs?.length || 0,
      gotNewBuf: !!updates.get_updates_buf,
      success: updates.ret === 0 || updates.errcode === 0 || updates.ret === undefined,
    };
  } catch (e: unknown) {
    getUpdatesResult = { error: e instanceof Error ? e.message : String(e) };
  }

  return json({
    ok: (getUpdatesResult.success as boolean) || false,
    networkTest: networkOk,
    getUpdatesResult,
    serverTime: new Date().toISOString(),
  } satisfies DebugResult);
}
