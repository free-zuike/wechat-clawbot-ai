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

export class ILinkConnectionDO implements DurableObject {
  private state: ILINKSessionState;
  private env: any;
  private ilinkCreds: ILinkCredentials | null = null;
  private d1: D1Service | null = null;
  private pollLoopRunning = false;
  private kv: KVNamespace | null = null;

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

        // 更新 syncBuf
        if (result.get_updates_buf && result.get_updates_buf !== this.state.syncBuf) {
          this.state.syncBuf = result.get_updates_buf;
          await this.saveCredentials();
        }

        // 重置错误计数
        this.state.consecutiveErrors = 0;
        this.state.lastPollAt = new Date().toISOString();

        // 处理消息
        if (result.msgs && result.msgs.length > 0) {
          Logger.info("[DO] Received messages", { count: result.msgs.length });
          await this.processMessages(result.msgs);
        }

        // 保存状态
        await this.saveState();

        // 正常间隔后继续（长轮询会自动等待消息）
        await new Promise((resolve) => setTimeout(resolve, 1000));

      } catch (e: any) {
        Logger.error("[DO] Poll error", { error: e.message });
        this.state.consecutiveErrors++;
        await this.saveState();

        // 连续错误太多，暂停轮询
        if (this.state.consecutiveErrors > 10) {
          Logger.error("[DO] Too many consecutive errors, stopping poll loop");
          this.pollLoopRunning = false;
          // 等待 30 秒后重试
          await new Promise((resolve) => setTimeout(resolve, 30000));
          this.pollLoopRunning = true;
        } else {
          // 等待 5 秒后重试
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }

    Logger.info("[DO] Poll loop stopped");
  }

  // ========== 处理消息 ==========

  private async processMessages(msgs: WeixinMessage[]): Promise<void> {
    const configRaw = await this.kv?.get("clawbot:config");
    let kvConfig: any = {};
    try { if (configRaw) kvConfig = JSON.parse(configRaw); } catch {}
    const systemPrompt = this.env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt || "";
    const aiModel = this.env.AI_MODEL || kvConfig.aiModel || "";

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
      const createdAt = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : new Date().toISOString();

      let replyContent = "";
      let replyAt = "";

      try {
        // 调用 AI 生成回复
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

        Logger.info("[DO] Message processed", { from, replyLength: reply.length });
      } catch (e: any) {
        Logger.error("[DO] AI processing failed", { error: e.message, from });
      }

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

      // 更新统计
      await this.updateStats(msgs.length, 1, replyContent ? 1 : 0, replyContent ? 0 : 1);
    }
  }

  // ========== 凭证管理 ==========

  private async initCredentials(): Promise<void> {
    if (this.ilinkCreds) return;

    const credsRaw = await this.kv?.get("clawbot:credentials");
    if (!credsRaw) {
      this.ilinkCreds = null;
      return;
    }

    try {
      const creds = JSON.parse(credsRaw);
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
    }

    // 初始化 D1
    if (this.env.CLAWBOT_DB) {
      try {
        this.d1 = new D1Service(this.env.CLAWBOT_DB);
        await this.d1.init();
      } catch (e: any) {
        Logger.warn("[DO] D1 init failed", { error: e.message });
        this.d1 = null;
      }
    }
  }

  private async saveCredentials(): Promise<void> {
    if (!this.ilinkCreds) return;

    const credsRaw = await this.kv?.get("clawbot:credentials");
    if (!credsRaw) return;

    try {
      const creds = JSON.parse(credsRaw);
      creds.syncBuf = this.state.syncBuf;
      await this.kv?.put("clawbot:credentials", JSON.stringify(creds));
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
    const today = new Date().toISOString().split("T")[0];

    // 更新 KV 统计
    const statsRaw = await this.kv?.get("clawbot:stats");
    const stats = statsRaw ? JSON.parse(statsRaw) : { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "", lastLatencyMs: 0 };
    stats.polls += polls;
    stats.handled += handled;
    stats.aiCalls += aiCalls;
    stats.aiFails += aiFails;
    stats.lastPollAt = new Date().toISOString();
    await this.kv?.put("clawbot:stats", JSON.stringify(stats));

    // 更新 D1 统计
    if (this.d1) {
      try {
        await this.d1.incrementStats(today, polls, handled, aiCalls, aiFails, 0);
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
