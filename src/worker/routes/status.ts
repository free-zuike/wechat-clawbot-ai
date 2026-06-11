import { json } from "../utils";
import type { Env } from "../index";

export async function handleStatus(_request: Request, env: Env): Promise<Response> {
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

  return json({
    loggedIn: !!creds,
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
  });
}
