import { json, verifyAdmin } from "../utils";
import { Logger } from "../utils/error";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

export async function handleDebugLogin(request: Request, env: Env): Promise<Response> {
  const v = await verifyAdmin(request, env);
  if (!v.ok) return json({ error: v.error }, 401);

  Logger.info("[debug-login] diagnostic request");

  let credsRaw: string | null = null;
  try { credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials"); } catch (_e) {}
  if (!credsRaw) return json({ ok: false, error: "未登录，没有凭证" });

  let creds: any;
  try { creds = JSON.parse(credsRaw); } catch (e) { return json({ ok: false, error: "凭证格式错误: " + e }); }

  if (!creds.botToken || !creds.accountId) {
    return json({ ok: false, error: "凭证缺少 botToken 或 accountId" });
  }

  const ilinkCreds = { botToken: creds.botToken, accountId: creds.accountId, baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com", userId: creds.userId };

  let networkOk = false;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(ilinkCreds.baseUrl, { signal: ctrl.signal });
    networkOk = r.status < 500;
  } catch (_e) {}

  let getUpdatesResult: any = { error: "未执行" };
  try {
    const updates = await getUpdates(ilinkCreds, creds.syncBuf || "");
    getUpdatesResult = {
      ret: updates.ret, errcode: updates.errcode, errmsg: updates.errmsg,
      msgsCount: updates.msgs?.length || 0, gotNewBuf: !!updates.get_updates_buf,
      success: updates.ret === 0 || updates.errcode === 0 || updates.ret === undefined,
    };
  } catch (e: any) {
    getUpdatesResult = { error: e.message };
  }

  return json({ ok: getUpdatesResult.success || false, networkTest: networkOk, getUpdatesResult, serverTime: new Date().toISOString() });
}
