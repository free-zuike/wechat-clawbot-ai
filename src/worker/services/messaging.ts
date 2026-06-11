// 消息处理服务 - 轮询和处理微信消息
import { getUpdates, sendTextMessage, extractMessageText, type ILinkCredentials } from "./ilink";
import { callAI } from "./ai";
import type { Env } from "../index";

export interface ProcessResult {
  pulled: number;
  handled: number;
  error?: string;
  latencyMs: number;
}

export async function processIncomingMessages(env: Env): Promise<ProcessResult> {
  const start = Date.now();
  console.log("[messaging] processIncomingMessages started");

  // 1. 获取凭证
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  console.log("[messaging] credentials found:", !!credsRaw);
  if (!credsRaw) {
    return { pulled: 0, handled: 0, error: "未登录，请先扫码", latencyMs: Date.now() - start };
  }
  let creds: any;
  try {
    creds = JSON.parse(credsRaw);
    console.log("[messaging] credentials saved keys:", Object.keys(creds));
    console.log("[messaging] credentials — token prefix:", creds.token?.slice(0, 15), "baseUrl:", creds.baseUrl, "accountId:", creds.accountId, "userId:", creds.userId, "loginAgeMs:", Date.now() - (creds.createdAt || 0));
    if (creds.rawLoginResponse) {
      console.log("[messaging] raw login response keys:", Object.keys(creds.rawLoginResponse));
    }
  } catch (e) {
    console.error("[messaging] credentials parse error:", e);
    return { pulled: 0, handled: 0, error: "凭证格式错误", latencyMs: Date.now() - start };
  }

  // 2. 从 KV 加载配置
  const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
  let kvConfig: any = {};
  try {
    if (configRaw) kvConfig = JSON.parse(configRaw);
  } catch {}
  const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
  const aiModel = env.AI_MODEL || kvConfig.aiModel || "";
  console.log("[messaging] AI model:", aiModel);

  // 3. 拉取消息 - 优先使用扫码时验证过的 auth/body 配置
  console.log("[messaging] calling getUpdates, has workingAuth:", !!creds.workingAuth, "has workingBody:", !!creds.workingBody);
  const extraBody: any = {};
  if (creds.accountId) extraBody.ilink_bot_id = creds.accountId;
  // 优先使用扫码确认时验证过的配置（creds.workingAuth / creds.workingBody）
  const updates = await getUpdates(
    creds.token,
    creds.baseUrl,
    8000,
    extraBody,
    creds.workingAuth || null,
    creds.workingBody || null
  );
  console.log("[messaging] getUpdates result - ret:", updates.ret, "msgs count:", updates.msgs?.length || 0);

  // 检测 token 是否过期（errcode=-14 是微信 session timeout，负值通常也是认证类错误）
  if (updates.ret === -14 || updates.ret === -10 || updates.ret < 0) {
    console.error("[messaging] token expired (ret=" + updates.ret + "), clearing credentials");
    await env.CLAWBOT_KV.delete("clawbot:credentials");
    return {
      pulled: 0,
      handled: 0,
      error: "token已过期，请重新扫码登录",
      latencyMs: Date.now() - start,
    };
  }

  if (updates.ret !== 0) {
    return {
      pulled: 0,
      handled: 0,
      error: `ret=${updates.ret}`,
      latencyMs: Date.now() - start,
    };
  }

  const msgs = updates.msgs || [];
  msgs.sort((a: any, b: any) => (a.create_time || 0) - (b.create_time || 0));
  console.log("[messaging] sorted messages:", msgs.length);

  // 4. 处理消息
  let handled = 0;
  const handledUsers = new Set<string>();

  for (const msg of msgs) {
    const text = extractMessageText(msg);
    console.log("[messaging] processing message - from:", msg.from_user_id, "text:", text?.slice(0, 50));
    if (!text) continue;

    const from = msg.from_user_id;
    const ctxToken = msg.context_token;

    // 调用 AI 服务
    console.log("[messaging] calling AI for text:", text.slice(0, 50));
    const reply = await callAI(env.AI, text, systemPrompt, aiModel);
    console.log("[messaging] AI reply:", reply.slice(0, 50));

    // 发送回复
    console.log("[messaging] sending reply to:", from);
    await sendTextMessage(creds.token, from, ctxToken, reply, creds.baseUrl);
    handled++;
    handledUsers.add(from);

    // 每条消息之间小延迟，避免被限流
    if (handledUsers.size > 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("[messaging] done - handled:", handled, "latency:", Date.now() - start, "ms");
  return {
    pulled: msgs.length,
    handled,
    latencyMs: Date.now() - start,
  };
}
