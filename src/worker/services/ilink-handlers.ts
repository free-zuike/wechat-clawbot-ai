// iLink Durable Object - 路由处理器
// 从 ilink-do.ts 中抽取的独立 handler 函数
// 通过 DOContext 获取所需的 DO 状态引用

import { Logger } from "../utils/error";
import { generateSessionToken } from "../utils";
import { getUpdates, sendTextMessage, sendTextChunked, sendTypingStatus, extractMessageText, getQRCodeStatus, sendImageMessage, sendVideoMessage, sendImageSimple, uploadAndSendMedia, MessageType, MessageItemType, downloadImageFromCdn } from "./ilink";
import type { ILinkCredentials, WeixinMessage } from "../types";

// ========== DO 上下文接口 ==========

export interface DOContext {
  env: any;
  doState: DurableObjectState;
  websockets: Set<WebSocket>;
  accounts: Map<string, { creds: ILinkCredentials; syncBuf: string; consecutiveErrors: number; lastPollAt: string; pollLoopRunning: boolean }>;
  ilinkCreds: ILinkCredentials | null;
  state: { syncBuf: string; lastPollAt: string; consecutiveErrors: number; isRunning: boolean; pendingMessages: any[] };
  cache: { credentials: any; credentialsLoadedAt: number; config: any; configLoadedAt: number };
  runtimeStats: { polls: number; handled: number; aiCalls: number; aiFails: number; lastLatencyMs: number };
  kv: KVNamespace | null;
  sqliteInitialized: boolean;

  broadcastToWebSockets(data: Record<string, unknown>): void;
  logGeneration(type: string, prompt: string, result: string, provider: string, model: string, status: string, error?: string, source?: string, fromUser?: string, keyIndex?: number, providerName?: string): Promise<void>;
  getConfigCached(): Promise<any>;
  initSQLite(): Promise<void>;
  saveAccounts(): Promise<void>;
  triggerImmediatePoll(): void;
  detectImageMime(data: Uint8Array): string;
}

// ========== 工具函数 ==========

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

// ========== 处理器 ==========

export async function handleLongPoll(ctx: DOContext): Promise<Response> {
  if (!ctx.ilinkCreds) {
    return jsonResponse({ success: true, pulled: 0, handled: 0, skipped: 0, error: "未登录", latencyMs: 0 });
  }
  const anyRunning = Array.from(ctx.accounts.values()).some(a => a.pollLoopRunning);
  if (!anyRunning) ctx.triggerImmediatePoll();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (ctx.state.pendingMessages.length > 0) {
      const msg = ctx.state.pendingMessages.shift()!;
      return jsonResponse({ success: true, pulled: 1, handled: 1, skipped: 0, message: msg, latencyMs: Date.now() - deadline + 5000 });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return jsonResponse({ success: true, pulled: 0, handled: 0, skipped: 0, latencyMs: 5000 });
}

export function handleWebSocket(ctx: DOContext, request: Request): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  ctx.websockets.add(server);
  server.accept();
  server.addEventListener("close", () => ctx.websockets.delete(server));
  server.addEventListener("error", () => ctx.websockets.delete(server));
  server.send(JSON.stringify({ type: "connected", message: "实时消息连接已建立" }));
  return new Response(null, { status: 101, webSocket: client });
}

export async function handleSaveSession(ctx: DOContext, request: Request): Promise<Response> {
  try {
    const body = await request.json() as { token?: string };
    if (!body.token) return jsonResponse({ error: "缺少 token" }, 400);
    await ctx.doState.storage.put(`session:${body.token}`, JSON.stringify({ valid: true, createdAt: Date.now() }));
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleCheckSession(ctx: DOContext, url: URL): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return jsonResponse({ valid: false });
  const sessionRaw = await ctx.doState.storage.get<string>(`session:${token}`);
  if (!sessionRaw) return jsonResponse({ valid: false });
  try {
    const session = JSON.parse(sessionRaw);
    if (Date.now() - (session.createdAt || 0) > 24 * 60 * 60 * 1000) {
      await ctx.doState.storage.delete(`session:${token}`);
      return jsonResponse({ valid: false });
    }
    return jsonResponse({ valid: true, created_at: session.createdAt || 0, age_ms: Date.now() - (session.createdAt || 0) });
  } catch {
    return jsonResponse({ valid: false });
  }
}

export async function handleSaveCreds(ctx: DOContext, request: Request): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { botToken, accountId, userId, baseUrl, syncBuf } = body;
    if (!botToken || !accountId) return jsonResponse({ error: "缺少凭证" }, 400);
    const creds: ILinkCredentials = { botToken, accountId, baseUrl: baseUrl || "https://ilinkai.weixin.qq.com", userId: userId || "" };
    ctx.accounts.set(accountId, { creds, syncBuf: syncBuf || "", consecutiveErrors: 0, lastPollAt: "", pollLoopRunning: false });
    (ctx as any).ilinkCreds = creds;
    await ctx.saveAccounts();
    const sessionToken = generateSessionToken();
    try {
      await sendTextMessage(creds, userId, syncBuf || "", `👋 欢迎使用爪爪 AI 助手！\n\n📝 可用命令：\n• /图片 <描述> - 生成图片\n• /image <描述> - 生成图片\n• /视频 <描述> - 生成视频\n• /video <描述> - 生成视频\n• /reset - 重置对话\n\n💡 示例：\n/图片 赛博朋克城市\n/video 10秒 海浪拍岸\n\n🎨 以图生图（仅 Agnes Image 2.1 Flash）：\n先发一张图片，60秒内发送 /图片 <描述> 即可基于图片生成`);
    } catch {}
    return jsonResponse({ ok: true, sessionToken, accountId, totalAccounts: ctx.accounts.size });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleClearCreds(ctx: DOContext, request?: Request): Promise<Response> {
  try {
    let targetAccountId: string | null = null;
    if (request) {
      try { const body = await request.json() as any; targetAccountId = body.accountId || null; } catch {}
    }
    if (targetAccountId) {
      ctx.accounts.delete(targetAccountId);
    } else {
      ctx.accounts.clear();
      (ctx as any).ilinkCreds = null;
    }
    const first = ctx.accounts.values().next().value;
    (ctx as any).ilinkCreds = first ? first.creds : null;
    await ctx.saveAccounts();
    return jsonResponse({ ok: true, remaining: ctx.accounts.size });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleQRPoll(ctx: DOContext, url: URL): Promise<Response> {
  const qrcodeKey = url.searchParams.get("qrcode");
  if (!qrcodeKey) return jsonResponse({ error: "缺少 qrcode 参数" }, 400);
  for (let i = 0; i < 30; i++) {
    try {
      const status = await getQRCodeStatus(qrcodeKey);
      if (status.status === "confirmed" && status.bot_token && status.ilink_bot_id) {
        const creds = { botToken: status.bot_token, accountId: status.ilink_bot_id, userId: status.ilink_user_id, baseUrl: status.baseurl || "https://ilinkai.weixin.qq.com", syncBuf: "", rawLoginResponse: status.raw, createdAt: Date.now() };
        try { await ctx.kv!.put("credentials", JSON.stringify(creds)); } catch {}
        const sessionToken = generateSessionToken();
        try { await ctx.kv!.put(`clawbot:session:${sessionToken}`, "valid", { expirationTtl: 24 * 60 * 60 }); } catch {}
        return new Response(JSON.stringify({ status: "confirmed", ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `clawbot_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${24 * 60 * 60}` } });
      }
      if (status.status === "expired") return jsonResponse({ status: "expired" });
      await new Promise((r) => setTimeout(r, 3000));
    } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
  return jsonResponse({ status: "timeout" });
}

export async function handleSend(ctx: DOContext, request: Request): Promise<Response> {
  if (!ctx.ilinkCreds) return jsonResponse({ error: "未登录" }, 401);
  try {
    const body = await request.json() as any;
    if (!body.toUserId || !body.text) return jsonResponse({ error: "缺少参数" }, 400);
    await sendTextMessage(ctx.ilinkCreds, body.toUserId, body.contextToken || "", body.text);
    ctx.triggerImmediatePoll();
    return jsonResponse({ success: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleSendVideo(ctx: DOContext, request: Request): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { videoUrl, toUserId, contextToken, model, provider } = body;
    if (!videoUrl || !toUserId) return jsonResponse({ error: "缺少参数" }, 400);
    const accountId = body.accountId;
    let creds = ctx.ilinkCreds;
    if (accountId && ctx.accounts.has(accountId)) creds = ctx.accounts.get(accountId)!.creds;
    if (!creds) return jsonResponse({ error: "未登录" }, 401);
    const videoCfg = await ctx.getConfigCached();
    const videoProviderName = ((videoCfg as any).aiCustomProviders || []).find((p: any) => p.id === provider)?.name || provider || "unknown";
    const modelInfo = `🤖 ${videoProviderName} · ${model || "unknown"}`;
    try { await sendVideoMessage(creds, toUserId, contextToken, videoUrl); } catch { await sendTextMessage(creds, toUserId, contextToken, `🎬 ${modelInfo}\n\n视频已生成：\n${videoUrl}`); }
    ctx.broadcastToWebSockets({ type: "media_generated", mediaType: "video", url: videoUrl, model, provider, prompt: body.prompt || "" });
    return jsonResponse({ success: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleBroadcastImage(ctx: DOContext, request: Request): Promise<Response> {
  try {
    const body = await request.json() as any;
    if (body.error) {
      ctx.broadcastToWebSockets({ type: "media_error", message: body.message, model: body.model, provider: body.provider, source: body.source, prompt: body.prompt });
      // 如果有微信来源信息，发送错误给用户
      if (body.toUserId && body.contextToken && body.accountId) {
        const account = ctx.accounts.get(body.accountId);
        if (account) {
          sendTextMessage(account.creds, body.toUserId, body.contextToken, `❌ ${body.message}\n请稍后重试`).catch(() => {});
        }
      }
      return jsonResponse({ success: true });
    }
    ctx.broadcastToWebSockets({ type: "media_generated", mediaType: body.mediaType || "image", url: body.imageData, model: body.model, provider: body.provider, source: body.source, prompt: body.prompt });
    return jsonResponse({ success: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleStoreImage(ctx: DOContext, request: Request): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { id, data } = body;
    if (!id || !data) return jsonResponse({ error: "缺少参数" }, 400);
    const base64 = typeof data === "string" ? data : data.base64 || "";
    if (!base64) return jsonResponse({ error: "缺少图片数据" }, 400);
    await ctx.doState.storage.put(`image:${id}`, base64);
    Logger.info("[DO] Image stored", { id, size: base64.length });
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleGetImage(ctx: DOContext, url: URL): Promise<Response> {
  const imageId = url.pathname.replace("/get-image/", "");
  if (!imageId) return jsonResponse({ error: "缺少图片 ID" }, 400);
  try {
    const base64 = await ctx.doState.storage.get<string>(`image:${imageId}`);
    if (!base64) return jsonResponse({ error: "图片不存在" }, 404);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const mime = ctx.detectImageMime(bytes);
    return new Response(bytes, { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" } });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleStorePendingVideo(ctx: DOContext, request: Request): Promise<Response> {
  try {
    await ctx.initSQLite();
    const body = await request.json() as any;
    if (!ctx.env?.DB) return jsonResponse({ error: "D1 not configured" }, 500);
    if (body.status && body.taskId && !body.prompt) {
      if (body.videoUrl) {
        await ctx.env.DB.prepare(`UPDATE pending_videos SET status = ?, video_url = ? WHERE task_id = ?`).bind(body.status, body.videoUrl, body.taskId).run();
      } else {
        await ctx.env.DB.prepare(`UPDATE pending_videos SET status = ? WHERE task_id = ?`).bind(body.status, body.taskId).run();
      }
    } else {
      await ctx.env.DB.prepare(
        `INSERT OR REPLACE INTO pending_videos (task_id, video_id, prompt, model, provider, base_url, api_key, status, to_user_id, context_token, account_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
      ).bind(body.taskId, body.videoId || null, body.prompt || "", body.model || "", body.provider || "", body.baseUrl || "", body.apiKey || "", body.toUserId || null, body.contextToken || null, body.accountId || null, body.source || null, Date.now()).run();
    }
    return jsonResponse({ success: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handlePendingVideos(ctx: DOContext, request: Request): Promise<Response> {
  await ctx.initSQLite();
  const url = new URL(request.url);
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (!ctx.env?.DB) return new Response(JSON.stringify({ ok: false, error: "D1 not configured" }), { headers: corsHeaders, status: 500 });
  if (request.method === "DELETE") {
    const taskId = url.searchParams.get("task_id");
    if (taskId) { await ctx.env.DB.prepare(`DELETE FROM pending_videos WHERE task_id = ?`).bind(taskId).run(); } else if (url.searchParams.get("failed") === "true") { await ctx.env.DB.exec(`DELETE FROM pending_videos WHERE status = 'failed'`); }
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }
  const statusFilter = url.searchParams.get("status");
  const stmt = statusFilter
    ? ctx.env.DB.prepare(`SELECT task_id, prompt, model, provider, status, video_url, video_id, to_user_id, source, created_at, error_message, retry_count FROM pending_videos WHERE status = ? ORDER BY created_at DESC LIMIT 100`).bind(statusFilter)
    : ctx.env.DB.prepare(`SELECT task_id, prompt, model, provider, status, video_url, video_id, to_user_id, source, created_at, error_message, retry_count FROM pending_videos ORDER BY created_at DESC LIMIT 100`);
  const { results } = await stmt.all();
  return new Response(JSON.stringify({ ok: true, tasks: results, total: results.length }), { headers: corsHeaders });
}

export async function handleLogGeneration(ctx: DOContext, request: Request): Promise<Response> {
  try {
    await ctx.initSQLite();
    const url = new URL(request.url);
    let type: string, prompt: string, result: string, provider: string, model: string, status: string, error: string, source: string, fromUser: string;
    if (request.method === "GET" || url.searchParams.has("t")) {
      type = url.searchParams.get("t") || "unknown"; prompt = url.searchParams.get("p") || ""; result = url.searchParams.get("r") || "";
      provider = url.searchParams.get("pv") || ""; model = url.searchParams.get("m") || ""; status = url.searchParams.get("s") || "success";
      error = url.searchParams.get("e") || ""; source = url.searchParams.get("src") || ""; fromUser = url.searchParams.get("fu") || "";
    } else {
      const body = await request.json() as any;
      type = body.type || "unknown"; prompt = body.prompt || ""; result = body.result || "";
      provider = body.provider || ""; model = body.model || ""; status = body.status || "success";
      error = body.error || ""; source = body.source || ""; fromUser = body.fromUser || "";
    }
    let providerName = "";
    try { const cfg = await ctx.getConfigCached(); const found = ((cfg as any).aiCustomProviders || []).find((p: any) => p.id === provider); if (found) providerName = found.name || ""; } catch {}
    if (ctx.env?.DB) {
      await ctx.env.DB.prepare(
        `INSERT INTO generation_logs (type, prompt, result, provider, model, status, error, source, from_user, created_at, key_index, provider_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(type, prompt.slice(0, 500), result.slice(0, 1000), provider, model, status, error, source, fromUser, Date.now(), 0, providerName).run();
    }
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e?.message }, 500);
  }
}

export async function handleGenerationLogs(ctx: DOContext, request: Request): Promise<Response> {
  await ctx.initSQLite();
  const url = new URL(request.url);
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (!ctx.env?.DB) return new Response(JSON.stringify({ ok: false, error: "D1 not configured" }), { headers: corsHeaders, status: 500 });
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id"); const deleteAll = url.searchParams.get("all") === "true";
    if (id) { await ctx.env.DB.prepare(`DELETE FROM generation_logs WHERE id = ?`).bind(parseInt(id)).run(); } else if (deleteAll) { await ctx.env.DB.exec(`DELETE FROM generation_logs`); }
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }
  const typeFilter = url.searchParams.get("type"); const limit = parseInt(url.searchParams.get("limit") || "50");
  const stmt = typeFilter
    ? ctx.env.DB.prepare(`SELECT id, type, prompt, result, provider, model, status, error, source, from_user, created_at, key_index, provider_name FROM generation_logs WHERE type = ? ORDER BY created_at DESC LIMIT ?`).bind(typeFilter, limit)
    : ctx.env.DB.prepare(`SELECT id, type, prompt, result, provider, model, status, error, source, from_user, created_at, key_index, provider_name FROM generation_logs ORDER BY created_at DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all();
  return new Response(JSON.stringify({ ok: true, logs: results, total: results.length }), { headers: corsHeaders });
}

export async function handleGetCreds(ctx: DOContext): Promise<Response> {
  let credsRaw: string | null = null;
  try {
    credsRaw = await ctx.doState.storage.get<string>("credentials");
  } catch (_e) {}
  if (!credsRaw && ctx.ilinkCreds) {
    credsRaw = JSON.stringify(ctx.ilinkCreds);
  }
  if (!credsRaw) return jsonResponse({ error: "未登录" });
  return jsonResponse({ creds: credsRaw });
}

export async function handleStatus(ctx: DOContext): Promise<Response> {
  const accountsList = Array.from(ctx.accounts.entries()).map(([id, a]) => ({
    accountId: id,
    baseUrl: a.creds.baseUrl,
    userId: a.creds.userId,
    lastPollAt: a.lastPollAt,
    consecutiveErrors: a.consecutiveErrors,
    pollLoopRunning: a.pollLoopRunning,
  }));

  // 兼容：如果没有 accounts 但有 ilinkCreds，构造一个
  if (accountsList.length === 0 && ctx.ilinkCreds) {
    accountsList.push({
      accountId: ctx.ilinkCreds.accountId,
      baseUrl: ctx.ilinkCreds.baseUrl,
      userId: ctx.ilinkCreds.userId || "",
      lastPollAt: ctx.state.lastPollAt,
      consecutiveErrors: ctx.state.consecutiveErrors,
      pollLoopRunning: false,
    });
  }

  // 兜底：如果还是空，尝试直接从 DO storage 读旧格式
  if (accountsList.length === 0) {
    try {
      const oldCreds = await ctx.doState.storage.get<string>("credentials");
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

  return jsonResponse({
    success: true,
    isRunning: Array.from(ctx.accounts.values()).some(a => a.pollLoopRunning),
    lastPollAt: ctx.state.lastPollAt,
    consecutiveErrors: ctx.state.consecutiveErrors,
    pendingMessages: ctx.state.pendingMessages.length,
    hasCredentials: !!ctx.ilinkCreds || ctx.accounts.size > 0,
    accountId: ctx.ilinkCreds?.accountId,
    needsReLogin: !ctx.ilinkCreds && ctx.accounts.size === 0,
    stats: ctx.runtimeStats,
    accounts: accountsList,
    totalAccounts: ctx.accounts.size,
  });
}

export async function handleSQLiteContexts(ctx: DOContext): Promise<Response> {
  try {
    const sql = ctx.doState.storage.sql;
    const result = sql.exec("SELECT user_id, last_updated, messages FROM contexts ORDER BY last_updated DESC LIMIT 50");
    const rows = result?.toArray ? result.toArray() : [];
    const contexts = rows.map((r: any) => ({ userId: r.user_id, lastUpdated: r.last_updated, messageCount: JSON.parse(r.messages || "[]").length }));
    return jsonResponse({ ok: true, contexts, total: contexts.length });
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function handleFlush(ctx: DOContext): Promise<Response> {
  ctx.state.pendingMessages = [];
  ctx.state.syncBuf = "";
  return jsonResponse({ ok: true });
}