// iLink Durable Object - 管理微信机器人的长轮询连接
// 架构：DO 替代 Cron 轮询，实现消息实时接收
// 优化：credentials 和 context 从 KV 迁移到 DO SQLite，彻底消除 KV 读写

import { Logger } from "../utils/error";
import { generateSessionToken } from "../utils";
import { getUpdates, sendTextMessage, sendTextChunked, sendTypingStatus, extractMessageText, getQRCodeStatus, uploadAndSendMedia, MessageType, MessageItemType } from "./ilink";
import { callAIWithContext, isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt, generateImage, generateVideo } from "./ai";
import { sendWebhook } from "./webhook";
import { clearContextSQLite } from "./context";
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
  config: { aiSystemPrompt: string; aiModel: string; aiProvider: string; aiBaseUrl: string; aiApiKey: string; aiMaxTokens: number; aiImageModel: string; aiVideoModel: string; webhook: { enabled: boolean; url: string; title: string; apiKey: string; channels: string[] } } | null;
  configLoadedAt: number;
}

export class ILinkConnectionDO implements DurableObject {
  private doState: DurableObjectState;
  private state: ILINKSessionState;
  private env: any;
  private ilinkCreds: ILinkCredentials | null = null; // 当前活跃账号（兼容）
  private accounts: Map<string, {
    creds: ILinkCredentials;
    syncBuf: string;
    consecutiveErrors: number;
    lastPollAt: string;
    pollLoopRunning: boolean;
  }> = new Map();
  private kv: KVNamespace | null = null;
  private websockets: Set<WebSocket> = new Set();
  private runtimeStats = { polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastLatencyMs: 0 };
  private cache: RuntimeCache = {
    credentials: null,
    credentialsLoadedAt: 0,
    config: null,
    configLoadedAt: 0,
  };
  private sqliteInitialized = false;

  constructor(state: DurableObjectState, env: any) {
    this.doState = state;
    this.env = env;
    this.kv = env.CLAWBOT_KV;

    // 初始化 session state
    this.state = {
      syncBuf: "",
      lastPollAt: "",
      consecutiveErrors: 0,
      isRunning: false,
      pendingMessages: [],
    };

    // 从 DO storage 恢复状态（异步）
    state.storage.get<ILINKSessionState>("session").then((stored) => {
      if (stored) {
        this.state.syncBuf = stored.syncBuf || "";
        this.state.lastPollAt = stored.lastPollAt || "";
        this.state.consecutiveErrors = stored.consecutiveErrors || 0;
        this.state.isRunning = stored.isRunning || false;
        this.state.pendingMessages = stored.pendingMessages || [];
      }
    }).catch(() => {});

    // 恢复运行时统计
    state.storage.get<typeof this.runtimeStats>("runtime_stats")
      .then((s) => { if (s) this.runtimeStats = { ...this.runtimeStats, ...s }; })
      .catch(() => {});

    // 异步加载多账号数据
    state.storage.get<Array<{ accountId: string; creds: ILinkCredentials; syncBuf: string }>>("accounts")
      .then((accs) => {
        if (accs && accs.length > 0) {
          for (const a of accs) {
            if (!this.accounts.has(a.accountId)) {
              this.accounts.set(a.accountId, {
                creds: a.creds,
                syncBuf: a.syncBuf || "",
                consecutiveErrors: 0,
                lastPollAt: "",
                pollLoopRunning: false,
              });
            }
          }
          if (!this.ilinkCreds && accs.length > 0) {
            this.ilinkCreds = accs[0].creds;
          }
          // 加载完成后启动轮询
          for (const [accountId, account] of this.accounts) {
            if (!account.pollLoopRunning) {
              account.pollLoopRunning = true;
              this.runAccountPollLoop(accountId).catch((e) => {
                Logger.error("[DO] Account poll loop error", { accountId, error: e.message });
                account.pollLoopRunning = false;
              });
            }
          }
        }
      })
      .catch(() => {});
  }

  // ========== SQLite 初始化 ==========

  private async initSQLite(): Promise<void> {
    if (this.sqliteInitialized) return;

    const sql = this.doState.storage.sql;

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

  // ========== HTTP 处理（长轮询入口）==========

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 初始化 DO SQLite（credentials / contexts / do_config 建表）
    await this.initSQLite();

    // 初始化凭证（从 SQLite → KV fallback 迁移）
    await this.initCredentials();

    // 有凭证就尝试启动轮询（DO eviction 后自动恢复）
    if (this.accounts.size > 0) {
      for (const [accountId, account] of this.accounts) {
        if (!account.pollLoopRunning) {
          account.pollLoopRunning = true;
          this.runAccountPollLoop(accountId).catch((e) => {
            Logger.error("[DO] Poll loop error", { accountId, error: e.message });
            account.pollLoopRunning = false;
          });
        }
      }
    }

    // WebSocket 升级
    if (url.pathname === "/ws" || url.pathname === "/api/ws") {
      return this.handleWebSocket(request);
    }

    // /status、/sqlite/contexts 等路径不检查凭证
    if (url.pathname === "/status") {
      return this.handleStatus();
    }
    if (url.pathname === "/sqlite/contexts") {
      return this.handleSQLiteContexts();
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
      case "/sqlite/contexts":
        return this.handleSQLiteContexts();
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

    const anyRunning = Array.from(this.accounts.values()).some(a => a.pollLoopRunning);
    if (!anyRunning) {
      this.triggerImmediatePoll();
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
      const body = await request.json() as { token?: string; ttl?: number };
      const { token } = body;
      if (!token) {
        return new Response(JSON.stringify({ error: "缺少 token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      await this.doState.storage.put(`session:${token}`, JSON.stringify({ valid: true, createdAt: Date.now() }));
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
      const sessionData = await this.doState.storage.get<string>(`session:${token}`);
      const valid = !!sessionData;
      return new Response(JSON.stringify({ valid }), {
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
      credsRaw = await this.doState.storage.get<string>("credentials");
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

  // ========== 持久化所有账号 ==========
  private async saveAccounts(): Promise<void> {
    const arr = Array.from(this.accounts.entries()).map(([accountId, a]) => ({
      accountId,
      creds: a.creds,
      syncBuf: a.syncBuf,
    }));
    await this.doState.storage.put("accounts", arr);
  }

  // ========== 清除凭证（解绑微信）==========

  private async handleClearCreds(request?: Request): Promise<Response> {
    try {
      let targetAccountId: string | null = null;

      // 支持指定 accountId 解绑
      if (request) {
        try {
          const body = await request.json() as { accountId?: string };
          targetAccountId = body.accountId || null;
        } catch {}
      }

      if (targetAccountId) {
        // 解绑指定账号
        this.accounts.delete(targetAccountId);
        Logger.info("[DO] Account unbound", { accountId: targetAccountId, remaining: this.accounts.size });
      } else {
        // 兼容：解绑全部
        this.accounts.clear();
        this.ilinkCreds = null;
        Logger.info("[DO] All accounts unbound");
      }

      // 更新 ilinkCreds 为第一个剩余账号
      const first = this.accounts.values().next().value;
      this.ilinkCreds = first ? first.creds : null;

      await this.saveAccounts();
    } catch (e: any) {
      Logger.error("[DO] /clear-creds error", { error: e.message });
    }
    return new Response(JSON.stringify({ ok: true, remaining: this.accounts.size }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== 保存凭证（登录确认时调用，绕过KV）==========

  private async handleSaveCreds(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { botToken?: string; accountId?: string; userId?: string; baseUrl?: string; syncBuf?: string; createdAt?: number };
      const { botToken, accountId, userId, baseUrl, syncBuf } = body;
      if (!botToken || !accountId) {
        return new Response(JSON.stringify({ error: "缺少凭证" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const creds: ILinkCredentials = {
        botToken, accountId,
        baseUrl: baseUrl || "https://ilinkai.weixin.qq.com",
        userId: userId || "",
      };

      // 添加到多账号 Map
      this.accounts.set(accountId, {
        creds,
        syncBuf: syncBuf || "",
        consecutiveErrors: 0,
        lastPollAt: "",
        pollLoopRunning: false,
      });

      // 保持兼容：设 ilinkCreds
      this.ilinkCreds = creds;

      // 持久化所有账号
      await this.saveAccounts();

      const sessionToken = generateSessionToken();

      Logger.info("[DO] Account saved", { accountId, totalAccounts: this.accounts.size });
      return new Response(JSON.stringify({ ok: true, sessionToken, accountId, totalAccounts: this.accounts.size }), {
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

          const sessionToken = generateSessionToken();
          try {
            await this.kv!.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 });
          } catch {}

          Logger.info("[DO] QR login confirmed", { accountId: status.ilink_bot_id });
          return new Response(JSON.stringify({ status: "confirmed", ok: true }), {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": `clawbot_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}`,
            },
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
      const body = await request.json() as { toUserId?: string; contextToken?: string; text?: string };
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
    const accountsList = Array.from(this.accounts.entries()).map(([id, a]) => ({
      accountId: id,
      baseUrl: a.creds.baseUrl,
      userId: a.creds.userId,
      lastPollAt: a.lastPollAt,
      consecutiveErrors: a.consecutiveErrors,
      pollLoopRunning: a.pollLoopRunning,
    }));

    Logger.info(`[DO] Status check: accounts=${this.accounts.size} ilinkCreds=${!!this.ilinkCreds} listLen=${accountsList.length}`);

    // 兼容：如果没有 accounts 但有 ilinkCreds，构造一个
    if (accountsList.length === 0 && this.ilinkCreds) {
      accountsList.push({
        accountId: this.ilinkCreds.accountId,
        baseUrl: this.ilinkCreds.baseUrl,
        userId: this.ilinkCreds.userId || "",
        lastPollAt: this.state.lastPollAt,
        consecutiveErrors: this.state.consecutiveErrors,
        pollLoopRunning: false,
      });
    }

    // 兜底：如果还是空，尝试直接从 DO storage 读旧格式
    if (accountsList.length === 0) {
      try {
        const oldCreds = await this.doState.storage.get<string>("credentials");
        if (oldCreds) {
          const c = JSON.parse(oldCreds);
          if (c.botToken && c.accountId) {
            accountsList.push({
              accountId: c.accountId,
              baseUrl: c.baseUrl || "https://ilinkai.weixin.qq.com",
              userId: c.userId || "",
              lastPollAt: "",
              consecutiveErrors: 0,
              pollLoopRunning: false,
            });
          }
        }
      } catch {}
    }

    return new Response(JSON.stringify({
      success: true,
      isRunning: Array.from(this.accounts.values()).some(a => a.pollLoopRunning),
      lastPollAt: this.state.lastPollAt,
      consecutiveErrors: this.state.consecutiveErrors,
      pendingMessages: this.state.pendingMessages.length,
      hasCredentials: !!this.ilinkCreds,
      accountId: this.ilinkCreds?.accountId,
      needsReLogin: !this.ilinkCreds,
      stats: this.runtimeStats,
      accounts: accountsList,
      totalAccounts: this.accounts.size,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ========== SQLite contexts 查询（供管理面板使用）==========

  private async handleSQLiteContexts(): Promise<Response> {
    try {
      await this.initSQLite();
      const cursor = this.doState.storage.sql.exec(
        `SELECT user_id, messages, last_updated FROM contexts ORDER BY last_updated DESC`
      ).toArray();
      Logger.info(`[DO] SQLite contexts: raw rows=${cursor.length}`);
      const rows = cursor.map((r: any) => {
        let messageCount = 0;
        let rawMessages = r.messages;
        try {
          const parsed = JSON.parse(typeof rawMessages === 'string' ? rawMessages : JSON.stringify(rawMessages || "[]"));
          messageCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch (e) {
          Logger.warn(`[DO] Failed to parse context messages for ${r.user_id}`, { error: (e as Error).message, rawType: typeof rawMessages });
        }
        return { user_id: r.user_id, message_count: messageCount, last_updated: r.last_updated };
      });
      Logger.info(`[DO] SQLite contexts: ${rows.length} users, message_counts: ${rows.map(r => r.message_count).join(",")}`);
      return new Response(JSON.stringify({ rows }), { headers: { "Content-Type": "application/json" } });
    } catch (e: any) {
      Logger.warn("[DO] SQLite contexts query failed", { error: e.message });
      return new Response(JSON.stringify({ rows: [] }), { headers: { "Content-Type": "application/json" } });
    }
  }

  // ========== 立即触发一次轮询（用于发送消息后）==========

  private triggerImmediatePoll(): void {
    for (const [accountId, account] of this.accounts) {
      if (!account.pollLoopRunning) {
        account.pollLoopRunning = true;
        this.runAccountPollLoop(accountId).catch((e) => {
          Logger.error("[DO] Poll loop error", { accountId, error: e.message });
          account.pollLoopRunning = false;
        });
      }
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

  // ========== 单账号轮询循环 ==========

  private async runAccountPollLoop(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

    Logger.info("[DO] Account poll loop started", { accountId });

    while (account.pollLoopRunning) {
      try {
        const pollStart = Date.now();
        const result = await getUpdates(account.creds, account.syncBuf);

        if (result.get_updates_buf && result.get_updates_buf !== account.syncBuf) {
          account.syncBuf = result.get_updates_buf;
          await this.saveAccounts();
        }

        account.consecutiveErrors = 0;
        account.lastPollAt = new Date().toISOString();
        this.runtimeStats.polls++;
        this.runtimeStats.lastLatencyMs = Date.now() - pollStart;

        if (result.msgs && result.msgs.length > 0) {
          Logger.info("[DO] Received messages", { accountId, count: result.msgs.length });
          await this.processMessages(result.msgs, account.creds);
        }

        await this.doState.storage.put("runtime_stats", this.runtimeStats);
        await new Promise((resolve) => setTimeout(resolve, 30000));

      } catch (e: any) {
        Logger.error("[DO] Account poll error", { accountId, error: e.message });

        if (e.code === "ILINK_SESSION_TIMEOUT" || e.message?.includes("ILINK_SESSION_TIMEOUT")) {
          account.consecutiveErrors++;
          try {
            const refreshResult = await getQRCodeStatus(account.creds.accountId);
            if (refreshResult.status === "confirmed" && refreshResult.bot_token) {
              account.creds.botToken = refreshResult.bot_token;
              account.syncBuf = "";
              Logger.info("[DO] Token refreshed", { accountId });
              account.consecutiveErrors = 0;
              await this.saveAccounts();
              continue;
            }
          } catch {}

          account.pollLoopRunning = false;
          await this.saveAccounts();
          return;
        }

        account.consecutiveErrors++;
        if (account.consecutiveErrors > 10) {
          Logger.error("[DO] Account too many errors, stopping", { accountId });
          account.pollLoopRunning = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    }

    Logger.info("[DO] Account poll loop stopped", { accountId });
  }

  // ========== 处理消息 ==========

  private async getConfigCached() {
    const now = Date.now();
    if (this.cache.config && now - this.cache.configLoadedAt < 10 * 1000) {
      return this.cache.config;
    }

    let aiSystemPrompt = this.env.AI_SYSTEM_PROMPT || "";
    let webhookUrl = "";
    let webhookEnabled = false;
    let webhookTitle = "";
    let webhookApiKey = "";
    let webhookChannels: string[] = [];

    // 从 KV 读配置
    const configRaw = await this.kv?.get("clawbot:config");
    let kvConfig: Record<string, unknown> = {};
    try {
      if (configRaw) {
        kvConfig = JSON.parse(configRaw);
        aiSystemPrompt = aiSystemPrompt || (kvConfig.aiSystemPrompt as string) || "";
        webhookUrl = (kvConfig.webhookUrl as string) || "";
        webhookEnabled = (kvConfig.webhookEnabled as boolean) || false;
        webhookTitle = (kvConfig.webhookTitle as string) || "";
        webhookApiKey = (kvConfig.webhookApiKey as string) || "";
        webhookChannels = (kvConfig.webhookChannels as string[]) || [];
      }
    } catch (_e) {}

    // 使用 resolveAIConfig 统一解析 AI 提供商配置（支持 aiPresets）
    const presets = (kvConfig.aiPresets as any[]) || [];
    const activeProvider = (kvConfig.aiProvider as string) || "cloudflare";
    const activePreset = presets.find((p: any) => p.id === activeProvider);

    let aiModel = this.env.AI_MODEL || "";
    let aiProvider = "cloudflare";
    let aiBaseUrl = "";
    let aiApiKey = "";
    let aiMaxTokens = 1024;

    if (activePreset && activeProvider !== "cloudflare") {
      aiProvider = activeProvider;
      aiModel = activePreset.model || aiModel;
      aiBaseUrl = activePreset.baseUrl || "";
      // 自动修复：如果预设 apiKey 是掩码值（含 ***），用顶层字段替代
      aiApiKey = (activePreset.apiKey || "").includes("***") ? ((kvConfig.aiApiKey as string) || "") : (activePreset.apiKey || "");
      aiMaxTokens = activePreset.maxTokens || 1024;
    } else {
      // cloudflare 或无预设：回退到顶层字段
      aiProvider = activeProvider;
      aiModel = aiModel || (kvConfig.aiModel as string) || "";
      aiBaseUrl = (kvConfig.aiBaseUrl as string) || "";
      aiApiKey = (kvConfig.aiApiKey as string) || "";
      aiMaxTokens = (kvConfig.aiMaxTokens as number) || 1024;
    }

    const aiImageModel = (activePreset?.imageModel as string) || "@cf/black-forest-labs/flux-1-schnell";
    const aiVideoModel = (activePreset?.videoModel as string) || "bytedance/seedance-2.0-fast";

    const cfg = { aiSystemPrompt, aiModel, aiProvider, aiBaseUrl, aiApiKey, aiMaxTokens, aiImageModel, aiVideoModel, webhook: { enabled: webhookEnabled, url: webhookUrl, title: webhookTitle, apiKey: webhookApiKey, channels: webhookChannels } };
    this.cache.config = cfg;
    this.cache.configLoadedAt = now;
    Logger.info("[DO] Config loaded", { webhookEnabled, hasWebhookUrl: !!webhookUrl, provider: aiProvider });
    return cfg;
  }

  private async processMessages(msgs: WeixinMessage[], creds?: ILinkCredentials): Promise<void> {
    const useCreds = creds || this.ilinkCreds;
    Logger.info(`[DO] processMessages: ${msgs.length} msgs, using creds=${useCreds?.accountId || 'NONE'}`);
    const cfg = await this.getConfigCached();
    const { aiSystemPrompt: systemPrompt, aiModel } = cfg;
    let processedCount = 0;
    let aiSuccessCount = 0;
    let aiFailCount = 0;

    // 并行处理同一账号的多条消息（每条消息独立上下文，不互相干扰）
    const processOne = async (msg: WeixinMessage) => {
      Logger.info(`[DO] processOne: type=${msg.message_type} from=${msg.from_user_id?.slice(0,10)} text=${(msg.item_list?.[0] as any)?.text_item?.text?.slice(0,20) || 'N/A'}`);
      // 只处理用户消息
      if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) return;
      if (msg.message_type === undefined && !msg.from_user_id) return;

      const text = extractMessageText(msg);
      if (!text) return;

      const from = msg.from_user_id;
      const ctxToken = msg.context_token;
      if (!from || !ctxToken) return;

      const createdAt = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : new Date().toISOString();

      // 按账号生成 messageId（避免跨账号去重冲突）
      const messageId = `${useCreds?.accountId || "default"}:${this.generateMessageId(msg, text)}`;

      // DO 本地 SQLite 去重
      if (await this.hasProcessedMessage(messageId)) {
        Logger.info("[DO] Message already processed (local dedup)", { messageId });
        return;
      }

      let replyContent = "";
      let replyAt = "";

      // 检查重置命令
      const RESET_COMMANDS = new Set(["新对话", "/reset", "/clear", "重置", "清空"]);
      if (RESET_COMMANDS.has(text.trim())) {
        await clearContextSQLite(this.doState.storage.sql, from);
        await sendTextMessage(useCreds!, from, ctxToken, "✅ 已开始新对话");
        await this.markMessageProcessed(messageId);
        processedCount++;
        Logger.info("[DO] Context reset", { from });
        return;
      }

      try {
        // 发送"对方正在输入"状态
        sendTypingStatus(useCreds!, from, ctxToken, true).catch(() => {});

        // 检查是否为图片/视频生成请求
        if (isImageGenerationRequest(text) || isVideoGenerationRequest(text)) {
          const isVideo = isVideoGenerationRequest(text);
          const mediaType = isVideo ? "视频" : "图片";
          const mediaPrompt = extractMediaPrompt(text, isVideo ? "video" : "image");
          Logger.info(`[DO] ${mediaType} generation request detected`, { from, prompt: mediaPrompt.slice(0, 50), provider: cfg.aiProvider, hasAIBinding: !!this.env.AI, hasBaseUrl: !!cfg.aiBaseUrl, hasApiKey: !!cfg.aiApiKey, imageModel: cfg.aiImageModel });

          if (!this.env.AI) {
            Logger.error("[DO] AI binding not available for image/video generation");
            await sendTextMessage(useCreds!, from, ctxToken, "AI 服务未配置，无法生成图片/视频");
            await this.markMessageProcessed(messageId);
            sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});
            return;
          }

          try {
            if (isVideo) {
              const videoUrl = await generateVideo(this.env.AI, mediaPrompt, cfg.aiVideoModel, cfg.aiProvider, cfg.aiBaseUrl, cfg.aiApiKey);
              Logger.info("[DO] Video generation result", { success: !!videoUrl });
              if (videoUrl) {
                await sendTextMessage(useCreds!, from, ctxToken, `视频已生成：\n${videoUrl}`);
                replyContent = `[视频生成] ${mediaPrompt}`;
              } else {
                await sendTextMessage(useCreds!, from, ctxToken, "视频生成失败，请稍后重试或换个描述试试");
              }
            } else {
              const imageData = await generateImage(this.env.AI, mediaPrompt, cfg.aiImageModel, cfg.aiProvider, cfg.aiBaseUrl, cfg.aiApiKey);
              Logger.info("[DO] Image generation result", { success: !!imageData, type: typeof imageData });
              if (imageData) {
                if (typeof imageData === "string") {
                  // 返回的是 URL，先下载再通过 uploadAndSendMedia 发送
                  try {
                    const imgResp = await fetch(imageData, { signal: AbortSignal.timeout(30000) });
                    if (imgResp.ok) {
                      const buffer = await imgResp.arrayBuffer();
                      const contentType = imgResp.headers.get("content-type") || "image/png";
                      await uploadAndSendMedia(useCreds!, from, ctxToken, MessageItemType.IMAGE, "generated.png", buffer, contentType);
                      replyContent = `[图片生成] ${mediaPrompt}`;
                    } else {
                      throw new Error(`Download failed: ${imgResp.status}`);
                    }
                  } catch (sendErr: any) {
                    Logger.warn("[DO] Image send failed, sending URL as text", { error: sendErr?.message });
                    await sendTextMessage(useCreds!, from, ctxToken, `图片已生成，请点击查看：\n${imageData}`);
                    replyContent = `[图片生成] ${mediaPrompt}`;
                  }
                } else {
                  try {
                    await uploadAndSendMedia(useCreds!, from, ctxToken, MessageItemType.IMAGE, "generated.png", imageData.buffer as ArrayBuffer, "image/png");
                    replyContent = `[图片生成] ${mediaPrompt}`;
                  } catch {
                    await sendTextMessage(useCreds!, from, ctxToken, "图片已生成，请在管理后台 AI 测试面板查看");
                    replyContent = `[图片生成] ${mediaPrompt}`;
                  }
                }
              } else {
                await sendTextMessage(useCreds!, from, ctxToken, "图片生成失败，请稍后重试或换个描述试试");
              }
            }
          } catch (genErr: any) {
            Logger.error("[DO] Media generation error", { error: genErr?.message });
            await sendTextMessage(useCreds!, from, ctxToken, `生成失败: ${genErr?.message || "未知错误"}`);
          }

          replyAt = new Date().toISOString();
          aiSuccessCount++;
          await this.markMessageProcessed(messageId);
          sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});

          const pendingMsg = { messageId, fromUserId: from, content: text, timestamp: createdAt, replyContent, replyAt, processed: true };
          this.state.pendingMessages.push(pendingMsg);
          if (this.websockets.size > 0) this.broadcastToWebSockets({ type: "message", data: pendingMsg });
          return;
        }

        // 调用 AI 生成回复（使用 DO SQLite 存储上下文，不再走 KV）
        const reply = await callAIWithContext(
          this.doState.storage.sql,
          this.env.AI,
          from,
          text,
          systemPrompt,
          { provider: cfg.aiProvider, model: aiModel, baseUrl: cfg.aiBaseUrl, apiKey: cfg.aiApiKey, maxTokens: cfg.aiMaxTokens }
        );

        // 发送回复（自动分段）
        const chunks = await sendTextChunked(useCreds!, from, ctxToken, reply);
        replyContent = reply;
        replyAt = new Date().toISOString();
        aiSuccessCount++;
        await this.markMessageProcessed(messageId);

        // 取消 typing 状态
        sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});

        Logger.info("[DO] Message processed", { from, replyLength: reply.length, chunks });
      } catch (e: any) {
        aiFailCount++;
        Logger.error("[DO] AI processing failed", { error: e.message, from });
      }

      processedCount++;

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
      // 只在成功回复时才广播和入队
      if (replyContent) {
        this.state.pendingMessages.push(pendingMsg);

        // 广播到 WebSocket 客户端
        if (this.websockets.size > 0) {
          this.broadcastToWebSockets({ type: "message", data: pendingMsg });
        }

        // Webhook 推送（fire and forget）
        const webhookConfig = this.cache.config?.webhook;
        Logger.info("[DO] Webhook check", { enabled: webhookConfig?.enabled, hasUrl: !!webhookConfig?.url, url: webhookConfig?.url?.slice(0, 50), replyLength: replyContent.length });
        if (webhookConfig?.enabled && webhookConfig?.url) {
          Logger.info("[DO] Webhook sending", { to: from });
          sendWebhook(webhookConfig, { fromUserId: from, content: text, replyContent, timestamp: createdAt }).catch((e) => {
            Logger.error("[DO] Webhook failed", { error: (e as Error).message });
          });
        }
      }
    };

    // 并行处理所有消息
    await Promise.all(msgs.map(processOne));

    // 更新运行时统计
    this.runtimeStats.handled += processedCount;
    this.runtimeStats.aiCalls += aiSuccessCount;
    this.runtimeStats.aiFails += aiFailCount;

    // 批量更新一次统计
    if (msgs.length > 0 || processedCount > 0) {
      await this.updateStats(msgs.length, processedCount, aiSuccessCount, aiFailCount);
    }
  }

  // ========== 凭证管理（DO SQLite 版）==========

  private async initCredentials(): Promise<void> {
    const now = Date.now();
    Logger.info(`[DO] initCredentials: accounts=${this.accounts.size} cached=${!!this.cache.credentials}`);

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
        // 补充 accounts Map
        if (!this.accounts.has(this.ilinkCreds.accountId)) {
          this.accounts.set(this.ilinkCreds.accountId, {
            creds: this.ilinkCreds, syncBuf: this.cache.credentials.syncBuf || "",
            consecutiveErrors: 0, lastPollAt: "", pollLoopRunning: false,
          });
        }
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
          if (!this.accounts.has(creds.accountId)) {
            this.accounts.set(creds.accountId, {
              creds: this.ilinkCreds!, syncBuf: creds.syncBuf || "",
              consecutiveErrors: 0, lastPollAt: "", pollLoopRunning: false,
            });
          }
          Logger.info(`[DO] initCredentials: loaded from KV, accounts=${this.accounts.size}`);
          return;
        }
      }
    } catch (e) {
      Logger.warn("[DO] Failed to read credentials from KV", { error: (e as Error).message });
    }

    // 3) 从 DO storage 读取凭证（主存储）
    try {
      const credsRaw = await this.doState.storage.get<string>("credentials");
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
          // 同步到 accounts Map（兼容旧格式迁移）
          if (!this.accounts.has(creds.accountId)) {
            this.accounts.set(creds.accountId, {
              creds: this.ilinkCreds!,
              syncBuf: creds.syncBuf || "",
              consecutiveErrors: 0,
              lastPollAt: "",
              pollLoopRunning: false,
            });
            this.saveAccounts().catch(() => {});
          }
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
      this.doState.storage.sql.exec(
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
      this.doState.storage.sql.exec(
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
      await this.doState.storage.put("session", {
        syncBuf: this.state.syncBuf,
        lastPollAt: this.state.lastPollAt,
        consecutiveErrors: this.state.consecutiveErrors,
        isRunning: Array.from(this.accounts.values()).some(a => a.pollLoopRunning),
      });
    } catch (e) {
      Logger.error("[DO] Failed to save state", { error: (e as Error).message });
    }
  }

  private async updateStats(polls: number, handled: number, aiCalls: number, aiFails: number): Promise<void> {
    // 统计数据由 runtimeStats 追踪，持久化到 DO storage
  }

  private async hasProcessedMessage(messageId: string): Promise<boolean> {
    try {
      const rows = this.doState.storage.sql.exec(
        `SELECT 1 as found FROM processed_messages WHERE message_id = ? LIMIT 1`,
        messageId
      ).toArray();
      return rows.length > 0;
    } catch (e) {
      Logger.warn("[DO] Failed to query processed_messages", { error: (e as Error).message, messageId });
      return false;
    }
  }

  private async markMessageProcessed(messageId: string): Promise<void> {
    try {
      this.doState.storage.sql.exec(
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
