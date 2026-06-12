// iLink Durable Object - 管理微信机器人的长轮询连接
// 架构：DO 替代 Cron 轮询，实现消息实时接收

import { Logger } from "../utils/error";
import { getUpdates, sendTextMessage, extractMessageText, MessageType } from "./ilink";
import { callAIWithContext } from "./ai";
import { D1Service } from "./d1";
import type { ILinkCredentials, WeixinMessage } from "../types";

export interface ILINKSessionState {
  syncBuf: string;
  lastPollAt: string;
  consecutiveErrors: number;
  isRunning: boolean;
  pendingMessages: ProcessedMessage[];
}

export interface ProcessedMessage {
  messageId: string;
  fromUserId: string;
  content: string;
  timestamp: string;
  replyContent?: string;
  replyAt?: string;
  processed: boolean;
}

// 内存缓存（避免每轮都读 KV，降低免费额度消耗）
interface RuntimeCache {
  credentials: { botToken: string; accountId: string; baseUrl: string; userId: string; syncBuf: string } | null;
  credentialsLoadedAt: number;
  config: { aiSystemPrompt: string; aiModel: string } | null;
  configLoadedAt: number;
  stats: { polls: number; handled: number; aiCalls: number; aiFails: number; lastPollAt: string };
  statsLoadedAt: number;
  statsDirty: boolean;
  lastStatsWriteAt: number;
  contextCache: Map<string, { data: any; lastRead: number }>;
  processedIds: Set<string>;
  lastCredWriteAt: number;
}

export class ILinkConnectionDO implements DurableObject {
  private state: ILINKSessionState;
  private env: any;
  private ilinkCreds: ILinkCredentials | null = null;
  private d1: D1Service | null = null;
  private pollLoopRunning = false;
  private kv: KVNamespace | null = null;
  private cache: RuntimeCache = {
    credentials: null,
    credentialsLoadedAt: 0,
    config: null,
    configLoadedAt: 0,
    stats: { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "" },
    statsLoadedAt: 0,
    statsDirty: false,
    lastStatsWriteAt: 0,
    contextCache: new Map(),
    processedIds: new Set(),
    lastCredWriteAt: 0,
  };

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.kv = env.CLAWBOT_KV;

    // 从 Durable Object 存储恢复状态
    const stored = state.storage.get<ILINKSessionState>("session").catch(() => null);
    this.state = {
      syncBuf: "",
      lastPollAt: "",
      consecutiveErrors: 0,
      isRunning: false,
      pendingMessages: [],
      ...this.state,
    };
  }

  // ========== HTTP 处理（长轮询入口）==========

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 初始化凭证
    await this.initCredentials();
    if (!this.ilinkCreds) {
      return new Response(JSON.stringify({ error: "未登录或凭证无效" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 路由分发
    switch (url.pathname) {
      case "/poll":
        return this.handleLongPoll();
      case "/send":
        return this.handleSend(request);
      case "/status":
        return this.handleStatus();
      case "/flush":
        return this.handleFlush();
      default:
        return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
    }
  }

  // ========== 长轮询：阻塞直到有新消息 ==========

  private async handleLongPoll(): Promise<Response> {
    Logger.info("[DO] Starting long poll");

    // 确保轮询循环在运行
    if (!this.pollLoopRunning) {
      this.pollLoopRunning = true;
      // 异步启动轮询循环（不阻塞）
      this.runPollLoop().catch((e) => {
        Logger.error("[DO] Poll loop error", { error: e.message });
        this.pollLoopRunning = false;
      });
    }

    // 等待新消息到达或超时
    const deadline = Date.now() + 60000; // 最多等 60 秒

    while (Date.now() < deadline) {
      if (this.state.pendingMessages.length > 0) {
        // 有待处理的消息
        const msg = this.state.pendingMessages.shift()!;
        return new Response(JSON.stringify({
          success: true,
          message: msg,
          queueLength: this.state.pendingMessages.length,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // 等待 1 秒后重试
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // 超时，返回空
    return new Response(JSON.stringify({
      success: true,
      message: null,
      queueLength: this.state.pendingMessages.length,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== 发送消息 ==========

  private async handleSend(request: Request): Promise<Response> {
    if (!this.ilinkCreds) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = await request.json();
      const { toUserId, contextToken, text } = body;

      if (!toUserId || !text) {
        return new Response(JSON.stringify({ error: "缺少参数" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      await sendTextMessage(this.ilinkCreds, toUserId, contextToken || "", text);

      // 立即触发一次轮询，检测是否有新消息
      this.triggerImmediatePoll();

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      Logger.error("[DO] Send error", { error: e.message });
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ========== 查询状态 ==========

  private async handleStatus(): Promise<Response> {
    return new Response(JSON.stringify({
      success: true,
      isRunning: this.pollLoopRunning,
      syncBuf: this.state.syncBuf ? "***" + this.state.syncBuf.slice(-8) : "",
      lastPollAt: this.state.lastPollAt,
      consecutiveErrors: this.state.consecutiveErrors,
      pendingMessages: this.state.pendingMessages.length,
      hasCredentials: !!this.ilinkCreds,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== 立即触发一次轮询（用于发送消息后）==========

  private triggerImmediatePoll(): void {
    if (!this.pollLoopRunning) {
      this.pollLoopRunning = true;
      this.runPollLoop().catch((e) => {
        Logger.error("[DO] Poll loop error", { error: e.message });
        this.pollLoopRunning = false;
      });
    }
  }

  // ========== 清空待处理消息队列 ==========

  private async handleFlush(): Promise<Response> {
    const messages = [...this.state.pendingMessages];
    this.state.pendingMessages = [];
    await this.saveState();

    return new Response(JSON.stringify({
      success: true,
      flushedCount: messages.length,
      messages,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== 轮询循环 ==========

  private async runPollLoop(): Promise<void> {
    Logger.info("[DO] Poll loop started");

    while (this.pollLoopRunning && this.ilinkCreds) {
      try {
        const result = await getUpdates(this.ilinkCreds, this.state.syncBuf);

        // 更新 syncBuf（惰性写，避免每轮都写 KV）
        if (result.get_updates_buf && result.get_updates_buf !== this.state.syncBuf) {
          this.state.syncBuf = result.get_updates_buf;
          await this.saveCredentials(false);
        }

        // 重置错误计数
        this.state.consecutiveErrors = 0;
        this.state.lastPollAt = new Date().toISOString();

        // 处理消息
        if (result.msgs && result.msgs.length > 0) {
          Logger.info("[DO] Received messages", { count: result.msgs.length });
          await this.processMessages(result.msgs);
        } else {
          // 没消息也要更新内存中的 polls 计数，但不立刻写 KV
          this.cache.stats.polls++;
          this.cache.stats.lastPollAt = this.state.lastPollAt;
          this.cache.statsDirty = true;
        }

        // saveState 写 DO storage（不是 KV），轻量，保留
        await this.saveState();

        // 长轮询正常间隔（降低 KV 使用率：30 秒一次而非 1 秒）
        // getUpdates 自身会阻塞到有消息或超时，这里再加 30 秒避免过于频繁
        await new Promise((resolve) => setTimeout(resolve, 30000));

      } catch (e: any) {
        Logger.error("[DO] Poll error", { error: e.message });
        this.state.consecutiveErrors++;
        await this.saveState();

        // 连续错误太多，暂停轮询
        if (this.state.consecutiveErrors > 10) {
          Logger.error("[DO] Too many consecutive errors, stopping poll loop");
          this.pollLoopRunning = false;
          // 等待 5 分钟后重试（减少失败时的重试开销）
          await new Promise((resolve) => setTimeout(resolve, 300000));
          this.pollLoopRunning = true;
        } else {
          // 等待 30 秒后重试
          await new Promise((resolve) => setTimeout(resolve, 30000));
        }
      }
    }

    Logger.info("[DO] Poll loop stopped");
  }

  // ========== 处理消息 ==========

  private async getConfigCached(): Promise<{ aiSystemPrompt: string; aiModel: string }> {
    const now = Date.now();
    if (this.cache.config && now - this.cache.configLoadedAt < 10 * 60 * 1000) {
      return this.cache.config;
    }
    const configRaw = await this.kv?.get("clawbot:config");
    let kvConfig: any = {};
    try { if (configRaw) kvConfig = JSON.parse(configRaw); } catch {}
    const cfg = {
      aiSystemPrompt: this.env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "",
      aiModel: this.env.AI_MODEL || kvConfig.aiModel || "",
    };
    this.cache.config = cfg;
    this.cache.configLoadedAt = now;
    return cfg;
  }

  private async processMessages(msgs: WeixinMessage[]): Promise<void> {
    const cfg = await this.getConfigCached();
    const { aiSystemPrompt: systemPrompt, aiModel } = cfg;
    let processedCount = 0;
    let aiSuccessCount = 0;
    let aiFailCount = 0;

    for (const msg of msgs) {
      // 只处理用户消息
      if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) continue;
      if (msg.message_type === undefined && !msg.from_user_id) continue;

      const text = extractMessageText(msg);
      if (!text) continue;

      const from = msg.from_user_id;
      const ctxToken = msg.context_token;
      if (!from || !ctxToken) continue;

      const messageId = this.generateMessageId(msg);

      // 内存 Set 去重，不读 KV（省下 N 次 KV 读）
      if (this.cache.processedIds.has(messageId)) continue;

      const createdAt = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : new Date().toISOString();

      let replyContent = "";
      let replyAt = "";

      try {
        // 调用 AI 生成回复（callAIWithContext 内部会读/写 context 到 KV —— 我们无法直接改）
        const reply = await callAIWithContext(
          this.kv!,
          this.env.AI,
          from,
          text,
          systemPrompt,
          aiModel
        );

        // 发送回复
        await sendTextMessage(this.ilinkCreds!, from, ctxToken, reply);
        replyContent = reply;
        replyAt = new Date().toISOString();
        aiSuccessCount++;

        Logger.info("[DO] Message processed", { from, replyLength: reply.length });
      } catch (e: any) {
        aiFailCount++;
        Logger.error("[DO] AI processing failed", { error: e.message, from });
      }

      this.cache.processedIds.add(messageId);
      // 防止内存 Set 无限增长（超过 1000 条就剪到最新 500）
      if (this.cache.processedIds.size > 1000) {
        const arr = Array.from(this.cache.processedIds).slice(-500);
        this.cache.processedIds = new Set(arr);
      }

      processedCount++;

      // 存储到 D1
      if (this.d1) {
        try {
          await this.d1.insertMessage({
            message_id: messageId,
            from_user_id: from,
            to_user_id: msg.to_user_id,
            content: text,
            message_type: msg.message_type,
            context_token: ctxToken,
            created_at: createdAt,
            processed: true,
            reply_content: replyContent,
            reply_at: replyAt,
          });
          await this.d1.upsertSession(from);
        } catch (e: any) {
          Logger.error("[DO] D1 insert failed", { error: e.message });
        }
      }

      // 添加到待处理队列（供长轮询消费者消费）
      this.state.pendingMessages.push({
        messageId,
        fromUserId: from,
        content: text,
        timestamp: createdAt,
        replyContent,
        replyAt,
        processed: true,
      });
    }

    // 批量更新一次统计（不是每条消息都写）
    if (msgs.length > 0 || processedCount > 0) {
      await this.updateStats(msgs.length, processedCount, aiSuccessCount, aiFailCount);
    }
  }

  // ========== 凭证管理 ==========

  private async initCredentials(): Promise<void> {
    const now = Date.now();

    // 1) credentials：5 分钟内复用内存值，避免每轮都读 KV
    if (this.cache.credentials && now - this.cache.credentialsLoadedAt < 5 * 60 * 1000) {
      if (!this.ilinkCreds) {
        this.ilinkCreds = {
          botToken: this.cache.credentials.botToken,
          accountId: this.cache.credentials.accountId,
          baseUrl: this.cache.credentials.baseUrl,
          userId: this.cache.credentials.userId,
        };
        this.state.syncBuf = this.cache.credentials.syncBuf || "";
      }
    } else {
      const credsRaw = await this.kv?.get("clawbot:credentials");
      if (!credsRaw) {
        this.ilinkCreds = null;
        this.cache.credentials = null;
        this.cache.credentialsLoadedAt = now;
      } else {
        try {
          const creds = JSON.parse(credsRaw);
          this.cache.credentials = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId,
            syncBuf: creds.syncBuf || "",
          };
          this.cache.credentialsLoadedAt = now;
          this.ilinkCreds = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId,
          };
          this.state.syncBuf = creds.syncBuf || "";
        } catch (e) {
          Logger.error("[DO] Invalid credentials", { error: (e as Error).message });
          this.ilinkCreds = null;
          this.cache.credentials = null;
          this.cache.credentialsLoadedAt = now;
        }
      }
    }

    // 初始化 D1
    if (this.env.CLAWBOT_DB && !this.d1) {
      try {
        this.d1 = new D1Service(this.env.CLAWBOT_DB);
        await this.d1.init();
      } catch (e: any) {
        Logger.warn("[DO] D1 init failed", { error: e.message });
        this.d1 = null;
      }
    }
  }

  // 只在 syncBuf 真正变化 + 距离上次写满 30 秒时才写 KV
  private async saveCredentials(force: boolean = false): Promise<void> {
    if (!this.ilinkCreds || !this.cache.credentials) return;

    const now = Date.now();
    const syncBufChanged = this.state.syncBuf !== this.cache.credentials.syncBuf;
    if (!syncBufChanged && !force) return;
    if (!force && now - this.cache.lastCredWriteAt < 30 * 1000) return;

    const credsRaw = await this.kv?.get("clawbot:credentials");
    if (!credsRaw) return;

    try {
      const creds = JSON.parse(credsRaw);
      creds.syncBuf = this.state.syncBuf;
      await this.kv?.put("clawbot:credentials", JSON.stringify(creds));
      this.cache.credentials.syncBuf = this.state.syncBuf;
      this.cache.lastCredWriteAt = now;
    } catch (e) {
      Logger.error("[DO] Failed to save credentials", { error: (e as Error).message });
    }
  }

  private async saveState(): Promise<void> {
    try {
      await this.state.storage.put("session", {
        syncBuf: this.state.syncBuf,
        lastPollAt: this.state.lastPollAt,
        consecutiveErrors: this.state.consecutiveErrors,
        isRunning: this.pollLoopRunning,
      });
    } catch (e) {
      Logger.error("[DO] Failed to save state", { error: (e as Error).message });
    }
  }

  private async updateStats(polls: number, handled: number, aiCalls: number, aiFails: number): Promise<void> {
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    // 累加内存计数（不每次读+写 KV）
    this.cache.stats.polls += polls;
    this.cache.stats.handled += handled;
    this.cache.stats.aiCalls += aiCalls;
    this.cache.stats.aiFails += aiFails;
    this.cache.stats.lastPollAt = new Date().toISOString();
    this.cache.statsDirty = true;

    // 至少 5 分钟或 polls 累积 50 次才真正写 KV
    const shouldWrite =
      now - this.cache.lastStatsWriteAt > 5 * 60 * 1000 ||
      this.cache.stats.polls % 50 === 0;

    if (shouldWrite) {
      try {
        // 懒加载：如果内存计数从没从 KV 加载过，读一次
        if (this.cache.statsLoadedAt === 0) {
          const statsRaw = await this.kv?.get("clawbot:stats");
          if (statsRaw) {
            const kvs = JSON.parse(statsRaw);
            // 合并 KV 值和内存增量，取较大值以保证单调递增
            this.cache.stats.polls = Math.max(this.cache.stats.polls, kvs.polls || 0);
            this.cache.stats.handled = Math.max(this.cache.stats.handled, kvs.handled || 0);
            this.cache.stats.aiCalls = Math.max(this.cache.stats.aiCalls, kvs.aiCalls || 0);
            this.cache.stats.aiFails = Math.max(this.cache.stats.aiFails, kvs.aiFails || 0);
          }
          this.cache.statsLoadedAt = now;
        }

        await this.kv?.put("clawbot:stats", JSON.stringify(this.cache.stats));
        this.cache.lastStatsWriteAt = now;
        this.cache.statsDirty = false;
      } catch (e) {
        Logger.error("[DO] Failed to write stats", { error: (e as Error).message });
      }
    }

    // D1 统计（轻量但也限制频率：每 5 分钟最多一次）
    if (this.d1) {
      try {
        // 用一个简单的时间标记来节流 D1 写入
        const anyD1ThrottleKey = `_d1_throttle_${today}`;
        // @ts-ignore
        const lastD1Write = this.cache[anyD1ThrottleKey] || 0;
        if (now - lastD1Write > 5 * 60 * 1000) {
          await this.d1.incrementStats(today, polls, handled, aiCalls, aiFails, 0);
          // @ts-ignore
          this.cache[anyD1ThrottleKey] = now;
        }
      } catch (e) {
        // 忽略 D1 错误
      }
    }
  }

  private generateMessageId(msg: WeixinMessage): string {
    const parts = [
      msg.from_user_id || "",
      msg.message_id || "",
      msg.create_time_ms || "",
      msg.seq || ""
    ];
    return parts.join(":").slice(0, 64);
  }
}
