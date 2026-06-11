import { json } from "../utils";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

// 诊断登录状态
export async function handleDebugLogin(request: Request, env: Env): Promise<Response> {
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  if (!credsRaw) return json({ ok: false, error: "未登录，没有凭证" });

  let creds: any;
  try { creds = JSON.parse(credsRaw); } catch (e) { return json({ ok: false, error: "凭证格式错误: " + e }); }

  const savedInfo = {
    botTokenPrefix: creds.botToken ? creds.botToken.slice(0, 20) + "..." : null,
    botTokenLen: creds.botToken?.length || 0,
    baseUrl: creds.baseUrl,
    accountId: creds.accountId,
    userId: creds.userId,
    syncBuf: creds.syncBuf ? (creds.syncBuf.slice(0, 40) + "...") : "(empty)",
    loginAgeMs: creds.createdAt ? Date.now() - creds.createdAt : null,
    rawResponseKeys: creds.rawLoginResponse ? Object.keys(creds.rawLoginResponse) : null,
  };

  if (!creds.botToken || !creds.accountId) {
    return json({ ok: false, error: "凭证缺少 botToken 或 accountId", savedInfo });
  }

  const ilinkCreds = {
    botToken: creds.botToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: creds.userId,
  };

  // 1. 网络连通性测试（快速 GET）
  let networkOk = false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(ilinkCreds.baseUrl, { signal: ctrl.signal });
    networkOk = r.status < 500;
  } catch {}

  // 2. 调用 getupdates（使用新协议实现）
  let getUpdatesResult: any = { error: "未执行" };
  try {
    const updates = await getUpdates(ilinkCreds, creds.syncBuf || "");
    getUpdatesResult = {
      ret: updates.ret,
      errcode: updates.errcode,
      errmsg: updates.errmsg,
      msgsCount: updates.msgs?.length || 0,
      gotNewBuf: !!updates.get_updates_buf,
      success: updates.ret === 0 || updates.errcode === 0 || updates.ret === undefined,
    };
  } catch (e: any) {
    getUpdatesResult = { error: e.message };
  }

  return json({
    ok: getUpdatesResult.success || false,
    savedInfo,
    networkTest: networkOk,
    getUpdatesResult,
    serverTime: new Date().toISOString(),
  });
}
