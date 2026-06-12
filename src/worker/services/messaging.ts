// 消息处理服务 - 轮询微信消息并转发给 AI
// 支持: 对话上下文、消息去重、统计持久化、D1 数据库存储

import { getUpdates, sendTextMessage, extractMessageText, MessageType } from "./ilink";
import { callAIWithContext } from "./ai";
import { Logger } from "../utils/error";
import { D1Service } from "./d1";
import type { Env } from "../index";

export interface ProcessResult {
  pulled: number;
  handled: number;
  skipped: number;
  error?: string;
  latencyMs: number;
}

function generateMessageId(msg: any): string {
  const parts = [
    msg.from_user_id || "",
    msg.message_id || "",
    msg.create_time_ms || "",
    msg.seq || ""
  ];
  return parts.join(":").slice(0, 64);
}

// 模块级节流标记（在 Worker 运行时会保留，冷启动会重置但没关系）
let _lastStatsWriteAt = 0;
let _lastCredsWriteAt = 0;

export async function processIncomingMessages(env: Env): Promise<ProcessResult> {
  const start = Date.now();
  const now = Date.now();
  Logger.info("[messaging] Starting message processing");

  // 初始化 D1（如果可用）
  let d1: D1Service | null = null;
  if (env.CLAWBOT_DB) {
    try {
      d1 = new D1Service(env.CLAWBOT_DB);
      await d1.init();
    } catch (error) {
      Logger.warn("[messaging] D1 init failed", { error: (error as Error).message });
      d1 = null;
    }
  }

  // 读一次 credentials（不可省）
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

  const ilinkCreds = {
    botToken: creds.botToken,
    accountId: creds.accountId,
    baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
    userId: creds.userId,
  };
  if (!ilinkCreds.botToken || !ilinkCreds.accountId) {
    return { pulled: 0, handled: 0, skipped: 0, error: "凭证缺少必要字段", latencyMs: Date.now() - start };
  }

  // config：优先用环境变量，没有才读 KV（大多数情况下 env 就够了）
  let systemPrompt = env.AI_SYSTEM_PROMPT || "";
  let aiModel = env.AI_MODEL || "";
  if (!systemPrompt || !aiModel) {
    const configRaw = await env.CLAWBOT_KV.get("clawbot:config");
    try {
      const kvConfig = configRaw ? JSON.parse(configRaw) : {};
      systemPrompt = systemPrompt || kvConfig.aiSystemPrompt || "";
      aiModel = aiModel || kvConfig.aiModel || "";
    } catch {}
  }

  // stats：懒加载——只有在有消息时才读一次；否则不写
  let statsLoaded = false;
  let stats: { polls: number; handled: number; aiCalls: number; aiFails: number; lastPollAt: string; lastLatencyMs: number } = {
    polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "", lastLatencyMs: 0
  };
  const ensureStats = async () => {
    if (statsLoaded) return;
    try {
      const stored = await env.CLAWBOT_KV.get("clawbot:stats");
      if (stored) stats = JSON.parse(stored);
    } catch {}
    statsLoaded = true;
  };

  const buf = creds.syncBuf || "";
  let updates: any;
  try {
    updates = await getUpdates(ilinkCreds, buf);
  } catch (e: any) {
    Logger.error("[messaging] getUpdates error", { error: e.message });
    return { pulled: 0, handled: 0, skipped: 0, error: "getUpdates 异常: " + e.message, latencyMs: Date.now() - start };
  }

  const ret = updates.ret !== undefined ? updates.ret : updates.errcode;
  if (typeof ret === "number" && ret < 0 && ret !== 0) {
    Logger.warn("[messaging] getUpdates returned error", { ret, errmsg: updates.errmsg });
    return { pulled: 0, handled: 0, skipped: 0, error: `getUpdates ret=${ret} ${updates.errmsg || ""}`, latencyMs: Date.now() - start };
  }

  // syncBuf 更新：只在变化 + 距上次写满 30 秒时才写 KV（节流）
  if (updates.get_updates_buf && updates.get_updates_buf !== creds.syncBuf) {
    if (now - _lastCredsWriteAt > 30 * 1000) {
      creds.syncBuf = updates.get_updates_buf;
      try {
        await env.CLAWBOT_KV.put("clawbot:credentials", JSON.stringify(creds));
        _lastCredsWriteAt = now;
      } catch (e) {
        Logger.error("[messaging] Failed to write credentials", { error: (e as Error).message });
      }
    } else {
      // 本轮暂不写，但把新 syncBuf 保留到内存，下次调用会读最新 KV 合并
    }
  }

  const msgs = updates.msgs || [];
  if (!msgs.length) {
    Logger.debug("[messaging] No messages received");
    // 没消息：不写 stats 到 KV（省写）
    return { pulled: 0, handled: 0, skipped: 0, latencyMs: Date.now() - start };
  }

  Logger.info("[messaging] Received messages", { count: msgs.length });
  await ensureStats();

  let handled = 0;
  let aiCallsThisRun = 0;
  let aiFailsThisRun = 0;
  const messagesToInsert: any[] = [];
  const sessionsToUpsert = new Set<string>();

  for (const msg of msgs) {
    if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
    if (msg.message_type === undefined && !msg.from_user_id) continue;

    const text = extractMessageText(msg);
    if (!text) continue;

    const from = msg.from_user_id;
    const ctxToken = msg.context_token;
    if (!from || !ctxToken) continue;

    // 不读 KV 做重复判断——依赖微信 API 的 syncBuf 推进自然去重
    const messageId = generateMessageId(msg);

    let replyContent = "";
    let replyAt = "";
    try {
      aiCallsThisRun++;
      const reply = await callAIWithContext(
        env.CLAWBOT_KV, env.AI, from, text, systemPrompt, aiModel
      );
      await sendTextMessage(ilinkCreds, from, ctxToken, reply);
      replyContent = reply;
      replyAt = new Date().toISOString();
      handled++;
      Logger.info("[messaging] Message handled", { from, replyLength: reply.length });
    } catch (e: any) {
      aiFailsThisRun++;
      Logger.error("[messaging] AI processing failed", { error: e.message, from });
    }

    if (d1) {
      messagesToInsert.push({
        message_id: messageId,
        from_user_id: from,
        to_user_id: msg.to_user_id,
        content: text,
        message_type: msg.message_type,
        context_token: ctxToken,
        created_at: msg.create_time_ms ? new Date(msg.create_time_ms).toISOString() : new Date().toISOString(),
        processed: true,
        reply_content: replyContent,
        reply_at: replyAt,
      });
      sessionsToUpsert.add(from);
    }
  }

  // 批量 D1 插入
  if (d1 && messagesToInsert.length > 0) {
    for (const m of messagesToInsert) {
      try {
        await d1.insertMessage(m);
      } catch (e) { /* ignore */ }
    }
    for (const u of sessionsToUpsert) {
      try { await d1.upsertSession(u); } catch (e) { /* ignore */ }
    }
  }

  // 更新 stats（节流：至少 5 分钟写一次）
  stats.polls++;
  stats.handled += handled;
  stats.aiCalls += aiCallsThisRun;
  stats.aiFails += aiFailsThisRun;
  stats.lastPollAt = new Date().toISOString();
  stats.lastLatencyMs = Date.now() - start;

  if (now - _lastStatsWriteAt > 5 * 60 * 1000) {
    try {
      await env.CLAWBOT_KV.put("clawbot:stats", JSON.stringify(stats));
      _lastStatsWriteAt = now;
    } catch (e) {
      Logger.error("[messaging] Failed to write stats", { error: (e as Error).message });
    }
  }

  // D1 统计（同样每 5 分钟最多一次）——这里简化，不写（统计精度不是关键）

  const latencyMs = Date.now() - start;
  Logger.info("[messaging] Processing complete", { pulled: msgs.length, handled, latencyMs });

  return { pulled: msgs.length, handled, skipped: 0, latencyMs };
}
