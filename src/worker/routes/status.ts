import { json } from "../utils";
import { getUpdates } from "../services/ilink";
import type { Env } from "../index";

export async function handleStatus(request: Request, env: Env): Promise<Response> {
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  let creds: any = null;
  try {
    if (credsRaw) creds = JSON.parse(credsRaw);
  } catch {}

  const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
  let kvConfig: any = {};
  try {
    if (configRaw) kvConfig = JSON.parse(configRaw);
  } catch {}

  // 计算登录时长
  let loginAgeMs: number | null = null;
  let loginAgeText = "";
  if (creds?.createdAt) {
    loginAgeMs = Date.now() - creds.createdAt;
    const totalSec = Math.floor(loginAgeMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) {
      loginAgeText = `${hours}小时${mins}分`;
    } else if (mins > 0) {
      loginAgeText = `${mins}分${secs}秒`;
    } else {
      loginAgeText = `${secs}秒`;
    }
  }

  // 可选 token 健康检查（通过 ?checkToken=true 触发，避免频繁调用微信 API）
  const url = new URL(request.url);
  const shouldCheckToken = url.searchParams.get("checkToken") === "true";
  let tokenHealth: "unknown" | "valid" | "expired" | "error" = "unknown";
  if (creds?.token && shouldCheckToken) {
    try {
      const updates = await getUpdates(creds.token, creds.baseUrl, 3000);
      if (updates.ret === 0) {
        tokenHealth = "valid";
      } else if (updates.ret === -14 || updates.ret === -10 || updates.ret < 0) {
        // token 已过期，自动清除
        tokenHealth = "expired";
        await env.CLAWBOT_KV.delete("clawbot:credentials");
        creds = null;
      } else {
        tokenHealth = "error";
      }
    } catch {
      tokenHealth = "error";
    }
  }

  const statsRaw = await env.CLAWBOT_KV.get("clawbot:stats");
  let stats: any = null;
  try {
    if (statsRaw) stats = JSON.parse(statsRaw);
  } catch {}

  return json({
    loggedIn: !!creds,
    tokenHealth,
    loginAgeMs,
    loginAgeText,
    accountId: creds?.accountId || "",
    userIdMasked: creds?.userId ? creds.userId.slice(0, 6) + "***" : "",
    baseUrl: creds?.baseUrl || "",
    loginAt: creds?.createdAt ? new Date(creds.createdAt).toISOString() : "",
    hasAi: !!env.AI,
    hasKv: !!env.CLAWBOT_KV,
    hasDb: !!env.CLAWBOT_DB,
    hasR2: !!env.CLAWBOT_R2,
    hasAdminPwd: !!(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length > 3),
    version: "v2.0-bee-swarm-architecture",
    config: {
      aiModel: env.AI_MODEL || kvConfig.aiModel || "",
      aiSystemPrompt: env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "",
    },
    stats,
  });
}
