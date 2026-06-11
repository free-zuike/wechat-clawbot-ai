import { json, verifyAdmin } from "../utils";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

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
  if (!credsRaw) return json({ status: "not_logged_in" });

  let creds: any;
  try { creds = JSON.parse(credsRaw); } catch { return json({ status: "error", message: "凭证格式错误" }); }

  const loginAgeMs = creds.createdAt ? Date.now() - creds.createdAt : null;
  const result: any = {
    loggedIn: true,
    status: "logged_in",
    accountId: creds.accountId,
    baseUrl: creds.baseUrl,
    userId: creds.userId,
    loginAgeMs,
    loginAgeText: loginAgeMs ? formatAge(loginAgeMs) : null,
    hasSyncBuf: !!creds.syncBuf,
  };

  // 可选：检查 token 健康状态
  const url = new URL(request.url);
  const shouldCheck = url.searchParams.get("check") === "1" || url.searchParams.get("checkToken") === "true";
  if (shouldCheck && creds.botToken) {
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
      result.tokenHealth = "error: " + e.message;
    }
  }

  return json(result);
}
