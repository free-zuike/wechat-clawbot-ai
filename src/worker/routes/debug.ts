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

  // 返回保存的凭证信息（隐藏敏感字段）
  const savedInfo = {
    hasToken: !!creds.token,
    tokenPrefix: creds.token ? creds.token.slice(0, 20) + "..." : null,
    tokenLength: creds.token ? creds.token.length : 0,
    baseUrl: creds.baseUrl,
    accountId: creds.accountId,
    userId: creds.userId,
    createdAt: creds.createdAt ? new Date(creds.createdAt).toISOString() : null,
    loginAgeMs: creds.createdAt ? Date.now() - creds.createdAt : null,
    // 原始响应字段
    rawFields: creds.rawLoginResponse ? Object.keys(creds.rawLoginResponse) : null,
  };

  // 测试 getUpdates
  if (!creds.token) {
    return json({
      ok: false,
      error: "token 为空",
      savedInfo,
    });
  }

  const baseUrl = creds.baseUrl || "https://ilinkai.weixin.qq.com";
  const testResult = await getUpdates(creds.token, baseUrl, 5000);
  const testOk = testResult.ret === 0;

  return json({
    ok: testOk,
    savedInfo,
    testResult: {
      ret: testResult.ret,
      msgsCount: testResult.msgs?.length || 0,
      msgsSample: testResult.msgs?.slice(0, 2).map((m: any) => ({
        from: m.from_user_id,
        text: m.items?.[0]?.text_item?.text?.slice(0, 50),
      })),
    },
    workerUrl: new URL(request.url).origin,
    timestamp: new Date().toISOString(),
  });
}
