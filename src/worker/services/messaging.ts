// 消息处理服务 - 轮询微信消息并转发给 AI
// 支持: 对话上下文、消息去重、统计持久化

import { getUpdates, sendTextMessage, extractMessageText, MessageType } from "./ilink";
import { callAIWithContext } from "./ai";
import { Logger } from "../utils/error";
import type { Env } from "../index";

export interface ProcessResult {
  pulled: number;
  handled: number;
  skipped: number; // 新增：跳过的重复消息
  error?: string;
  latencyMs: number;
}

// 消息去重：生成消息唯一 ID
function generateMessageId(msg: any): string {
  // 使用 from_user_id + message_id + create_time_ms 作为唯一标识
  const parts = [
    msg.from_user_id || "",
    msg.message_id || "",
    msg.create_time_ms || "",
    msg.seq || ""
  ];
  return parts.join(":").slice(0, 64);
}

// 检查消息是否已处理（去重）
async function isMessageProcessed(kv: KVNamespace, messageId: string): Promise<boolean> {
  const key = `clawbot:processed:${messageId}`;
  const exists = await kv.get(key);
  return exists !== null;
}

// 标记消息已处理
async function markMessageProcessed(kv: KVNamespace, messageId: string): Promise<void> {
  const key = `clawbot:processed:${messageId}`;
  // 保留 5 分钟的去重窗口
  await kv.put(key, "1", { expirationTtl: 300 });
}

// 统计数据持久化
interface Stats {
  polls: number;
  handled: number;
  aiCalls: number;
  aiFails: number;
  lastPollAt: string;
  lastLatencyMs: number;
}

async function loadStats(kv: KVNamespace): Promise<Stats> {
  const stored = await kv.get("clawbot:stats");
  if (stored) {
    return JSON.parse(stored);
  }
  return {
    polls: 0,
    handled: 0,
    aiCalls: 0,
    aiFails: 0,
    lastPollAt: "",
    lastLatencyMs: 0
  };
}

async function saveStats(kv: KVNamespace, stats: Stats): Promise<void> {
  await kv.put("clawbot:stats", JSON.stringify(stats));
}

export async function processIncomingMessages(env: Env): Promise<ProcessResult> {
  const start = Date.now();
  Logger.info("[messaging] Starting message processing");

  // 1. 获取凭证
  const credsRaw = await env.CLAWBOT_KV.get("clawbot:credentials");
  if (!credsRaw) {
    Logger.warn("[messaging] No credentials found");
    return { pulled: 0, handled: 0, skipped: 0, error: "未登录", latencyMs: Date.now() - start };
  }

  let creds: any;
  try {
    creds = JSON.parse(credsRaw);
  } catch {
    Logger.error("[messaging] Invalid credentials format");
    return { pulled: 0, handled: 0, skipped: 0, error: "凭证格式错误", latencyMs: Date.now() - start };
  }

  // 构建 ILinkCredentials
  const ilinkCreds = {
    botToken: creds.botToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: creds.userId,
  };
  if (!ilinkCreds.botToken || !ilinkCreds.accountId) {
    Logger.error("[messaging] Missing required credential fields");
    return { pulled: 0, handled: 0, skipped: 0, error: "凭证缺少必要字段", latencyMs: Date.now() - start };
  }

  // 2. 从 KV 读取 AI 配置
  const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
  let kvConfig: any = {};
  try { if (configRaw) kvConfig = JSON.parse(configRaw); } catch {}
  const systemPrompt = env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
  const aiModel = env.AI_MODEL || kvConfig.aiModel || "";

  // 3. 加载统计数据
  const stats = await loadStats(env.CLAWBOT_KV);

  // 4. 长轮询拉取消息（35秒超时），使用 syncBuf 作为游标
  const buf = creds.syncBuf || "";
  let updates: any;
  try {
    updates = await getUpdates(ilinkCreds, buf);
    stats.polls++;
  } catch (e: any) {
    Logger.error("[messaging] getUpdates error", { error: e.message });
    return { pulled: 0, handled: 0, skipped: 0, error: "getUpdates 异常: " + e.message, latencyMs: Date.now() - start };
  }

  // 检查错误码
  const ret = updates.ret !== undefined ? updates.ret : updates.errcode;
  if (ret === -14 || ret === -10 || (typeof ret === "number" && ret < 0 && ret !== 0)) {
    Logger.warn("[messaging] getUpdates returned error", { ret, errmsg: updates.errmsg });
    return { pulled: 0, handled: 0, skipped: 0, error: `getUpdates ret=${ret} ${updates.errmsg || ""}`, latencyMs: Date.now() - start };
  }

  // 5. 保存新的 syncBuf（断点续传用）
  if (updates.get_updates_buf && updates.get_updates_buf !== creds.syncBuf) {
    creds.syncBuf = updates.get_updates_buf;
    await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
    Logger.debug("[messaging] syncBuf updated");
  }

  const msgs = updates.msgs || [];
  if (!msgs.length) {
    Logger.debug("[messaging] No messages received");
    stats.lastPollAt = new Date().toISOString();
    stats.lastLatencyMs = Date.now() - start;
    await saveStats(env.CLAWBOT_KV, stats);
    return { pulled: 0, handled: 0, skipped: 0, latencyMs: Date.now() - start };
  }

  Logger.info("[messaging] Received messages", { count: msgs.length });

  // 6. 处理消息（带去重和上下文）
  let handled = 0;
  let skipped = 0;
  for (const msg of msgs) {
    // 只处理用户消息（非 bot 自己发的）
    if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
    if (msg.message_type === undefined && !msg.from_user_id) continue;

    const text = extractMessageText(msg);
    if (!text) continue;

    const from = msg.from_user_id;
    const ctxToken = msg.context_token;
    if (!from || !ctxToken) continue;

    // 消息去重检查
    const messageId = generateMessageId(msg);
    if (await isMessageProcessed(env.CLAWBOT_KV, messageId)) {
      Logger.debug("[messaging] Skipping duplicate message", { messageId });
      skipped++;
      continue;
    }

    // 调用 AI（带上下文）
    try {
      stats.aiCalls++;
      const reply = await callAIWithContext(
        env.CLAWBOT_KV,
        env.AI,
        from,
        text,
        systemPrompt,
        aiModel
      );
      
      // 发送回复
      await sendTextMessage(ilinkCreds, from, ctxToken, reply);
      handled++;
      stats.handled++;
      
      // 标记消息已处理
      await markMessageProcessed(env.CLAWBOT_KV, messageId);
      
      Logger.info("[messaging] Message handled", { from, replyLength: reply.length });
    } catch (e: any) {
      stats.aiFails++;
      Logger.error("[messaging] AI processing failed", { error: e.message, from });
    }
  }

  // 7. 保存统计数据
  stats.lastPollAt = new Date().toISOString();
  stats.lastLatencyMs = Date.now() - start;
  await saveStats(env.CLAWBOT_KV, stats);

  const latencyMs = Date.now() - start;
  Logger.info("[messaging] Processing complete", { pulled: msgs.length, handled, skipped, latencyMs });

  return { pulled: msgs.length, handled, skipped, latencyMs };
}
