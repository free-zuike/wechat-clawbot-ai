// iLink Durable Object - 管理微信机器人的长轮询连接
// 架构：DO 替代 Cron 轮询，实现消息实时接收
// 优化：credentials 和 context 从 KV 迁移到 DO SQLite，彻底消除 KV 读写

import { Logger } from "../utils/error";
import { generateSessionToken } from "../utils";
import { getUpdates, sendTextMessage, sendTextChunked, sendTypingStatus, extractMessageText, getQRCodeStatus, sendImageMessage, sendVideoMessage, sendImageSimple, uploadAndSendMedia, MessageType, MessageItemType, downloadImageFromCdn } from "./ilink";
import { callAIWithContext, isImageGenerationRequest, isVideoGenerationRequest, extractMediaPrompt, extractImageSize, extractVideoDuration, extractUrl, generateImage, submitVideoTask } from "./ai";
import { sendWebhook } from "./webhook";
import { clearContextSQLite, clearContextD1 } from "./context";
import type { ILinkCredentials, WeixinMessage } from "../types";
import { initSQLite, initD1Tables, ensurePendingVideosColumns, ensureGenerationLogsColumns, loadCredentials, saveCredentials, clearCredentials, loadAllCredentials } from "./ilink-db";
import {
  handleLongPoll, handleWebSocket, handleSaveSession, handleCheckSession,
  handleSaveCreds, handleClearCreds, handleQRPoll, handleSend, handleSendVideo,
  handleBroadcastImage, handleStoreImage, handleGetImage, handleStorePendingVideo,
  handlePendingVideos, handleLogGeneration, handleGenerationLogs,
  handleGetCreds, handleStatus, handleSQLiteContexts, handleFlush,
  type DOContext,
} from "./ilink-handlers";

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
  config: { aiSystemPrompt: string; aiModel: string; aiProvider: string; aiBaseUrl: string; aiApiKey: string; aiMaxTokens: number; aiMaxContextChars: number; aiImageModel: string; aiVideoModel: string; allKeys: string[]; aiMaxRetries: number; responseConfig: any; mcpServers: any[]; webhook: { enabled: boolean; url: string; title: string; apiKey: string; channels: string[] } } | null;
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
  // 缓存每个用户最近发送的图片 URL（用于以图生图，有效期 60 秒）
  private recentImageUrls: Map<string, { url: string; timestamp: number }> = new Map();
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

  // ========== SQLite / D1 初始化 ==========

  private async initSQLite(): Promise<void> {
    if (this.sqliteInitialized) return;
    const sql = this.doState.storage.sql;
    await initSQLite(sql);
    await ensurePendingVideosColumns(sql);
    await ensureGenerationLogsColumns(sql);
    this.sqliteInitialized = true;

    // D1: 确保持久化表存在
    if (this.env.DB) {
      try {
        await initD1Tables(this.env.DB);
      } catch (e: any) {
        Logger.warn("[DO] D1 init skipped", { error: e?.message || String(e) });
      }
    }
  }

  // ========== HTTP 处理（长轮询入口）==========

  // 构建 handler 上下文（传递 DO 内部状态引用）
  private getCtx(): DOContext {
    const self = this;
    return {
      env: this.env,
      doState: this.doState,
      websockets: this.websockets,
      accounts: this.accounts,
      get ilinkCreds() { return self.ilinkCreds; },
      set ilinkCreds(v) { self.ilinkCreds = v; },
      state: this.state,
      cache: this.cache,
      runtimeStats: this.runtimeStats,
      kv: this.kv,
      sqliteInitialized: this.sqliteInitialized,
      broadcastToWebSockets: (data) => this.broadcastToWebSockets(data),
      logGeneration: (...args) => this.logGeneration(...args),
      getConfigCached: () => this.getConfigCached(),
      initSQLite: () => this.initSQLite(),
      saveAccounts: () => this.saveAccounts(),
      triggerImmediatePoll: () => this.triggerImmediatePoll(),
      detectImageMime: (data) => this.detectImageMime(data),
    };
  }

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

    const ctx = this.getCtx();

    // WebSocket 升级
    if (url.pathname === "/ws" || url.pathname === "/api/ws") {
      return handleWebSocket(ctx, request);
    }

    // /status、/sqlite/contexts 等路径不检查凭证
    if (url.pathname === "/status") return handleStatus(ctx);
    if (url.pathname === "/sqlite/contexts") return handleSQLiteContexts(ctx);
    if (url.pathname === "/qr-poll") return handleQRPoll(ctx, url);
    if (url.pathname === "/check-session") return handleCheckSession(ctx, url);
    if (url.pathname === "/save-session") return handleSaveSession(ctx, request);
    if (url.pathname === "/save-creds") return handleSaveCreds(ctx, request);
    if (url.pathname === "/send-video") return handleSendVideo(ctx, request);
    if (url.pathname === "/broadcast-image") return handleBroadcastImage(ctx, request);
    if (url.pathname === "/store-image") return handleStoreImage(ctx, request);
    if (url.pathname.startsWith("/get-image/")) return handleGetImage(ctx, url);
    if (url.pathname === "/store-pending-video") return handleStorePendingVideo(ctx, request);
    if (url.pathname === "/check-pending-videos") return this.checkPendingVideos().then(() => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    if (url.pathname === "/pending-videos") return handlePendingVideos(ctx, request);
    if (url.pathname === "/generation-logs") return handleGenerationLogs(ctx, request);
    if (url.pathname === "/log-generation") return handleLogGeneration(ctx, request);
    if (url.pathname === "/get-creds") return handleGetCreds(ctx);
    if (url.pathname === "/clear-creds") return handleClearCreds(ctx, request);

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
        return handleLongPoll(ctx);
      case "/send":
        return handleSend(ctx, request);
      case "/status":
        return handleStatus(ctx);
      case "/sqlite/contexts":
        return handleSQLiteContexts(ctx);
      case "/flush":
        return handleFlush(ctx);
      case "/qr-poll":
        return handleQRPoll(ctx, url);
      case "/save-creds":
        return handleSaveCreds(ctx, request);
      default:
        return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
    }
  }

  // ========== 拉取消息（立即返回，不长轮询）==========

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

  private detectImageMime(data: Uint8Array): string {
    if (data[0] === 0xFF && data[1] === 0xD8) return "image/jpeg";
    if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
    if (data[0] === 0x52 && data[1] === 0x49) return "image/webp";
    return "image/png";
  }

  // ========== 保存 session（admin登录时调用）==========

  // ========== 持久化所有账号 ==========
  private async saveAccounts(): Promise<void> {
    const arr = Array.from(this.accounts.entries()).map(([accountId, a]) => ({
      accountId,
      creds: a.creds,
      syncBuf: a.syncBuf,
    }));
    await this.doState.storage.put("accounts", arr);
  }

  // ========== 生成记录日志 ==========

  private async logGeneration(type: string, prompt: string, result: string, provider: string, model: string, status: string, error?: string, source?: string, fromUser?: string, keyIndex?: number, providerName?: string): Promise<void> {
    try {
      if (!this.sqliteInitialized) await this.initSQLite();
      if (this.env.DB) {
        await this.env.DB.prepare(
          `INSERT INTO generation_logs (type, prompt, result, provider, model, status, error, source, from_user, created_at, key_index, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(type, (prompt || "").slice(0, 500), (result || "").slice(0, 1000), provider, model, status, error || "", source || "", fromUser || "", Date.now(), keyIndex || 0, providerName || "").run();
      }
      console.log("[DO] logGeneration OK", { type, provider, model, source, keyIndex });
    } catch (e: any) {
      console.error("[DO] logGeneration FAILED", e?.message, { type, provider });
    }
  }

  // ========== Cron 检查待处理的视频任务 ==========

  async checkPendingVideos(): Promise<void> {
    try {
      await this.initSQLite();

      // 自动清理超过 24 小时的已完成/失败任务
      const cleanupAge = Date.now() - 24 * 60 * 60 * 1000;
      await this.env.DB.prepare(
        `DELETE FROM pending_videos WHERE status IN ('completed', 'failed') AND created_at < ?`
      ).bind(cleanupAge).run();

      // D1: 查询待处理的视频任务
      const { results: pending } = await this.env.DB.prepare(
        `SELECT task_id, video_id, prompt, model, provider, base_url, api_key, to_user_id, context_token, account_id, source, created_at FROM pending_videos WHERE status = 'queued'`
      ).all();

      if (pending.length === 0) return;

      // 查找提供商名称
      const cfg = await this.getConfigCached();
      const customProviders = (cfg as any).aiCustomProviders || [];
      const getProviderName = (id: string) => (customProviders.find((p: any) => p.id === id) as any)?.name || id;

      const now = Date.now();
      const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 任务 24 小时后超时放弃

      // 清理永远无法发送的旧任务（缺少 to_user_id / context_token 且非 chat 来源）
      // chat 来源的任务没有用户信息，但需要轮询视频状态并广播到 WebSocket
      const orphanIds: string[] = [];
      for (const task of pending) {
        const tid = task.task_id as string;
        const tu = task.to_user_id as string | undefined;
        const ct = task.context_token as string | undefined;
        const src = (task.source as string) || "";
        const createdAt = Number(task.created_at) || 0;
        const ageHrs = (now - createdAt) / 3600000;
        // 只清理超过 1 小时且无用户信息且非 chat 来源的旧任务
        if (!tu && !ct && src !== "chat" && ageHrs > 1) orphanIds.push(tid);
      }
      if (orphanIds.length > 0) {
        try {
          for (const tid of orphanIds) {
            await this.env.DB.prepare(`DELETE FROM pending_videos WHERE task_id = ?`).bind(tid).run();
          }
          Logger.info("[DO] Cleaned orphan pending videos", { count: orphanIds.length, ids: orphanIds.slice(0, 5) });
        } catch (e: any) {
          Logger.warn("[DO] Failed to clean orphan tasks", { error: e?.message });
        }
      }

      for (const task of pending) {
        const taskId = task.task_id as string;
        const taskSource = (task.source as string) || "";

        // 跳过缺少用户信息且非 chat 来源的任务（旧的孤儿任务会在上面被清理）
        const toUserId = task.to_user_id as string | undefined;
        const contextToken = task.context_token as string | undefined;
        if (!toUserId && !contextToken && taskSource !== "chat") {
          // 已经在 cleanup 中删除；如果还在这里说明 cleanup 失败，安全跳过
          continue;
        }

        // 超时保护：任务超过 24 小时且仍未下载成功，标记失败，避免永远重试
        const createdAt = Number(task.created_at) || now;
        const ageMs = now - createdAt;
        if (ageMs > MAX_AGE_MS) {
          Logger.warn("[DO] Video task timed out (> 24h) — marking as failed", { taskId, ageHours: Math.round(ageMs / 3600000) });
          await this.env.DB.prepare(`UPDATE pending_videos SET status = 'failed' WHERE task_id = ?`).bind(taskId).run();
          const modelInfo = `🤖 ${getProviderName(task.provider as string)} · ${task.model}`;
          // 凭证解析：先按 accountId 找，找不到时用第一个账号或 ilinkCreds
          const accountId = task.account_id as string | undefined;
          let sendCreds: ILinkCredentials | null = null;
          if (accountId && this.accounts.has(accountId)) {
            sendCreds = this.accounts.get(accountId)!.creds;
          } else {
            const allAccounts = Array.from(this.accounts.values());
            sendCreds = allAccounts[0]?.creds || this.ilinkCreds;
          }
          if (sendCreds) {
            sendTextMessage(sendCreds, toUserId, contextToken, `❌ 视频下载超时 (${modelInfo})\n生成成功但下载失败，可重新生成`)
              .catch(() => {});
          }
          continue;
        }

        // Agnes API 限流保护：每个任务查询之间延迟 1-2 秒
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

        // baseUrl 规范化：去掉末尾斜杠，去掉任何版本号和端点路径（/v1/...、/v4/...）
        let base = (task.base_url as string).replace(/\/+$/, "");
        base = base.replace(/\/v\d+\/(chat\/completions|images\/generations|videos?\/generations|videos\/?|videos|async-result\/.*)$/i, "");
        base = base.replace(/\/v\d+$/, "");
        const taskAccountId = task.account_id as string | undefined;
        const modelInfo = `🤖 ${getProviderName(task.provider as string)} · ${task.model}`;

        // 凭证解析：先按 taskAccountId 找，找不到时尝试所有账号，最后用 ilinkCreds
        let creds: ILinkCredentials | null = null;
        if (taskAccountId && this.accounts.has(taskAccountId)) {
          creds = this.accounts.get(taskAccountId)!.creds;
        } else {
          const allAccounts = Array.from(this.accounts.values());
          if (allAccounts.length > 0) {
            creds = allAccounts[0].creds;
          } else if (this.ilinkCreds) {
            creds = this.ilinkCreds;
          }
        }
        if (!creds) {
          Logger.warn("[DO] No credentials available for video delivery", { taskId, accountId: taskAccountId, toUserId: toUserId?.slice(0, 10) });
        }

        const isCloudflare = task.provider === "cloudflare" || (task.base_url as string).startsWith("cf://");
        let videoUrl: string | null = null;
        let taskFailed = false;
        let stillProcessing = false;

        try {
          if (isCloudflare) {
            // Cloudflare AI：通过 aiBinding 查状态
            const cfModel = (task.base_url as string).replace(/^cf:\/\//, "");
            if (!this.env.AI) {
              Logger.warn("[DO] Cloudflare AI binding not available", { taskId });
              continue;
            }
            const status = await this.env.AI.run(cfModel, { jobId: taskId });
            Logger.info("[DO] Cloudflare video status", { taskId, state: status?.state, keys: status ? Object.keys(status).slice(0, 10) : [] });

            if (status?.state === "Completed" && status?.result?.video) {
              videoUrl = status.result.video;
            } else if (status?.state === "Failed") {
              taskFailed = true;
              Logger.warn("[DO] Cloudflare video task failed", { taskId, response: JSON.stringify(status).slice(0, 200) });
            } else {
              stillProcessing = true;
              Logger.info("[DO] Cloudflare video task still processing", { taskId, state: status?.state });
              continue;
            }
          } else {
            const videoId = task.video_id as string | undefined;
            const taskBaseUrl = (task.base_url as string) || "";
            const isZhipu = taskBaseUrl.includes("bigmodel.cn");
            let checkUrl: string;
            if (isZhipu) {
              const version = taskBaseUrl.match(/\/(v\d+)\//)?.[1] || "v4";
              checkUrl = `${base}/${version}/async-result/${taskId}`;
            } else if (videoId) {
              checkUrl = `${base}/agnesapi?video_id=${encodeURIComponent(videoId)}`;
            } else {
              checkUrl = `${base}/v1/videos/${taskId}`;
            }
            const statusResp = await fetch(checkUrl, {
              headers: { "Authorization": `Bearer ${task.api_key}` },
            });
            if (!statusResp.ok) {
              const errBody = await statusResp.text().catch(() => "");
              Logger.warn("[DO] Video status check failed", { taskId, videoId, status: statusResp.status, body: errBody.slice(0, 200), url: checkUrl });
              const errMsg = `HTTP ${statusResp.status}: ${errBody.slice(0, 200)}`;
              await this.env.DB.prepare(
                `UPDATE pending_videos SET retry_count = retry_count + 1, error_message = ? WHERE task_id = ?`
              ).bind(errMsg, taskId).run();
              if (statusResp.status === 404) {
                taskFailed = true;
                Logger.warn("[DO] Video task 404 — marking as failed (task not found on provider)", { taskId });
              }
              continue;
            }
            const statusData = await statusResp.json() as any;

            // 智谱 async-result 格式：task_status + video_result[0].url
            if (isZhipu) {
              const taskStatus = statusData.task_status;
              if (taskStatus === "SUCCESS") {
                videoUrl = statusData.video_result?.[0]?.url || null;
                if (!videoUrl) {
                  Logger.warn("[DO] Zhipu video SUCCESS but no URL", { taskId, keys: Object.keys(statusData || {}).slice(0, 15) });
                  for (const v of Object.values(statusData)) {
                    if (typeof v === "string" && v.startsWith("http")) { videoUrl = v; break; }
                  }
                }
                Logger.info("[DO] Zhipu video completed", { taskId, url: videoUrl?.substring(0, 120) });
              } else if (taskStatus === "FAIL") {
                taskFailed = true;
                Logger.warn("[DO] Zhipu video failed", { taskId, error: statusData.error || statusData.message });
              } else {
                stillProcessing = true;
                Logger.info("[DO] Zhipu video still processing", { taskId, status: taskStatus });
              }
            } else if (statusData.status === "completed" && statusData.remixed_from_video_id) {
              // Agnes 文档说 remixed_from_video_id 是视频 URL
              // 注意：这个字段也可能只是视频 ID（而不是完整 URL
              // 如果是 ID，则需要额外 API 调用获取真实 URL
              const rawUrl = String(statusData.remixed_from_video_id);
              // 确保是完整 URL（有协议前缀）
              if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
                videoUrl = rawUrl;
              } else if (rawUrl.includes(".")) {
                // 包含域名但缺协议
                videoUrl = "https://" + rawUrl;
              } else {
                // 看起来是 ID，尝试通过 Agnes API 获取 URL
                Logger.info("[DO] remixed_from_video_id looks like an ID, trying to resolve to URL", { taskId, videoId: rawUrl.substring(0, 40) });
                const checkUrl2 = `${base}/agnesapi?action=get_video&video_id=${encodeURIComponent(rawUrl)}`;
                try {
                  const r2 = await fetch(checkUrl2, { headers: { "Authorization": `Bearer ${task.api_key}` } });
                  if (r2.ok) {
                    const j2 = await r2.json() as any;
                    Logger.info("[DO] Agnes video lookup response", { response: JSON.stringify(j2).slice(0, 400) });
                    // 常见字段名
                    videoUrl = j2.url || j2.video_url || j2.videoUrl || j2.video || j2.remixed_from_video_id || j2.file_url || j2.data?.url || j2.data?.remixed_from_video_id;
                    if (!videoUrl) {
                      // 遍历所有字段，找包含 http(s)
                      for (const v of Object.values(j2)) {
                        if (typeof v === "string" && v.startsWith("http")) { videoUrl = v; break; }
                      }
                    }
                  }
                } catch (e3: any) {
                  Logger.warn("[DO] Failed to resolve Agnes video ID", { error: e3?.message });
                }
              }
              Logger.info("[DO] Video task completed", { taskId, videoId, url: videoUrl?.substring(0, 120) });
            } else if (statusData.status === "completed") {
              Logger.warn("[DO] Video status completed but no url returned", { taskId, keys: Object.keys(statusData || {}).slice(0, 15), preview: JSON.stringify(statusData).slice(0, 400) });
              // 尝试遍历所有字段，找 URL
              for (const v of Object.values(statusData)) {
                if (typeof v === "string" && v.startsWith("http")) { videoUrl = v; break; }
              }
            } else if (statusData.status === "failed") {
              taskFailed = true;
              Logger.warn("[DO] Video task failed (provider)", { taskId, videoId, error: statusData.error });
            } else {
              stillProcessing = true;
              Logger.info("[DO] Video task still processing", { taskId, videoId, status: statusData.status, progress: statusData.progress });
            }
          }

          if (videoUrl) {
            // 尝试发送视频给微信用户。CDN 可能需要时间准备（502），
            // 下载失败时不标记 completed，下次 cron 继续尝试
            let sentSuccessfully = false;
            if (creds && toUserId && contextToken) {
              try {
                Logger.info("[DO] Sending video", {
                  taskId,
                  videoUrl: videoUrl.substring(0, 120),
                  toUserId: toUserId.slice(0, 20),
                  credsValid: !!(creds && creds.botToken && creds.baseUrl),
                  credsBaseUrl: creds?.baseUrl?.substring(0, 80),
                });
                await sendVideoMessage(creds, toUserId, contextToken, videoUrl, task.api_key as string);
                sentSuccessfully = true;
                Logger.info("[DO] Video sent to WeChat successfully", { taskId });
              } catch (e2: any) {
                Logger.warn("[DO] Video send failed — keeping task pending", {
                  taskId,
                  errorCode: e2?.code || "UNKNOWN",
                  errorMessage: e2?.message?.slice(0, 300) || String(e2).slice(0, 300),
                  httpStatus: e2?.httpStatus || e2?.status,
                });
              }
            } else {
              Logger.warn("[DO] Cannot send video — credentials/user info missing", {
                taskId,
                hasCreds: !!creds,
                hasToUserId: !!toUserId,
                hasContextToken: !!contextToken,
              });
            }

            // 无论发送成功与否，都更新状态避免重复发送
            // 发送失败时标记为 failed（下次不再尝试），成功时标记为 completed
            const newStatus = sentSuccessfully ? 'completed' : 'failed';
            try {
              await this.env.DB.prepare(
                `UPDATE pending_videos SET status = ?, video_url = ? WHERE task_id = ?`
              ).bind(newStatus, videoUrl, taskId).run();
              Logger.info("[DO] Updated pending_video status", { taskId, status: newStatus });
            } catch (e3: any) {
              Logger.error("[DO] Failed to update pending_video status", { taskId, error: e3?.message });
            }
            // 广播到 WebSocket（管理后台显示），chat 来源的视频也广播
            this.broadcastToWebSockets({
              type: "media_generated",
              mediaType: "video",
              url: videoUrl,
              model: task.model,
              provider: task.provider,
              prompt: task.prompt,
              source: taskSource || undefined,
            });
            Logger.info("[DO] Video completed", { taskId, url: videoUrl.slice(0, 80), sentToWeChat: sentSuccessfully, source: taskSource });
          } else if (taskFailed) {
            const errMsg = `任务失败 (provider: ${task.provider}, model: ${task.model})`;
            await this.env.DB.prepare(
              `UPDATE pending_videos SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE task_id = ?`
            ).bind(errMsg, taskId).run();
            if (taskSource !== "chat" && creds && toUserId && contextToken) {
              await sendTextMessage(creds, toUserId, contextToken, `❌ 视频生成失败 (${modelInfo})\n请稍后重试或换个描述试试`).catch(() => {});
            }
            this.broadcastToWebSockets({
              type: "media_error",
              message: `视频生成失败 (${task.provider} · ${task.model})`,
              model: task.model,
              provider: task.provider,
              source: taskSource || undefined,
            });
            Logger.error("[DO] Video generation failed", { taskId });
          }
          // stillProcessing: 什么也不做，下次 cron 再检查
        } catch (e: any) {
          Logger.warn("[DO] Video status check error", { taskId, error: e?.message });
        }
      }
    } catch (e: any) {
      Logger.error("[DO] Check pending videos error", { error: e.message });
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

  // ========== 轮询循环 ==========

  // ========== 单账号轮询循环 ==========

  private async runAccountPollLoop(accountId: string): Promise<void> {
    const account = this.accounts.get(accountId);
    if (!account) return;

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
          await this.processMessages(result.msgs, account.creds);
        }

        await this.doState.storage.put("runtime_stats", this.runtimeStats);
        await new Promise((resolve) => setTimeout(resolve, 30000));

      } catch (e: any) {
        if (e.code === "ILINK_SESSION_TIMEOUT" || e.message?.includes("ILINK_SESSION_TIMEOUT")) {
          account.consecutiveErrors++;
          try {
            const refreshResult = await getQRCodeStatus(account.creds.accountId);
            if (refreshResult.status === "confirmed" && refreshResult.bot_token) {
              account.creds.botToken = refreshResult.bot_token;
              account.syncBuf = "";
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
          Logger.error("[DO] Account errors exceeded", { accountId });
          account.pollLoopRunning = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    }
  }

  // ========== 处理消息 ==========

  private async getConfigCached() {
    const now = Date.now();
    if (this.cache.config && now - this.cache.configLoadedAt < 10 * 1000) {
      return this.cache.config;
    }

    let aiSystemPrompt = this.env.AI_SYSTEM_PROMPT || "";
    let webhookUrl = "";

    // 确保 MCP 表存在
    try {
      const { ensureMCPServersTable, ensureMCPSessionsTable } = await import("../services/mcp");
      await ensureMCPServersTable(this.env.DB);
      await ensureMCPSessionsTable(this.env.DB);
    } catch (_e) {}
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
        // 自动修复旧数据中的掩码密钥
        if (typeof kvConfig.aiApiKey === "string" && kvConfig.aiApiKey.includes("***")) {
          kvConfig.aiApiKey = "";
        }
        const presets = kvConfig.aiPresets as any[] | undefined;
        if (Array.isArray(presets)) {
          for (const p of presets) {
            if (typeof p.apiKey === "string" && p.apiKey.includes("***")) {
              p.apiKey = "";
            }
          }
        }
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
    let aiMaxContextChars = 12000;

    if (activePreset && activeProvider !== "cloudflare") {
      aiProvider = activeProvider;
      aiModel = activePreset.model || aiModel;
      aiBaseUrl = activePreset.baseUrl || "";
      // 自动修复：如果预设 apiKey 是掩码值（含 ***），用顶层字段替代
      aiApiKey = (activePreset.apiKey || "").includes("***") ? ((kvConfig.aiApiKey as string) || "") : (activePreset.apiKey || "");
      aiMaxTokens = activePreset.maxTokens || 1024;
      aiMaxContextChars = activePreset.maxContextChars || 12000;
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

    const backupKeys = ((activePreset?.apiKeys as string[]) || []).filter((k: string) => k && !k.includes("***"));
    const allKeys = [aiApiKey, ...backupKeys].filter(Boolean);
    const aiMaxRetries = (kvConfig.aiMaxRetries as number) || 2;

    const responseConfig = (activePreset?.responseConfig as any) || {};
    // 加载 MCP 服务器配置
    let mcpServers: any[] = [];
    try {
      const { loadAllMCPServers } = await import("../services/mcp");
      mcpServers = (await loadAllMCPServers(this.env.DB)).filter((s: any) => s.enabled);
    } catch (_e) {}
    const cfg = { aiSystemPrompt, aiModel, aiProvider, aiBaseUrl, aiApiKey, aiMaxTokens, aiMaxContextChars, aiImageModel, aiVideoModel, allKeys, aiMaxRetries, responseConfig, aiCustomProviders: (kvConfig.aiCustomProviders as any[]) || [], mcpServers, webhook: { enabled: webhookEnabled, url: webhookUrl, title: webhookTitle, apiKey: webhookApiKey, channels: webhookChannels } };
    this.cache.config = cfg;
    this.cache.configLoadedAt = now;
    return cfg;
  }

  private async processMessages(msgs: WeixinMessage[], creds?: ILinkCredentials): Promise<void> {
    const useCreds = creds || this.ilinkCreds;
    const cfg = await this.getConfigCached();
    const { aiSystemPrompt: systemPrompt, aiModel } = cfg;

    // 查找提供商显示名称
    const customProviders = (cfg as any).aiCustomProviders || [];
    const providerName = (customProviders.find((p: any) => p.id === cfg.aiProvider) as any)?.name || cfg.aiProvider;
    let processedCount = 0;
    let aiSuccessCount = 0;
    let aiFailCount = 0;

    // 并行处理同一账号的多条消息（每条消息独立上下文，不互相干扰）
    const processOne = async (msg: WeixinMessage) => {
      // 只处理用户消息
      if (msg.message_type !== undefined && msg.message_type !== MessageType.USER) return;
      if (msg.message_type === undefined && !msg.from_user_id) return;

      const text = extractMessageText(msg);
      const from = msg.from_user_id;
      const ctxToken = msg.context_token;

      // 提取消息中的图片信息和是否有真实文字
      let imageUrl: string | undefined;
      let imageCdnParams: { encryptQueryParam: string; aesKey: string } | undefined;
      let hasRealText = false;
      for (const item of (msg.item_list || [])) {
        if (item.type === MessageItemType.IMAGE) {
          imageUrl = item.image_item?.cdn_url || item.image_item?.url;
          if (!imageUrl && item.image_item?.media?.encrypt_query_param && item.image_item?.media?.aes_key) {
            imageCdnParams = {
              encryptQueryParam: item.image_item.media.encrypt_query_param,
              aesKey: item.image_item.media.aes_key,
            };
          }
        }
        if (item.type === MessageItemType.TEXT && item.text_item?.text) {
          hasRealText = true;
        }
      }

      // 纯图片消息（无文字 item）：缓存图片信息供后续以图生图使用
      if ((imageUrl || imageCdnParams) && !hasRealText && from) {
        const now = Date.now();
        if (imageUrl) {
          this.recentImageUrls.set(from, { url: imageUrl, timestamp: now });
        } else if (imageCdnParams) {
          const downloaded = await downloadImageFromCdn(imageCdnParams.encryptQueryParam, imageCdnParams.aesKey);
          if (downloaded) {
            let binary = "";
            for (let i = 0; i < downloaded.length; i++) binary += String.fromCharCode(downloaded[i]);
            const dataUrl = `data:image/png;base64,${btoa(binary)}`;
            this.recentImageUrls.set(from, { url: dataUrl, timestamp: now });
          }
        }
        for (const [key, val] of this.recentImageUrls) {
          if (now - val.timestamp > 60_000) this.recentImageUrls.delete(key);
        }
        await this.markMessageProcessed(`${useCreds?.accountId || "default"}:${this.generateMessageId(msg, imageUrl || "cdn-image")}`);
        return;
      }

      if (!text) return;

      // 引用功能暂不可用，iLink API 的 sendmessage 不支持扁平格式
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
        if (this.env.DB) { await clearContextD1(this.env.DB, from); } else { await clearContextSQLite(this.doState.storage.sql, from); }
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
          // 以图生图：如果当前消息没有图片，尝试从缓存获取用户最近发送的图片
          if (!imageUrl && from) {
            const cached = this.recentImageUrls.get(from);
            if (cached && Date.now() - cached.timestamp < 60_000) {
              imageUrl = cached.url;
              Logger.info("[DO] Using cached image for image-to-image", { from: from.slice(0, 10), url: imageUrl.slice(0, 80) });
            }
          }
          Logger.info(`[DO] ${mediaType} generation request detected`, { from, prompt: mediaPrompt.slice(0, 50), provider: cfg.aiProvider, hasAIBinding: !!this.env.AI, hasBaseUrl: !!cfg.aiBaseUrl, hasApiKey: !!cfg.aiApiKey, imageModel: cfg.aiImageModel, hasImageRef: !!imageUrl });

          if (!this.env.AI) {
            Logger.error("[DO] AI binding not available for image/video generation");
            await sendTextMessage(useCreds!, from, ctxToken, "AI 服务未配置，无法生成图片/视频");
            await this.markMessageProcessed(messageId);
            sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});
            return;
          }

          // 生成期间定期刷新 typing 状态（每 4 秒刷新一次）
          let typingInterval: ReturnType<typeof setInterval> | null = null;
          const startTypingKeepAlive = () => {
            typingInterval = setInterval(() => {
              sendTypingStatus(useCreds!, from, ctxToken, true).catch(() => {});
            }, 4000);
          };
          const stopTypingKeepAlive = () => {
            if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
            sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});
          };

          try {
            if (isVideo) {
              // 异步提交视频任务：先提交 taskId，存到 pending_videos
              // 之后由 checkPendingVideos 轮询完成后发送视频
              startTypingKeepAlive();
              const videoParams = extractVideoDuration(text);
              const result = await submitVideoTask(this.env.AI, mediaPrompt, cfg.aiVideoModel, cfg.aiProvider, cfg.aiBaseUrl, cfg.aiApiKey, videoParams?.numFrames, videoParams?.frameRate);
              const modelInfo = `🤖 ${providerName} · ${cfg.aiVideoModel}`;
              if (result) {
                if (result.url) {
                  // 同步返回了 URL：先发文本通知，再异步尝试发送视频文件
                  await sendTextMessage(useCreds!, from, ctxToken, `🎬 ${modelInfo}\n\n视频已生成，正在发送中...`);
                  replyContent = `[视频生成] ${mediaPrompt}`;
                  sendVideoMessage(useCreds!, from, ctxToken, result.url, cfg.aiApiKey)
                    .then(() => Logger.info("[DO] Sync video file sent to WeChat"))
                    .catch((e: any) => Logger.warn("[DO] Sync video file send failed", { error: e?.message }));
                } else {
                  // 异步任务：存储到 pending_videos，稍后由 checkPendingVideos 处理
                  // 若返回了 video_id 则一起存储（Agnes 等平台优先用 video_id 查询）
                  Logger.info("[DO] Storing pending video task", {
                    taskId: result.taskId,
                    videoId: result.videoId,
                    from: from?.slice(0, 15),
                    ctxToken: ctxToken?.slice(0, 15),
                    accountId: useCreds?.accountId?.slice(0, 10)
                  });
                  await this.env.DB.prepare(
                    `INSERT OR REPLACE INTO pending_videos (task_id, video_id, prompt, model, provider, base_url, api_key, status, to_user_id, context_token, account_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
                  ).bind(result.taskId, result.videoId || null, result.prompt, result.model, result.provider, result.baseUrl, result.apiKey, from, ctxToken, useCreds?.accountId || null, Date.now()).run();
                  await sendTextMessage(useCreds!, from, ctxToken, `🎬 ${modelInfo}\n\n视频生成任务已提交，稍后生成完成后会自动发送给您。`);
                  replyContent = `[视频生成] ${mediaPrompt}`;
                  await this.logGeneration("video", mediaPrompt, result.taskId, cfg.aiProvider, cfg.aiVideoModel, "queued", undefined, "wechat", from);
                  try {
                    await this.env.CLAWBOT_QUEUE.send({
                      type: "video_check",
                      taskId: result.taskId,
                      videoId: result.videoId,
                      prompt: result.prompt,
                      model: result.model,
                      provider: result.provider,
                      baseUrl: result.baseUrl,
                      apiKey: result.apiKey,
                      toUserId: from,
                      contextToken: ctxToken,
                      accountId: useCreds?.accountId || "",
                      source: "",
                    }, { delaySeconds: 30 });
                  } catch (e: any) {
                    Logger.error("[DO] Queue schedule failed", { error: e?.message });
                  }
                }
              } else {
                await sendTextMessage(useCreds!, from, ctxToken, `❌ 视频生成失败 (${modelInfo})\n请稍后重试或换个描述试试`);
                await this.logGeneration("video", mediaPrompt, "", cfg.aiProvider, cfg.aiVideoModel, "failed", "视频提交失败", "wechat", from);
              }
              stopTypingKeepAlive();
            } else {
              startTypingKeepAlive();
              const imageSize = extractImageSize(text);
              // 如果没有图片参考，且 prompt 包含搜索意图，先搜索获取参考图
              if (!imageUrl && /搜索|搜|查找|找|的图|的照片|照片/.test(text)) {
                try {
                  const searchKeywords = mediaPrompt.replace(/搜索|搜|查找|找|的图|的照片|照片|生成图片|生成|图片/g, "").trim();
                  if (searchKeywords) {
                    const searchResp = await fetch(`https://image.so.com/j?q=${encodeURIComponent(searchKeywords)}&sn=5`, {
                      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json", "Referer": "https://image.so.com/" },
                    });
                    const searchData = await searchResp.json() as any;
                    if (searchData.list && searchData.list.length > 0) {
                      const validItems = searchData.list.filter((item: any) => item.img);
                      const randomItem = validItems[Math.floor(Math.random() * Math.min(validItems.length, 5))];
                      if (randomItem) {
                        imageUrl = randomItem.img;
                        Logger.info("[DO] Found reference image via search for generation", { keyword: searchKeywords });
                      }
                    }
                  }
                } catch {}
              }
              const imageDataResult = await generateImage(this.env.AI, mediaPrompt, cfg.aiImageModel, cfg.aiProvider, cfg.aiBaseUrl, cfg.aiApiKey, imageUrl, imageSize, cfg.allKeys, cfg.aiMaxRetries, undefined, cfg.responseConfig);
              const imageData = imageDataResult.data;
              const modelInfo = `🤖 ${providerName} · ${cfg.aiImageModel}`;
              Logger.info("[DO] Image generation result", { success: !!imageData, type: typeof imageData });
              if (imageData) {
                if (typeof imageData === "string") {
                  // URL：使用简单方式发送
                  await sendImageSimple(useCreds!, from, ctxToken, imageData);
                  replyContent = `[图片生成] ${mediaPrompt}`;
                  this.broadcastToWebSockets({ type: "media_generated", mediaType: "image", url: imageData, model: cfg.aiImageModel, provider: cfg.aiProvider });
                  await this.logGeneration("image", mediaPrompt, imageData, cfg.aiProvider, cfg.aiImageModel, "success", undefined, "wechat", from);
                } else {
                  // Uint8Array：转换为 base64 data URL 后发送
                  let binary = "";
                  for (let i = 0; i < imageData.length; i++) binary += String.fromCharCode(imageData[i]);
                  const mime = this.detectImageMime(imageData);
                  const dataUrl = `data:${mime};base64,${btoa(binary)}`;
                  await sendImageSimple(useCreds!, from, ctxToken, dataUrl);
                  replyContent = `[图片生成] ${mediaPrompt}`;
                  // 存入 DO storage 后广播 URL 引用（避免 WebSocket 消息过大）
                  const storeResp = await handleStoreImage(this.getCtx(), new Request("http://localhost/store-image", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ imageData: dataUrl, model: cfg.aiImageModel, provider: cfg.aiProvider, source: "wechat", prompt: mediaPrompt }),
                  }));
                  const storeData = await storeResp.json() as { id?: string };
                  const broadcastUrl = storeData.id ? `/api/image/${storeData.id}` : dataUrl;
                  this.broadcastToWebSockets({ type: "media_generated", mediaType: "image", url: broadcastUrl, model: cfg.aiImageModel, provider: cfg.aiProvider, source: "wechat" });
                }
              } else {
                await sendTextMessage(useCreds!, from, ctxToken, `❌ 图片生成失败 (${modelInfo})\n请稍后重试或换个描述试试`);
                await this.logGeneration("image", mediaPrompt, "", cfg.aiProvider, cfg.aiImageModel, "failed", "生成结果为空", "wechat", from);
              }
              stopTypingKeepAlive();
            }
          } catch (genErr: any) {
            Logger.error("[DO] Media generation error", { error: genErr?.message });
            await sendTextMessage(useCreds!, from, ctxToken, `生成失败: ${genErr?.message || "未知错误"}`);
            stopTypingKeepAlive();
          }

          replyAt = new Date().toISOString();
          aiSuccessCount++;
          await this.markMessageProcessed(messageId);

          const pendingMsg = { messageId, fromUserId: from, content: text, timestamp: createdAt, replyContent, replyAt, processed: true };
          this.state.pendingMessages.push(pendingMsg);
          if (this.websockets.size > 0) this.broadcastToWebSockets({ type: "message", data: pendingMsg });
          return;
        }

        // 调用 AI 生成回复（使用 D1 存储上下文）
        const reply = await callAIWithContext(
          this.doState.storage.sql,
          this.env.AI,
          from,
          text,
          systemPrompt,
          { provider: cfg.aiProvider, model: aiModel, baseUrl: cfg.aiBaseUrl, apiKey: cfg.aiApiKey, maxTokens: cfg.aiMaxTokens, maxContextChars: cfg.aiMaxContextChars, mcpServers: cfg.mcpServers, db: this.env.DB },
          this.env.DB
        );

        // 发送回复（自动分段）+ AI 信息
        const aiInfo = `🤖 ${cfg.aiProvider} · ${aiModel}`;
        const fullReply = `${reply}\n\n— ${aiInfo}`;
        await sendTextChunked(useCreds!, from, ctxToken, fullReply);
        replyContent = reply;
        await this.logGeneration("text", text, (reply || "").slice(0, 500), cfg.aiProvider, aiModel, "success", undefined, "wechat", from);
        replyAt = new Date().toISOString();
        aiSuccessCount++;
        await this.markMessageProcessed(messageId);

        // 取消 typing 状态
        sendTypingStatus(useCreds!, from, ctxToken, false).catch(() => {});

        Logger.info("[DO] Message processed", { from, replyLength: reply.length, chunks });
      } catch (e: any) {
        aiFailCount++;
        Logger.error("[DO] AI processing failed", { error: e.message, from });
        // AI 失败时通过 MCP 推送工具（如 BeeSwarm）发送告警
        try {
          const { sendAlert } = await import("../services/mcp");
          sendAlert(this.env.DB, "🤖 AI 调用失败", `用户: ${from}\n错误: ${e.message?.slice(0, 200) || "未知错误"}`).catch(() => {});
        } catch {}
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
      if (this.env.DB) {
        const { results } = await this.env.DB.prepare(`SELECT 1 as found FROM processed_messages WHERE message_id = ? LIMIT 1`).bind(messageId).all();
        return results.length > 0;
      }
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
      if (this.env.DB) {
        await this.env.DB.prepare(`INSERT OR IGNORE INTO processed_messages (message_id, created_at) VALUES (?, ?)`).bind(messageId, Date.now()).run();
      } else {
        this.doState.storage.sql.exec(
          `INSERT OR IGNORE INTO processed_messages (message_id, created_at) VALUES (?, ?)`,
          messageId, Date.now()
        );
      }
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
