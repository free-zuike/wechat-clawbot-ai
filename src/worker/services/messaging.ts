// 消息处理服务 - 轮询微信消息并转发给 AI
import { getUpdates, sendTextMessage, extractMessageText, MessageType } from "./ilink";
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
  if (!credsRaw) return { pulled: 0, handled: 0, error: "未登录", latencyMs: Date.now() - start };

  let creds: any;
  try {
    creds = JSON.parse(credsRaw);
  } catch {
    return { pulled: 0, handled: 0, error: "凭证格式错误", latencyMs: Date.now() - start };
  }

  // 构建 ILinkCredentials
  const ilinkCreds = {
    botToken: creds.botToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: creds.userId,
  };
  if (!ilinkCreds.botToken || !ilinkCreds.accountId) {
    return { pulled: 0, handled: 0, error: "凭证缺少必要字段", latencyMs: Date.now() - start };
  }

  // 2. 从 KV 读取 AI 配置
  const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
  let kvConfig: any = {};
  try { if (configRaw) kvConfig = JSON.parse(configRaw); } catch {}
  const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
  const aiModel = env.AI_MODEL || kvConfig.aiModel || "";

  // 3. 长轮询拉取消息（35秒超时），使用 syncBuf 作为游标
  const buf = creds.syncBuf || "";
  let updates: any;
  try {
    updates = await getUpdates(ilinkCreds, buf);
  } catch (e: any) {
    return { pulled: 0, handled: 0, error: "getUpdates 异常: " + e.message, latencyMs: Date.now() - start };
  }

  // 检查错误码
  const ret = updates.ret !== undefined ? updates.ret : updates.errcode;
  if (ret === -14 || ret === -10 || (typeof ret === "number" && ret < 0 && ret !== 0)) {
    // token 过期或失效，不删除凭证，记录错误供前端显示
    return { pulled: 0, handled: 0, error: `getUpdates ret=${ret} ${updates.errmsg || ""}`, latencyMs: Date.now() - start };
  }

  // 4. 保存新的 syncBuf（断点续传用）
  if (updates.get_updates_buf && updates.get_updates_buf !== creds.syncBuf) {
    creds.syncBuf = updates.get_updates_buf;
    await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
  }

  const msgs = updates.msgs || [];
  if (!msgs.length) {
    return { pulled: 0, handled: 0, latencyMs: Date.now() - start };
  }

  // 5. 处理消息
  let handled = 0;
  for (const msg of msgs) {
    // 只处理用户消息（非 bot 自己发的）
    if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
    if (msg.message_type === undefined && !msg.from_user_id) continue;

    const text = extractMessageText(msg);
    if (!text) continue;

    const from = msg.from_user_id;
    const ctxToken = msg.context_token;
    if (!from || !ctxToken) continue;

    // 调用 AI
    try {
      const reply = await callAI(env.AI, text, systemPrompt, aiModel);
      // 发送回复
      await sendTextMessage(ilinkCreds, from, ctxToken, reply);
      handled++;
    } catch (e: any) {
      console.error("[messaging] AI 处理失败:", e);
    }
  }

  return { pulled: msgs.length, handled, latencyMs: Date.now() - start };
}
