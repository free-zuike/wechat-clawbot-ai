// iLink Durable Object - 管理微信机器人的长轮询连接
// 架构：DO 替代 Cron 轮询，实现消息实时接收
// 优化：credentials 和 context 从 KV 迁移到 DO SQLite，彻底消除 KV 读写

import { Logger } from "../utils/error";
import { generateSessionToken } from "../utils";
import { getUpdates, sendTextMessage, extractMessageText, getQRCodeStatus, MessageType } from "./ilink";
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

// 内存缓存（避免每轮都读 SQLite）
interface RuntimeCache {
  credentials: { botToken: string; accountId: string; baseUrl: string; userId: string; syncBuf: string } | null;
  credentialsLoadedAt: number;
  config: { aiSystemPrompt: string; aiModel: string } | null;
  configLoadedAt: number;
  // 注意：不再用内存 Set 去重，改为依赖 syncBuf 服务端去重
  // 每次轮询用 syncBuf 告诉服务器"我只接收这个位置之后的消息"
}

export class ILinkConnectionDO implements DurableObject {
  private state: ILINKSessionState;
  private env: any;
  private ilinkCreds: ILinkCredentials | null = null;
  private d1: D1Service | null = null;
  private pollLoopRunning = false;
  private kv: KVNamespace | null = null;
  private websockets: Set<WebSocket> = new Set();
  private runtimeStats = { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastLatencyMs: 0 };
  private statsHistory: Array<{ ts: string; polls: number; handled: number; aiCalls: number; aiFails: number }> = [];
  private cache: RuntimeCache = {
    credentials: null,
    credentialsLoadedAt: 0,
    config: null,
    configLoadedAt: 0,
  };
  private sqliteInitialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.kv = env.CLAWBOT_KV;

    // 从 DO storage 恢复状态
    const stored = state.storage.get<ILINKSessionState>("session").catch(() => null);
    this.state = {
      syncBuf: "",
      lastPollAt: "",
      consecutiveErrors: 0,
      isRunning: false,
      pendingMessages: [],
      ...this.state,
    };

    // 恢复统计历史和累计统计
    state.storage.get<Array<{ ts: string; polls: number; handled: number; aiCalls: number; aiFails: number }>>("stats_history")
      .then((h) => { if (h) this.statsHistory = h; })
      .catch(() => {});
    state.storage.get<typeof this.runtimeStats>("runtime_stats")
      .then((s) => { if (s) this.runtimeStats = { ...this.runtimeStats, ...s }; })
      .catch(() => {});
  }

  // ========== SQLite 初始化 ==========

  private async initSQLite(): Promise<void> {
    if (this.sqliteInitialized) return;

    const sql = this.state.storage.sql;

    // credentials 表：存储微信登录凭证
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bot_token TEXT NOT NULL,
        account_id TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT 'https://ilinkai.weixin.qq.com',
        user_id TEXT NOT NULL,
        sync_buf TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // contexts 表：存储用户对话上下文（替代 KV clawbot:context:${userId}）
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        user_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL DEFAULT '[]',
        last_updated INTEGER NOT NULL
      )
    `);

    // processed_messages 表：本地持久化去重，避免 syncBuf 回退时重复回复历史消息
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `);

    this.sqliteInitialized = true;
    Logger.info("[DO] SQLite tables initialized");
  }

  // ========== D1 初始化（独立方法，确保每次 fetch 都能建表）==========

  private async initD1(): Promise<void> {
    if (!this.env.CLAWBOT_DB) {
      Logger.warn("[DO] CLAWBOT_DB binding not found, D1 disabled");
      return;
    }
    if (this.d1) return; // 已初始化

    try {
      this.d1 = new D1Service(this.env.CLAWBOT_DB);
      await this.d1.init(); // 执行 CREATE TABLE IF NOT EXISTS
      Logger.info("[DO] D1 initialized successfully");
    } catch (e: any) {
      Logger.warn("[DO] D1 init failed — messages will NOT be persisted", { error: e.message });
      this.d1 = null;
    }
  }

  // ========== HTTP 处理（长轮询入口）==========

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 优先初始化 D1（确保 messages/sessions/stats 表在第一条请求时就创建）
    await this.initD1();

    // 初始化 DO SQLite（credentials / contexts / do_config 建表）
    await this.initSQLite();

    // 初始化凭证（从 SQLite → KV fallback 迁移）
    await this.initCredentials();

    // 有凭证就尝试启动轮询（DO eviction 后自动恢复，不依赖特定路径触发）
    if (this.ilinkCreds && !this.pollLoopRunning) {
      this.pollLoopRunning = true;
      this.runPollLoop().catch((e) => {
        Logger.error("[DO] Poll loop error", { error: e.message });
        this.pollLoopRunning = false;
      });
    }

    // WebSocket 升级
    if (url.pathname === "/ws" || url.pathname === "/api/ws") {
      return this.handleWebSocket(request);
    }

    // /status、/qr-poll、/check-session、/save-creds、/get-creds：不检查凭证
    if (url.pathname === "/status") {
      return this.handleStatus();
    }
    if (url.pathname === "/qr-poll") {
      return this.handleQRPoll(url);
    }
    if (url.pathname === "/check-session") {
      return this.handleCheckSession(url);
    }
    if (url.pathname === "/save-session") {
      return this.handleSaveSession(request);
    }
    if (url.pathname === "/save-creds") {
      return this.handleSaveCreds(request);
    }
    if (url.pathname === "/get-creds") {
      return this.handleGetCreds();
    }
    if (url.pathname === "/clear-creds") {
      return this.handleClearCreds();
    }

    // 其它路径：必须已登录
    if (!this.ilinkCreds) {
      return new Response(
        JSON.stringify({ error: "未登录或凭证无效，请重新扫码登录", needsReLogin: true }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 路由分发
    switch (url.pathname) {
      case "/poll":
        return this.handleLongPoll();
      case "/send":
        return this.handleSend(request);
      case "/status":
        return this.handleStatus();
      case "/stats-history":
        return this.handleStatsHistory();
      case "/flush":
        return this.handleFlush();
      case "/qr-poll":
        return this.handleQRPoll(url);
      case "/save-creds":
        return this.handleSaveCreds(request);
      default:
        return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
    }
  }

  // ========== 拉取消息（立即返回，不长轮询）==========

  private async handleLongPoll(): Promise<Response> {
    Logger.info("[DO] Poll triggered");

    // 确保轮询循环在运行
    if (!this.ilinkCreds) {
      return new Response(JSON.stringify({
        success: true,
        pulled: 0,
        handled: 0,
        skipped: 0,
        error: "未登录",
        latencyMs: 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (!this.pollLoopRunning) {
      this.pollLoopRunning = true;
      this.runPollLoop().catch((e) => {
        Logger.error("[DO] Poll loop error", { error: e.message });
        this.pollLoopRunning = false;
      });
    }

    // 等最多5秒让当前轮询完成，立即返回
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (this.state.pendingMessages.length > 0) {
        const msg = this.state.pendingMessages.shift()!;
        return new Response(JSON.stringify({
          success: true,
          pulled: 1,
          handled: 1,
          skipped: 0,
          message: msg,
          latencyMs: Date.now() - deadline + 5000,
        }), { headers: { "Content-Type": "application/json" } });
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return new Response(JSON.stringify({
      success: true,
      pulled: 0,
      handled: 0,
      skipped: 0,
      latencyMs: 5000,
    }), { headers: { "Content-Type": "application/json" } });
  }

  // ========== WebSocket 实时推送 ==========

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.websockets.add(server);
    Logger.info("[DO] WebSocket connected", { total: this.websockets.size });

    server.accept();
    server.addEventListener("close", () => {
      this.websockets.delete(server);
      Logger.info("[DO] WebSocket disconnected", { total: this.websockets.size });
    });
    server.addEventListener("error", () => {
      this.websockets.delete(server);
    });

    // 发送欢迎消息
    server.send(JSON.stringify({ type: "connected", message: "实时消息连接已建立" }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcastToWebSockets(data: Record<string, unknown>): void {
    const msg = JSON.stringify(data);
    for (const ws of this.websockets) {
      try {
        ws.send(msg);
      } catch {
        this.websockets.delete(ws);
      }
    }
  }

  // ========== 保存 session（admin登录时调用）==========

  private async handleSaveSession(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { token, ttl } = body;
      if (!token) {
        return new Response(JSON.stringify({ error: "缺少 token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      await this.state.storage.put(`session:${token}`, JSON.stringify({ valid: true, createdAt: Date.now() }));
      Logger.info("[DO] Session saved", { token: token.slice(0, 8) + "..." });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      Logger.error("[DO] /save-session error", { error: e.message });
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ========== 检查 session 是否有效（DO SQLite）==========

  private async handleCheckSession(url: URL): Promise<Response> {
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response(JSON.stringify({ valid: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      await this.initSQLite();
      const row = this.state.storage.sql.exec(
        `SELECT token FROM sessions WHERE token = ?`,
        token
      ).one();
      return new Response(JSON.stringify({ valid: !!row }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ valid: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ========== 清除凭证（解绑微信）==========

  // ========== 获取凭证详情（诊断用）==========

  private async handleGetCreds(): Promise<Response> {
    // 从 DO storage 读取凭证
    let credsRaw: string | null = null;
    try {
      credsRaw = await this.state.storage.get<string>("credentials");
    } catch (_e) {}

    // 如果内存中有凭证，优先用内存的
    if (!credsRaw && this.ilinkCreds) {
      credsRaw = JSON.stringify(this.ilinkCreds);
    }

    if (!credsRaw) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ creds: credsRaw }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== 清除凭证（解绑微信）==========

  private async handleClearCreds(): Promise<Response> {
    try {
      await this.state.storage.delete("credentials");
      this.ilinkCreds = null;
      this.cache.credentials = null;
      this.pollLoopRunning = false;

      Logger.info("[DO] Credentials cleared (WeChat unbound)");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      Logger.error("[DO] /clear-creds error", { error: e.message });
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ========== 保存凭证（登录确认时调用，绕过KV）==========

  private async handleSaveCreds(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      const { botToken, accountId, userId, baseUrl, syncBuf, createdAt } = body;
      if (!botToken || !accountId) {
        return new Response(JSON.stringify({ error: "缺少凭证" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 直接存到 DO KV storage（最可靠，不依赖外部 KV 配额）
      await this.state.storage.put("credentials", JSON.stringify({
        botToken, accountId, userId: userId || "",
        baseUrl: baseUrl || "https://ilinkai.weixin.qq.com",
        syncBuf: syncBuf || "", createdAt: createdAt || Date.now(),
      }));

      // 同时更新内存状态，让 handleStatus 能检测到
      this.ilinkCreds = { botToken, accountId, baseUrl: baseUrl || "https://ilinkai.weixin.qq.com", userId: userId || "" };

      // 同时存 session token
      const sessionToken = generateSessionToken();

      // 同步到内存
      this.ilinkCreds = { botToken, accountId, baseUrl: baseUrl || "https://ilinkai.weixin.qq.com", userId: userId || "" };
      this.cache.credentials = { ...body };

      Logger.info("[DO] Credentials saved via /save-creds", { accountId });
      return new Response(JSON.stringify({ ok: true, sessionToken }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      Logger.error("[DO] /save-creds error", { error: e.message });
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ========== QR码状态轮询 ==========

  private async handleQRPoll(url: URL): Promise<Response> {
    const qrcodeKey = url.searchParams.get("qrcode");
    if (!qrcodeKey) {
      return new Response(JSON.stringify({ error: "缺少 qrcode 参数" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    Logger.info("[DO] QR poll started", { qrcode: qrcodeKey.slice(0, 8) + "..." });

    // 轮询 iLink API（最多30次，每次间隔3秒 = 90秒）
    for (let i = 0; i < 30; i++) {
      try {
        const status = await getQRCodeStatus(qrcodeKey);
        Logger.info("[DO] QR poll check", { status: status.status, attempt: i + 1 });

        if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
          const creds = {
            botToken: status.bot_token,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com",
            syncBuf: "",
            rawLoginResponse: status.raw,
            createdAt: Date.now(),
          };
          // KV写入失败不阻塞
          try { await this.kv!.put("credentials", JSON.stringify(creds)); } catch {}
          try {
            const sessionToken = generateSessionToken();
            await this.kv!.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
          } catch {}

          Logger.info("[DO] QR login confirmed", { accountId: status.ilink_bot_id });
          return new Response(JSON.stringify({ status: "confirmed", ok: true }), {
            headers: { "Content-Type": "application/json" },
            "Set-Cookie": `clawbot_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`,
          });
        }

        if (status.status === "expired") {
          return new Response(JSON.stringify({ status: "expired" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // 等待3秒再轮询
        await new Promise((r) => setTimeout(r, 3000));
      } catch (e: any) {
        Logger.error("[DO] QR poll error", { error: e.message });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    return new Response(JSON.stringify({ status: "timeout" }), {
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
      lastPollAt: this.state.lastPollAt,
      consecutiveErrors: this.state.consecutiveErrors,
      pendingMessages: this.state.pendingMessages.length,
      hasCredentials: !!this.ilinkCreds,
      accountId: this.ilinkCreds?.accountId,
      needsReLogin: !this.ilinkCreds,
      stats: this.runtimeStats,
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

  // ========== 统计历史 ==========

  private async handleStatsHistory(): Promise<Response> {
    return new Response(JSON.stringify({ success: true, history: this.statsHistory }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private saveStatsSnapshot(): void {
    const now = new Date();
    const ts = now.toISOString();
    this.statsHistory.push({
      ts,
      polls: this.runtimeStats.polls,
      handled: this.runtimeStats.handled,
      aiCalls: this.runtimeStats.aiCalls,
      aiFails: this.runtimeStats.aiFails,
    });
    // 保留最近 48 条（约 48 小时）
    if (this.statsHistory.length > 48) this.statsHistory = this.statsHistory.slice(-48);
    this.state.storage.put("stats_history", this.statsHistory).catch(() => {});
    this.state.storage.put("runtime_stats", this.runtimeStats).catch(() => {});
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
        const pollStart = Date.now();
        const result = await getUpdates(this.ilinkCreds, this.state.syncBuf);

        // 更新 syncBuf（写 DO SQLite，不再写 KV）
        if (result.get_updates_buf && result.get_updates_buf !== this.state.syncBuf) {
          this.state.syncBuf = result.get_updates_buf;
          await this.saveCredentials();
        }

        // 重置错误计数
        this.state.consecutiveErrors = 0;
        this.state.lastPollAt = new Date().toISOString();
        this.runtimeStats.polls++;
        this.runtimeStats.lastLatencyMs = Date.now() - pollStart;

        // 处理消息
        if (result.msgs && result.msgs.length > 0) {
          Logger.info("[DO] Received messages", { count: result.msgs.length });
          await this.processMessages(result.msgs);
        }

        // 保存统计快照
        this.saveStatsSnapshot();

        // saveState 写 DO storage，轻量，保留
        await this.saveState();

        // 长轮询正常间隔（30 秒）
        await new Promise((resolve) => setTimeout(resolve, 30000));

      } catch (e: any) {
        Logger.error("[DO] Poll error", { error: e.message });

        // ILINK_SESSION_TIMEOUT：会话连接断开，尝试重新获取 bot_token
        // 账号绑定是持久的，不需要重新扫码
        if (e.code === "ILINK_SESSION_TIMEOUT" || e.message?.includes("ILINK_SESSION_TIMEOUT")) {
          Logger.warn("[DO] Session timeout — attempting token refresh");
          this.state.consecutiveErrors++;

          // 尝试通过 get_qrcode_status 刷新 bot_token（账号已绑定）
          try {
            const refreshResult = await getQRCodeStatus(this.ilinkCreds!.accountId);
            if (refreshResult.status === "confirmed" && refreshResult.bot_token) {
              // 刷新成功，更新凭证
              this.ilinkCreds!.botToken = refreshResult.bot_token;
              this.state.syncBuf = "";
              Logger.info("[DO] Token refreshed successfully");
              this.state.consecutiveErrors = 0;
              await this.saveCredentials();
              await this.saveState();
              continue; // 继续轮询
            }
          } catch (refreshErr: any) {
            Logger.warn("[DO] Token refresh failed", { error: refreshErr.message });
          }

          // 刷新失败，暂停轮询等待重试（不清除凭证）
          this.pollLoopRunning = false;
          await this.saveState();
          return;
        }

        this.state.consecutiveErrors++;
        await this.saveState();

        // 连续错误太多，暂停轮询
        if (this.state.consecutiveErrors > 10) {
          Logger.error("[DO] Too many consecutive errors, stopping poll loop");
          this.pollLoopRunning = false;
          // 等待 5 分钟后重试
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

  private async getConfigCached() {
    const now = Date.now();
    if (this.cache.config && now - this.cache.configLoadedAt < 10 * 60 * 1000) {
      return this.cache.config;
    }

    let aiSystemPrompt = this.env.AI_SYSTEM_PROMPT || "";
    let aiModel = this.env.AI_MODEL || "";
    let aiProvider = "cloudflare";
    let aiBaseUrl = "";
    let aiApiKey = "";
    let aiMaxTokens = 1024;

    // 从 KV 读配置
    const configRaw = await this.kv?.get("clawbot:config");
    try {
      if (configRaw) {
        const kvConfig = JSON.parse(configRaw);
        aiSystemPrompt = aiSystemPrompt || kvConfig.aiSystemPrompt || "";
        aiModel = aiModel || kvConfig.aiModel || "";
        aiProvider = kvConfig.aiProvider || "cloudflare";
        aiBaseUrl = kvConfig.aiBaseUrl || "";
        aiApiKey = kvConfig.aiApiKey || "";
        aiMaxTokens = kvConfig.aiMaxTokens || 1024;
      }
    } catch (_e) {}

    const cfg = { aiSystemPrompt, aiModel, aiProvider, aiBaseUrl, aiApiKey, aiMaxTokens };
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

      const createdAt = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : new Date().toISOString();

      // 先生成稳定 messageId，再做多层去重
      const messageId = this.generateMessageId(msg, text);

      // 第一层：DO 本地 SQLite 去重
      if (await this.hasProcessedMessage(messageId)) {
        if (this.d1) {
          await this.persistMessageToD1(msg, messageId, text, createdAt);
        }
        Logger.info("[DO] Message already processed (local dedup)", { messageId });
        continue;
      }

      // 第二层：D1 去重，兼容历史已入库消息
      if (this.d1) {
        const existing = await this.d1.getMessageById(messageId);
        if (existing) {
          await this.markMessageProcessed(messageId);
          Logger.info("[DO] Message already processed (D1 dedup)", { messageId });
          continue;
        }
      }

      let replyContent = "";
      let replyAt = "";

      try {
        // 调用 AI 生成回复（使用 DO SQLite 存储上下文，不再走 KV）
        const reply = await callAIWithContext(
          this.state.storage.sql,
          this.env.AI,
          from,
          text,
          systemPrompt,
          aiModel,
          { provider: cfg.aiProvider, baseUrl: cfg.aiBaseUrl, apiKey: cfg.aiApiKey, maxTokens: cfg.aiMaxTokens }
        );

        // 发送回复
        await sendTextMessage(this.ilinkCreds!, from, ctxToken, reply);
        replyContent = reply;
        replyAt = new Date().toISOString();
        aiSuccessCount++;
        await this.markMessageProcessed(messageId);

        Logger.info("[DO] Message processed", { from, replyLength: reply.length });
      } catch (e: any) {
        aiFailCount++;
        Logger.error("[DO] AI processing failed", { error: e.message, from });
      }

      processedCount++;

      // 存储到 D1
      if (this.d1) {
        try {
          await this.persistMessageToD1(msg, messageId, text, createdAt, replyContent, replyAt);
        } catch (e: any) {
          Logger.error("[DO] D1 insert failed", { error: e.message });
        }
      }

      // 添加到待处理队列
      const pendingMsg = {
        messageId,
        fromUserId: from,
        content: text,
        timestamp: createdAt,
        replyContent,
        replyAt,
        processed: true,
      };
      this.state.pendingMessages.push(pendingMsg);

      // 广播到 WebSocket 客户端
      if (this.websockets.size > 0) {
        this.broadcastToWebSockets({ type: "message", data: pendingMsg });
      }
    }

    // 更新运行时统计
    this.runtimeStats.handled += processedCount;
    this.runtimeStats.aiCalls += aiSuccessCount;
    this.runtimeStats.aiFails += aiFailCount;

    // 批量更新一次统计
    if (msgs.length > 0 || processedCount > 0) {
      await this.updateStats(msgs.length, processedCount, aiSuccessCount, aiFailCount);
    }
  }

  private async persistMessageToD1(
    msg: WeixinMessage,
    messageId: string,
    text: string,
    createdAt: string,
    replyContent: string = "",
    replyAt: string = "",
  ): Promise<void> {
    if (!this.d1 || !msg.from_user_id) return;

    const existingMessage = await this.d1.getMessageById(messageId);
    if (existingMessage) {
      const existingSession = await this.d1.getSession(msg.from_user_id);
      if (!existingSession) {
        await this.d1.upsertSession(msg.from_user_id, existingMessage.created_at || createdAt);
      }
      return;
    }

    await this.d1.insertMessage({
      message_id: messageId,
      from_user_id: msg.from_user_id,
      to_user_id: msg.to_user_id,
      content: text,
      message_type: msg.message_type,
      context_token: msg.context_token,
      created_at: createdAt,
      processed: true,
      reply_content: replyContent,
      reply_at: replyAt,
    });
    await this.d1.upsertSession(msg.from_user_id, createdAt);
  }

  // ========== 凭证管理（DO SQLite 版）==========

  private async initCredentials(): Promise<void> {
    const now = Date.now();

    // 1) 内存缓存：5 分钟内复用
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
      return;
    }

    // 2) 从 KV 读取凭证
    try {
      const credsRaw = await this.kv?.get("credentials");
      if (credsRaw) {
        const creds = JSON.parse(credsRaw);
        if (creds.botToken && creds.accountId) {
          this.cache.credentials = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId || "",
            syncBuf: creds.syncBuf || "",
          };
          this.cache.credentialsLoadedAt = now;
          this.ilinkCreds = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId || "",
          };
          this.state.syncBuf = creds.syncBuf || "";
          return;
        }
      }
    } catch (e) {
      Logger.warn("[DO] Failed to read credentials from KV", { error: (e as Error).message });
    }

    // 3) 从 DO storage 读取凭证（主存储）
    try {
      const credsRaw = await this.state.storage.get<string>("credentials");
      if (credsRaw) {
        const creds = JSON.parse(credsRaw);
        if (creds.botToken && creds.accountId) {
          this.cache.credentials = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId || "",
            syncBuf: creds.syncBuf || "",
          };
          this.cache.credentialsLoadedAt = now;
          this.ilinkCreds = {
            botToken: creds.botToken,
            accountId: creds.accountId,
            baseUrl: creds.baseUrl || "https://ilinkai.weixin.qq.com",
            userId: creds.userId || "",
          };
          this.state.syncBuf = creds.syncBuf || "";
          return;
        }
      }
    } catch (e) {
      Logger.warn("[DO] Failed to read credentials from DO storage", { error: (e as Error).message });
    }

    // 无凭证可用 — 但如果内存中已有凭证，保留不变（避免缓存过期后误清除）
    if (!this.ilinkCreds) {
      this.cache.credentials = null;
      this.cache.credentialsLoadedAt = now;
    }
  }

  // 保存 credentials 到 DO SQLite（替代 KV 写）
  private async saveCredentials(): Promise<void> {
    if (!this.ilinkCreds) return;

    const now = Date.now();
    const syncBufChanged = !this.cache.credentials || this.state.syncBuf !== this.cache.credentials.syncBuf;
    if (!syncBufChanged) return;

    try {
      this.state.storage.sql.exec(
        `INSERT INTO credentials (id, bot_token, account_id, base_url, user_id, sync_buf, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           sync_buf = excluded.sync_buf,
           updated_at = excluded.updated_at`,
        this.ilinkCreds.botToken,
        this.ilinkCreds.accountId,
        this.ilinkCreds.baseUrl,
        this.ilinkCreds.userId,
        this.state.syncBuf,
        now,
        now,
      );

      if (this.cache.credentials) {
        this.cache.credentials.syncBuf = this.state.syncBuf;
      }
      Logger.debug("[DO] Credentials saved to SQLite");
    } catch (e) {
      Logger.error("[DO] Failed to save credentials to SQLite", { error: (e as Error).message });
    }
  }

  // 从 KV 同步到 SQLite（一次性迁移）
  private async saveCredentialsToSQLite(): Promise<void> {
    if (!this.ilinkCreds || !this.cache.credentials) return;

    const now = Date.now();
    try {
      this.state.storage.sql.exec(
        `INSERT INTO credentials (id, bot_token, account_id, base_url, user_id, sync_buf, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           bot_token = excluded.bot_token,
           account_id = excluded.account_id,
           base_url = excluded.base_url,
           user_id = excluded.user_id,
           sync_buf = excluded.sync_buf,
           updated_at = excluded.updated_at`,
        this.ilinkCreds.botToken,
        this.ilinkCreds.accountId,
        this.ilinkCreds.baseUrl,
        this.ilinkCreds.userId,
        this.state.syncBuf,
        now,
        now,
      );
      Logger.info("[DO] Credentials migrated from KV to SQLite");
    } catch (e) {
      Logger.error("[DO] Failed to migrate credentials to SQLite", { error: (e as Error).message });
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

    // 只更新 D1，不再写 KV stats
    if (this.d1) {
      try {
        await this.d1.incrementStats(today, polls, handled, aiCalls, aiFails, 0);
      } catch (e) {
        Logger.error("[DO] Failed to write D1 stats", { error: (e as Error).message });
      }
    }
  }

  private async hasProcessedMessage(messageId: string): Promise<boolean> {
    try {
      const row = this.state.storage.sql.exec(
        `SELECT 1 as found FROM processed_messages WHERE message_id = ? LIMIT 1`,
        messageId
      ).one();
      return !!row;
    } catch (e) {
      Logger.warn("[DO] Failed to query processed_messages", { error: (e as Error).message, messageId });
      return false;
    }
  }

  private async markMessageProcessed(messageId: string): Promise<void> {
    try {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO processed_messages (message_id, created_at) VALUES (?, ?)`,
        messageId, Date.now()
      );
    } catch (e) {
      Logger.warn("[DO] Failed to mark message processed", { error: (e as Error).message, messageId });
    }
  }

  private hashText(input: string): string {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  private generateMessageId(msg: WeixinMessage, text: string = ""): string {
    const parts = [
      msg.from_user_id || "",
      msg.context_token || "",
      msg.message_id ?? "",
      msg.create_time_ms ?? "",
      msg.seq ?? ""
    ];
    const primary = parts.filter(Boolean).join(":");

    if (primary) {
      return primary.slice(0, 128);
    }

    // 兜底：某些历史消息字段不完整时，使用发送者 + 上下文 + 文本哈希生成稳定 ID
    return [
      msg.from_user_id || "unknown",
      msg.context_token || "",
      this.hashText(text || JSON.stringify(msg.item_list || [])),
    ].join(":").slice(0, 128);
  }
}
