import { json } from "../utils";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

// 诊断登录状态：检查保存的凭证是否正确，测试 getUpdates 是否能正常工作
export async function handleDebugLogin(request: Request, env: Env): Promise<Response> {
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  if (!credsRaw) {
    return json({ ok: false, error: "未登录，没有凭证" });
  }

  let creds: any;
  try {
    creds = JSON.parse(credsRaw);
  } catch (e) {
    return json({ ok: false, error: "凭证格式错误: " + String(e) });
  }

  const savedInfo = {
    hasToken: !!creds.token,
    tokenPrefix: creds.token ? creds.token.slice(0, 20) + "..." : null,
    tokenLength: creds.token ? creds.token.length : 0,
    baseUrl: creds.baseUrl,
    accountId: creds.accountId,
    userId: creds.userId,
    createdAt: creds.createdAt ? new Date(creds.createdAt).toISOString() : null,
    loginAgeMs: creds.createdAt ? Date.now() - creds.createdAt : null,
    rawFields: creds.rawLoginResponse ? Object.keys(creds.rawLoginResponse) : null,
  };

  if (!creds.token) {
    return json({ ok: false, error: "token 为空", savedInfo });
  }

  const baseUrl = creds.baseUrl || "https://ilinkai.weixin.qq.com";

  // 测试 1: 纯网络连通性
  let networkTest = { ok: false, status: 0, error: "" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(baseUrl, { signal: ctrl.signal });
    clearTimeout(t);
    const text = await r.text();
    networkTest = { ok: r.ok, status: r.status, error: text.slice(0, 200) };
  } catch (e: any) {
    networkTest = { ok: false, status: 0, error: e.message };
  }

  // 测试 2: getUpdates（会尝试多种认证方式）
  const testResult = await getUpdates(creds.token, baseUrl, 15000, { ilink_bot_id: creds.accountId });
  const testOk = testResult.ret === 0;

  return json({
    ok: testOk,
    savedInfo,
    networkTest,
    testResult: {
      ret: testResult.ret,
      msgsCount: testResult.msgs?.length || 0,
    },
    workerUrl: new URL(request.url).origin,
    timestamp: new Date().toISOString(),
  });
}
