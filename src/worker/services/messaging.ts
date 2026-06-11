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

  // 1. 获取凭证
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  if (!credsRaw) {
    return { pulled: 0, handled: 0, error: "未登录，请先扫码", latencyMs: Date.now() - start };
  }
  let creds: ILinkCredentials;
  try {
    creds = JSON.parse(credsRaw);
  } catch {
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

  // 3. 拉取消息
  const updates = await getUpdates(creds.token, creds.baseUrl, 4000);

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

  // 4. 处理消息
  let handled = 0;
  const handledUsers = new Set<string>();

  for (const msg of msgs) {
    const text = extractMessageText(msg);
    if (!text) continue;

    const from = msg.from_user_id;
    const ctxToken = msg.context_token;

    // 调用 AI 服务
    const reply = await callAI(env.AI, text, systemPrompt, aiModel);

    // 发送回复
    await sendTextMessage(creds.token, from, ctxToken, reply, creds.baseUrl);
    handled++;
    handledUsers.add(from);

    // 每条消息之间小延迟，避免被限流
    if (handledUsers.size > 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return {
    pulled: msgs.length,
    handled,
    latencyMs: Date.now() - start,
  };
}
