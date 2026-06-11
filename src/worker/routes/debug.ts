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
    rawLoginValues: creds.rawLoginResponse
      ? Object.fromEntries(
          Object.entries(creds.rawLoginResponse).map(([k, v]: [string, any]) => {
            if (typeof v === "string") return [k, v.length > 40 ? v.slice(0, 40) + "..." : v];
            if (typeof v === "number" || typeof v === "boolean") return [k, v];
            return [k, typeof v];
          })
        )
      : null,
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

  // 测试 2: 先尝试一些可能的 token/refresh 接口（获取持久化token）
  const fullToken = creds.token || "";
  const tokenParts = fullToken.split(":");
  const tokenAfterColon = tokenParts.length >= 2 ? tokenParts.slice(1).join(":") : fullToken;

  const authEndpoints = [
    { name: "POST /ilink/bot/gettoken", path: "/ilink/bot/gettoken" },
    { name: "POST /ilink/bot/refresh", path: "/ilink/bot/refresh" },
    { name: "POST /ilink/bot/auth", path: "/ilink/bot/auth" },
    { name: "POST /ilink/bot/login", path: "/ilink/bot/login" },
  ];
  const authResults: any[] = [];
  for (const ep of authEndpoints) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${baseUrl}${ep.path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAfterColon}`,
          "iLink-App-ClientVersion": "1",
        },
        body: JSON.stringify({ ilink_bot_id: creds.accountId, bot_token: fullToken }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const text = await r.text();
      authResults.push({
        name: ep.name,
        httpStatus: r.status,
        response: text.slice(0, 200),
      });
    } catch (e: any) {
      authResults.push({ name: ep.name, error: e.message });
    }
  }

  // 测试 3: 更多 getupdates 变体 - 探索可能需要的初始化/激活步骤
  const variants = [
    {
      name: "A. 完整token + Bearer + 空buf",
      auth: `Bearer ${fullToken}`,
      body: { get_updates_buf: "" },
    },
    {
      name: "B. 冒号后部分 + Bearer + ilink_bot_id",
      auth: `Bearer ${tokenAfterColon}`,
      body: { get_updates_buf: "", ilink_bot_id: creds.accountId },
    },
    {
      name: "C. 冒号后部分 + Bearer + 全字段",
      auth: `Bearer ${tokenAfterColon}`,
      body: { get_updates_buf: "", ilink_bot_id: creds.accountId, ilink_user_id: creds.userId },
    },
    {
      name: "D. 冒号后部分 + Bot prefix + bot_token",
      auth: `Bot ${tokenAfterColon}`,
      body: { get_updates_buf: "", bot_token: fullToken, ilink_bot_id: creds.accountId },
    },
    {
      name: "E. 冒号后部分 + Bearer + buf=base64('open')",
      auth: `Bearer ${tokenAfterColon}`,
      body: { get_updates_buf: "b3Blbg==", ilink_bot_id: creds.accountId },
    },
    {
      name: "F. 冒号后部分 + Bearer + buf=bot_token",
      auth: `Bearer ${tokenAfterColon}`,
      body: { get_updates_buf: fullToken, ilink_bot_id: creds.accountId },
    },
    {
      name: "G. 无auth + bot_token + ilink_bot_id",
      auth: null,
      body: { get_updates_buf: "", bot_token: fullToken, ilink_bot_id: creds.accountId, ilink_user_id: creds.userId },
    },
    {
      name: "H. GET 方式",
      auth: `Bearer ${tokenAfterColon}`,
      body: null,
      method: "GET",
    },
    {
      name: "I. ilink_bot_id 也加 Authorization",
      auth: `${creds.accountId} ${tokenAfterColon}`,
      body: { get_updates_buf: "" },
    },
  ];

  const variantResults: any[] = [];
  let bestOk = false;
  for (const v of variants) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "iLink-App-ClientVersion": "1",
      };
      if (v.auth) headers["Authorization"] = v.auth;
      const method = (v as any).method || "POST";
      const fetchOpts: any = { method, headers, signal: ctrl.signal };
      if (method === "POST" && v.body) fetchOpts.body = JSON.stringify(v.body);
      const r = await fetch(`${baseUrl}/ilink/bot/getupdates`, fetchOpts);
      clearTimeout(t);
      const text = await r.text();
      let ret: any = r.status;
      let msgs = 0;
      try {
        const parsed = JSON.parse(text);
        ret = parsed.ret !== undefined ? parsed.ret : parsed.errcode;
        msgs = parsed.msgs?.length || 0;
      } catch {}
      variantResults.push({
        name: v.name,
        httpStatus: r.status,
        ret,
        msgsCount: msgs,
        responsePreview: text.slice(0, 120),
      });
      if (ret === 0) {
        bestOk = true;
        break;
      }
    } catch (e: any) {
      variantResults.push({ name: v.name, error: e.message });
    }
  }

  return json({
    ok: bestOk,
    savedInfo,
    networkTest,
    tokenAnalysis: {
      fullToken: fullToken.slice(0, 30) + "...",
      partAfterColon: tokenAfterColon.slice(0, 30) + "...",
    },
    authEndpointTest: authResults,
    variantResults,
    workerUrl: new URL(request.url).origin,
    timestamp: new Date().toISOString(),
  });
}
