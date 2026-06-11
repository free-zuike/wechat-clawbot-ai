// ======================================================================
//  ClawBot AI 主入口 —— Cloudflare Worker（优化版）
// ----------------------------------------------------------------------
//  路由:
//    GET  /                       管理面板（登录后）
//    GET  /login                  登录页面（扫码登录）
//    GET  /api/qrcode             申请二维码
//    GET  /api/qrcode-status      轮询扫码状态
//    POST /api/trigger-poll       手动触发一次消息拉取
//    GET  /api/status             运行状态
//    POST /api/logout             退出登录 (删除凭证)
//    POST /api/chat               直接调用 AI (JSON API)
//    GET  /healthz                健康检查
//
//  定时:
//    scheduled event (cron)      每分钟触发一次消息拉取
//
//  优化要点 (v1.1):
//    - 对话上下文存 Cache API (替代 KV)，零额度消耗
//    - 长轮询游标 buf 不再保存；每次都从空字符串开始
//    - 新增关键词快捷回复表（零 Token 消耗）
//    - AI 回复在 Cache API 里做 12h 缓存
//    - bot_token 仍然存在 KV（全生命周期只写 1 次）
// ======================================================================

import * as ilink from "./ilink";
import {
  tryHandleCommand,
  turnAndSave,
  clearContext,
  setAiResultListener,
  bindR2,
  writeHistory,
} from "./ai-service";

// ---------- KV key 常量 ----------
const KV_CRED = "clawbot:credentials";

export interface Env {
  AI: any;
  CLAWBOT_KV: KVNamespace;
  CLAWBOT_DB?: D1Database;                        // 可选：统计数据库
  CLAWBOT_QUEUE?: Queue;                          // 可选：异步消费消息
  CLAWBOT_R2?: R2Bucket;                          // 可选：长期对话历史
  ADMIN_PASSWORD?: string;                        // 可选：管理页密码
  TURNSTILE_SITE_KEY?: string;                    // 可选：Turnstile 公钥
  TURNSTILE_SECRET_KEY?: string;                  // 可选：Turnstile 私钥
  AI_SYSTEM_PROMPT?: string;                      // 可选：自定义 AI 提示词
  AI_MODEL?: string;                              // 可选：AI 模型
}

export interface LoginCredentials {
  token: string;
  accountId: string;
  userId: string;
  baseUrl: string;
  createdAt: number;
}

// ---------- 通用工具 ----------
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getCredentials(env: Env): Promise<LoginCredentials | null> {
  try {
    const raw = await env.CLAWBOT_KV.get(KV_CRED);
    if (!raw) return null;
    return JSON.parse(raw) as LoginCredentials;
  } catch {
    return null;
  }
}

async function saveCredentials(env: Env, creds: LoginCredentials) {
  await env.CLAWBOT_KV.put(KV_CRED, JSON.stringify(creds));
}

async function deleteCredentials(env: Env) {
  await env.CLAWBOT_KV.delete(KV_CRED);
}

// ---------- 管理访问控制（必需） ----------
// 管理密码保护敏感接口；若未配置 ADMIN_PASSWORD 则提示先设置
function hasAdminPassword(env: Env): boolean {
  return !!(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length > 3);
}

// 验证管理员密码
function verifyAdmin(request: Request, env: Env): { ok: boolean; error?: string } {
  if (!hasAdminPassword(env)) {
    return { ok: false, error: "请先配置 ADMIN_PASSWORD（wrangler secret put ADMIN_PASSWORD）" };
  }
  const authHeader = request.headers.get("Authorization") || "";
  const m = authHeader.match(/^Basic\s+(.+)$/i);
  let headerOk = false;
  if (m) {
    try {
      const decoded = atob(m[1]);
      const colon = decoded.indexOf(":");
      const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      headerOk = pass === env.ADMIN_PASSWORD;
    } catch {}
  }
  const queryPwd = new URL(request.url).searchParams.get("pwd") || "";
  if (headerOk || queryPwd === env.ADMIN_PASSWORD) {
    return { ok: true };
  }
  return { ok: false, error: "管理员密码不正确" };
}

// Turnstile 验证（可选，仅在配置 TURNSTILE_SECRET_KEY 后生效）
async function verifyTurnstile(token: string | null, env: Env, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const data = (await r.json()) as { success: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

// 消息去重 —— 用 Cache API 代替 KV，零写额度
function seenCacheKey(msgId: string): string {
  return `https://clawbot.local/seen/${encodeURIComponent(msgId)}`;
}

async function markMessageSeen(msgId: string): Promise<boolean> {
  try {
    const cache = (caches as any).default as Cache;
    const req = new Request(seenCacheKey(msgId));
    const existing = await cache.match(req);
    if (existing) return true;
    const resp = new Response("1", {
      headers: { "Cache-Control": "public, max-age=7200" },
    });
    cache.put(req, resp).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

// ---------- 配置存储（KV） ----------
const KV_CONFIG = "clawbot:config";

interface BotConfig {
  aiModel?: string;
  aiSystemPrompt?: string;
  turnstileSiteKey?: string;
}

async function saveConfig(env: Env, config: BotConfig): Promise<void> {
  await env.CLAWBOT_KV.put(KV_CONFIG, JSON.stringify(config));
}

async function loadConfig(env: Env): Promise<BotConfig> {
  try {
    const raw = await env.CLAWBOT_KV.get(KV_CONFIG);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function mergeConfig(env: Env, kvConfig: BotConfig): BotConfig {
  return {
    aiModel: env.AI_MODEL || kvConfig.aiModel,
    aiSystemPrompt: env.AI_SYSTEM_PROMPT || kvConfig.aiSystemPrompt,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || kvConfig.turnstileSiteKey,
  };
}

// ---------- R2 历史查询辅助 ----------
async function listR2History(env: Env, userId: string, limit = 20): Promise<Array<{ key: string; content: string }>> {
  if (!env.CLAWBOT_R2) return [];
  try {
    const prefix = `history/${userId}/`;
    const listed = await env.CLAWBOT_R2.list({ prefix, limit } as any);
    const objects = listed.objects || [];
    const result: Array<{ key: string; content: string }> = [];
    for (const obj of objects) {
      try {
        const body = await env.CLAWBOT_R2.get(obj.key);
        if (body) {
          const text = await body.text();
          result.push({ key: obj.key, content: text.slice(0, 500) });
        }
      } catch {}
    }
    return result;
  } catch {
    return [];
  }
}

// ---------- 轻量统计 + 错误环形日志 ----------
interface LogEntry { t: number; ok: boolean; msg?: string; }
const MAX_LOG = 20;
const recentErrors: LogEntry[] = [];

const stats = {
  polls: 0,
  handled: 0,
  shortcuts: 0,
  aiCalls: 0,
  aiFails: 0,
  consecutiveFails: 0,
  cacheHits: 0,
  lastPollAt: 0,
  lastLatencyMs: 0,
  alertedAt: 0,
};

setAiResultListener((ok, info) => {
  if (ok) {
    stats.aiCalls++;
    stats.consecutiveFails = 0;
  } else {
    stats.aiCalls++;
    stats.aiFails++;
    stats.consecutiveFails++;
    recentErrors.unshift({ t: Date.now(), ok: false, msg: info?.slice(0, 200) });
    if (recentErrors.length > MAX_LOG) recentErrors.pop();
  }
});

function logNonAiError(msg: string) {
  recentErrors.unshift({ t: Date.now(), ok: false, msg: msg.slice(0, 200) });
  if (recentErrors.length > MAX_LOG) recentErrors.pop();
}

function getStatsSnapshot() {
  return {
    polls: stats.polls,
    handled: stats.handled,
    shortcuts: stats.shortcuts,
    aiCalls: stats.aiCalls,
    aiFails: stats.aiFails,
    consecutiveFails: stats.consecutiveFails,
    lastPollAt: stats.lastPollAt,
    lastLatencyMs: stats.lastLatencyMs,
    recentErrors: recentErrors.slice(0, 10),
  };
}

// ---------- D1 聚合写 ----------
async function writeHourlyStats(env: Env) {
  if (!env.CLAWBOT_DB) return;
  try {
    const hourUnix = Math.floor(Date.now() / 3_600_000) * 3_600;
    await env.CLAWBOT_DB
      .prepare(
        `INSERT INTO stats_hourly (hour_unix, polls, handled, shortcuts, ai_calls, ai_fails, max_consecutive_fails, created_at)
         VALUES (?, 1, 0, 0, 0, 0, 0, ?)
         ON CONFLICT (hour_unix) DO UPDATE SET
           polls = polls + 1,
           handled = handled + 0,
           shortcuts = shortcuts + 0,
           ai_calls = ai_calls + 0,
           ai_fails = ai_fails + 0,
           max_consecutive_fails = CASE WHEN max_consecutive_fails < excluded.max_consecutive_fails THEN excluded.max_consecutive_fails ELSE max_consecutive_fails END`
      )
      .bind(hourUnix, Math.floor(Date.now() / 1000))
      .run();

    if (recentErrors.length > 0) {
      const batch = recentErrors.splice(0, 5);
      if (batch.length > 0) {
        for (const e of batch) {
          await env.CLAWBOT_DB
            .prepare(`INSERT INTO errors (ts, kind, message) VALUES (?, ?, ?)`)
            .bind(
              Math.floor(e.t / 1000),
              e.ok ? "ok" : "error",
              (e.msg || "").slice(0, 500)
            )
            .run();
        }
        await env.CLAWBOT_DB
          .prepare(
            `DELETE FROM errors WHERE id IN (
               SELECT id FROM errors ORDER BY id DESC LIMIT 1000000 OFFSET 200
             )`
          )
          .run()
          .catch(() => {});
      }
    }
  } catch (e) {
    console.error("[d1] write error", e);
  }
}

async function readHourlyStats(env: Env, hours: number) {
  if (!env.CLAWBOT_DB) return [];
  try {
    const sinceHour = Math.floor((Date.now() - hours * 3_600_000) / 3_600_000) * 3_600;
    const r = await env.CLAWBOT_DB
      .prepare(
        `SELECT hour_unix, polls, handled, shortcuts, ai_calls, ai_fails, max_consecutive_fails
         FROM stats_hourly WHERE hour_unix >= ? ORDER BY hour_unix DESC LIMIT ?`
      )
      .bind(sinceHour, Math.min(hours + 1, 24 * 7 + 1))
      .all();
    return r.results || [];
  } catch {
    return [];
  }
}

// ======================================================================
//  核心：拉取 + 处理 + 回复
// ======================================================================
async function pollAndReply(env: Env): Promise<{
  pulled: number;
  handled: number;
  queued: number;
  error?: string;
  latencyMs: number;
}> {
  const start = Date.now();
  const creds = await getCredentials(env);
  if (!creds) return { pulled: 0, handled: 0, queued: 0, error: "未登录", latencyMs: 0 };

  const kvConfig = await loadConfig(env);
  const config = mergeConfig(env, kvConfig);

  const res = await ilink.getUpdates(
    creds.token,
    "",
    creds.baseUrl,
    4000
  );

  stats.polls++;
  stats.lastPollAt = Date.now();

  if (res.ret !== 0) {
    logNonAiError(`getUpdates ret=${res.ret}${res.errcode ? " errcode=" + res.errcode : ""}`);
    return {
      pulled: 0,
      handled: 0,
      queued: 0,
      error: `ret=${res.ret}${res.errcode ? ",errcode=" + res.errcode : ""}`,
      latencyMs: Date.now() - start,
    };
  }

  const msgs = res.msgs || [];
  msgs.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));

  let handled = 0;
  let queued = 0;

  if (env.CLAWBOT_QUEUE) {
    const jobs: MessageSendRequest<any>[] = [];
    for (const msg of msgs) {
      const text = ilink.extractText(msg);
      if (!text) continue;
      jobs.push({
        body: {
          msg_id: msg.msg_id,
          from_user_id: msg.from_user_id,
          context_token: msg.context_token,
          create_time: msg.create_time,
          text,
          baseUrl: creds.baseUrl,
          token: creds.token,
        },
      });
    }
    if (jobs.length > 0) {
      try {
        for (let i = 0; i < jobs.length; i += 100) {
          await env.CLAWBOT_QUEUE.sendBatch(jobs.slice(i, i + 100));
        }
        queued = jobs.length;
      } catch (e) {
        console.error("[queue] sendBatch error", e);
      }
    }
  }

  if (!env.CLAWBOT_QUEUE || queued === 0) {
    const handledBy = new Set<string>();
    for (const msg of msgs) {
      const from = msg.from_user_id;
      const ctxToken = msg.context_token;
      const text = ilink.extractText(msg);
      if (!text) continue;

      const seenKey = msg.msg_id || `${msg.create_time}:${from}`;
      if (await markMessageSeen(seenKey)) continue;

      if (handledBy.has(from)) await new Promise((r) => setTimeout(r, 220));

      const cmd = tryHandleCommand(text);
      if (cmd.handled) {
        if (cmd.reset) await clearContext(from);
        await ilink.replyText(creds.token, from, ctxToken, cmd.reply || "ok", creds.baseUrl);
        stats.shortcuts++;
        stats.handled++;
        handledBy.add(from);
        handled++;
        continue;
      }

      ilink.sendTyping(creds.token, from, true, creds.baseUrl).catch(() => {});
      const reply = await turnAndSave(env.AI, from, text, config.aiSystemPrompt, config.aiModel);
      await ilink.replyText(creds.token, from, ctxToken, reply, creds.baseUrl);
      stats.aiCalls++;
      stats.handled++;
      handledBy.add(from);
      handled++;
    }
  }

  const now = Date.now();
  if (
    stats.consecutiveFails >= 3 &&
    now - stats.alertedAt > 10 * 60 * 1000
  ) {
    const alertText =
      `⚠️ 爪爪自告警\nAI 连续失败 ${stats.consecutiveFails} 次，` +
      `最近错误：${(recentErrors[0]?.msg || "").slice(0, 80)}\n` +
      `时间：${new Date(now).toLocaleString()}\n` +
      `（本条为机器人自监控消息，10 分钟内不会重复）`;
    try {
      ilink
        .replyText(creds.token, creds.userId, "", alertText, creds.baseUrl)
        .catch(() => {});
      stats.alertedAt = now;
    } catch {
      // ignore
    }
  }

  writeHourlyStats(env).catch(() => {});

  return {
    pulled: msgs.length,
    handled,
    queued,
    latencyMs: (() => { const ms = Date.now() - start; stats.lastLatencyMs = ms; return ms; })(),
  };
}

// ======================================================================
//  fetch 主路由
// ======================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    bindR2(env.CLAWBOT_R2);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const clientIP =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "unknown";

    if (path === "/healthz")
      return json({ ok: true, time: new Date().toISOString() });

    // ---------- 需要管理员密码的接口 ----------

    if (path === "/api/qrcode" && method === "GET") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      try {
        const { key, imgUrl } = await ilink.getQRCode();
        await env.CLAWBOT_KV.put("clawbot:qrcode_key", key, {
          expirationTtl: 5 * 60,
        });
        return json({ qrcode: key, qrcode_img_content: imgUrl });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/qrcode-status" && method === "GET") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      try {
        const key =
          (await env.CLAWBOT_KV.get("clawbot:qrcode_key")) ||
          url.searchParams.get("qrcode") ||
          "";
        if (!key) return json({ status: "unknown" });
        const s = await ilink.getQRCodeStatus(key);
        if (s.status === "confirmed" && s.bot_token) {
          const creds: LoginCredentials = {
            token: s.bot_token,
            accountId: s.ilink_bot_id || "",
            userId: s.ilink_user_id || "",
            baseUrl: s.baseurl || ilink.I_LINK_BASE,
            createdAt: Date.now(),
          };
          await saveCredentials(env, creds);
          await env.CLAWBOT_KV.delete("clawbot:qrcode_key");
          return json({ status: "confirmed", ok: true });
        }
        return json({ status: s.status, detail: s });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/trigger-poll" && method === "POST") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      if (env.TURNSTILE_SECRET_KEY) {
        const tsToken = request.headers.get("X-Turnstile-Token") ||
          url.searchParams.get("turnstile") || "";
        if (!await verifyTurnstile(tsToken, env, clientIP)) {
          return json({ error: "Turnstile 验证失败" }, 403);
        }
      }
      const result = await pollAndReply(env);
      return json(result);
    }

    if (path === "/api/status") {
      const creds = await getCredentials(env);
      const config = await loadConfig(env);
      const merged = mergeConfig(env, config);
      return json({
        loggedIn: !!creds,
        accountId: creds?.accountId || "",
        userIdMasked: creds?.userId ? creds.userId.slice(0, 6) + "***" : "",
        baseUrl: creds?.baseUrl || "",
        loginAt: creds?.createdAt ? new Date(creds.createdAt).toISOString() : "",
        hasAi: !!env.AI,
        hasKv: !!env.CLAWBOT_KV,
        hasDb: !!env.CLAWBOT_DB,
        hasQueue: !!env.CLAWBOT_QUEUE,
        hasR2: !!env.CLAWBOT_R2,
        hasAdminPwd: hasAdminPassword(env),
        version: "v1.5-cloudflare-suite",
        stats: getStatsSnapshot(),
        config: merged,
      });
    }

    if (path === "/api/config" && method === "GET") {
      const config = await loadConfig(env);
      return json(mergeConfig(env, config));
    }

    if (path === "/api/config" && method === "POST") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      try {
        const body = (await request.json()) as Partial<BotConfig>;
        const current = await loadConfig(env);
        const updated: BotConfig = {
          ...current,
          aiModel: body.aiModel || undefined,
          aiSystemPrompt: body.aiSystemPrompt || undefined,
          turnstileSiteKey: body.turnstileSiteKey || undefined,
        };
        await saveConfig(env, updated);
        return json({ ok: true, config: mergeConfig(env, updated) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/history" && method === "GET") {
      const hours = Math.min(
        24 * 7,
        Math.max(24, parseInt(url.searchParams.get("hours") || "24", 10))
      );
      const data = await readHourlyStats(env, hours);
      return json({ hours, data });
    }

    if (path === "/api/r2-history" && method === "GET") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      const userId = url.searchParams.get("user") || "all";
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));
      if (!env.CLAWBOT_R2) return json({ error: "未配置 R2" }, 400);
      try {
        const prefix = userId === "all" ? "history/" : `history/${userId}/`;
        const listed = await env.CLAWBOT_R2.list({ prefix, limit } as any);
        const items: Array<{ key: string; ts: number; content: string }> = [];
        for (const obj of listed.objects || []) {
          try {
            const body = await env.CLAWBOT_R2.get(obj.key);
            if (body) items.push({ key: obj.key, ts: obj.uploaded.getTime(), content: (await body.text()).slice(0, 500) });
          } catch {}
        }
        return json({ prefix, count: items.length, items });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/logout" && method === "POST") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      await deleteCredentials(env);
      return json({ ok: true });
    }

    if (path === "/api/chat" && method === "POST") {
      try {
        const body = (await request.json()) as { message: string; userId?: string };
        const message = body?.message;
        if (!message) return json({ error: "missing message" }, 400);

        const kvConfig = await loadConfig(env);
        const config = mergeConfig(env, kvConfig);

        const cmd = tryHandleCommand(message);
        if (cmd.handled) {
          const uid = body.userId || "web_user";
          writeHistory(uid, "user", message).catch(() => {});
          writeHistory(uid, "assistant", cmd.reply || "", { source: "shortcut" }).catch(() => {});
          return json({ reply: cmd.reply || "", source: "shortcut" });
        }

        const uid = body.userId || "web_user";
        const reply = await turnAndSave(env.AI, uid, message, config.aiSystemPrompt, config.aiModel);
        return json({ reply, source: "ai" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- 登录页面（优先）----------
    if (path === "/login") return html(LOGIN_PAGE(env, hasAdminPassword(env)));

    // ---------- 管理面板（登录后）----------
    if (path === "/" || path === "") {
      const creds = await getCredentials(env);
      if (!creds) {
        return Response.redirect(new URL("/login", request.url), 302);
      }
      return html(HOME_PAGE(env, hasAdminPassword(env)));
    }

    return json({ error: "Not Found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await pollAndReply(env);
    } catch (e) {
      console.error("[cron] error:", e);
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const handledBy = new Set<string>();
    const kvConfig = await loadConfig(env);
    const config = mergeConfig(env, kvConfig);

    for (const m of batch.messages) {
      try {
        const body = (m.body || {}) as {
          msg_id?: string;
          from_user_id: string;
          context_token: string;
          create_time?: number;
          text: string;
          baseUrl: string;
          token: string;
        };
        const from = body.from_user_id;
        const text = body.text || "";

        const seenKey = body.msg_id || `${body.create_time || Date.now()}:${from}`;
        if (await markMessageSeen(seenKey)) {
          m.ack();
          continue;
        }
        if (handledBy.has(from)) {
          await new Promise((r) => setTimeout(r, 220));
        }

        const cmd = tryHandleCommand(text);
        if (cmd.handled) {
          if (cmd.reset) await clearContext(from);
          await ilink.replyText(body.token, from, body.context_token, cmd.reply || "ok", body.baseUrl);
          stats.shortcuts++;
          stats.handled++;
          handledBy.add(from);
          m.ack();
          continue;
        }

        ilink.sendTyping(body.token, from, true, body.baseUrl).catch(() => {});
        const reply = await turnAndSave(env.AI, from, text, config.aiSystemPrompt, config.aiModel);
        await ilink.replyText(body.token, from, body.context_token, reply, body.baseUrl);
        stats.aiCalls++;
        stats.handled++;
        handledBy.add(from);
        m.ack();
      } catch (e) {
        console.error("[queue] error", e);
        m.retry();
      }
    }

    writeHourlyStats(env).catch(() => {});
  },
};

// ======================================================================
//  HTML 页面
// ======================================================================

// ---------- 登录页面 ----------
function LOGIN_PAGE(env: Env, hasAdmin: boolean): string {
  const pwdNotice = hasAdmin
    ? ""
    : `<div class="notice">🔐 请先设置管理员密码后重新部署：<br/><code>wrangler secret put ADMIN_PASSWORD</code><br/><code>wrangler deploy</code></div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>扫码登录 · ClawBot AI</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5,#f0f7ff);min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:22px;padding:36px 28px;box-shadow:0 8px 28px rgba(0,0,0,.08);text-align:center;max-width:420px;width:90%}
  h1{color:#ff4d8d;margin:0 0 8px;font-size:24px}
  .sub{color:#666;font-size:14px;margin-bottom:20px}
  .notice{background:#fff8e1;border:1px solid #ffd54f;border-radius:12px;padding:12px;font-size:13px;color:#665c00;margin-bottom:12px;text-align:left}
  .qr{border:1px dashed #ffb6c8;border-radius:16px;padding:22px;margin:16px 0;min-height:220px;display:flex;align-items:center;justify-content:center;background:#fffafc}
  .qr img{max-width:220px;max-height:220px}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:12px 32px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
  .btn.secondary{background:#f3f3f7;color:#555}
  .input{width:100%;border:1px solid #eee;border-radius:10px;padding:12px 16px;font-size:14px;box-sizing:border-box}
  .badge{display:inline-block;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600}
  .badge.ok{background:#e8f8ee;color:#147a3e}
  .badge.wait{background:#fff8e1;color:#856404}
</style>
</head>
<body>
<div class="card">
  <h1>🦞 ClawBot AI</h1>
  <div class="sub">微信机器人管理面板</div>
  ${pwdNotice}
  ${hasAdmin ? `
  <input id="pwd" class="input" placeholder="管理员密码" type="password"/>
  <button class="btn" style="width:100%;margin-top:16px" onclick="startLogin()">获取二维码</button>
  <div id="qr-area" class="qr" style="display:none">
    <div style="color:#999">加载中...</div>
  </div>
  <div id="status" style="margin-top:12px"></div>
  <button class="btn secondary" style="width:100%;margin-top:16px;display:none" id="retry-btn" onclick="startLogin()">重新获取二维码</button>
  ` : ''}
</div>
<script>
function getPwd(){ return document.getElementById('pwd')?.value.trim() || ''; }
function urlWithPwd(base){
  const pwd = getPwd();
  return base + (pwd ? '?pwd=' + encodeURIComponent(pwd) : '');
}
let pollTimer = null;
async function startLogin(){
  const pwd = getPwd();
  if(!pwd){ alert('请输入管理员密码'); return; }
  document.querySelector('.btn')?.style.display = 'none';
  document.getElementById('qr-area').style.display = 'flex';
  document.getElementById('qr-area').innerHTML = '<div style="color:#999">获取二维码中...</div>';
  try {
    const r = await fetch(urlWithPwd('/api/qrcode'), {cache:'no-store'});
    const d = await r.json();
    if(d.error){ alert(d.error); location.reload(); return; }
    document.getElementById('qr-area').innerHTML = '<img src="data:image/png;base64,' + d.qrcode_img_content + '" alt="QR Code"/>';
    document.getElementById('status').innerHTML = '<span class="badge wait">等待扫码...</span>';
    document.getElementById('retry-btn').style.display = 'block';
    pollStatus(d.qrcode);
  } catch(e){ alert('获取失败: ' + e.message); }
}
async function pollStatus(qrcode){
  if(pollTimer) clearTimeout(pollTimer);
  try {
    const r = await fetch(urlWithPwd('/api/qrcode-status?qrcode=' + encodeURIComponent(qrcode)), {cache:'no-store'});
    const d = await r.json();
    if(d.status === 'confirmed' && d.ok){
      document.getElementById('status').innerHTML = '<span class="badge ok">登录成功！正在跳转...</span>';
      setTimeout(() => location.href = '/', 1000);
      return;
    }
    if(d.status === 'expired'){
      document.getElementById('status').innerHTML = '<span style="color:#c00">二维码已过期，请刷新重试</span>';
      return;
    }
    if(d.status === 'scaned'){
      document.getElementById('status').innerHTML = '<span class="badge ok">已扫码，请在手机上确认</span>';
    }
    pollTimer = setTimeout(() => pollStatus(qrcode), 1500);
  } catch(e){}
}
</script>
</body>
</html>`;
}

// ---------- 管理面板（侧边导航布局）----------
function HOME_PAGE(env: Env, hasAdmin: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>🦞 ClawBot AI · 管理面板</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;background:#f5f7fa;min-height:100vh;color:#222}
  .sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:linear-gradient(180deg,#ff6b9d 0%,#ff8c5a 100%);color:#fff;padding:24px;overflow-y:auto}
  .sidebar h1{margin:0;font-size:18px;font-weight:600}
  .sidebar .sub{color:rgba(255,255,255,.7);font-size:12px;margin:4px 0 20px}
  .sidebar nav{display:flex;flex-direction:column;gap:6px}
  .sidebar nav a{color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-size:14px;transition:all .2s}
  .sidebar nav a:hover,.sidebar nav a.active{background:rgba(255,255,255,.2)}
  .sidebar .status{margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,.2)}
  .sidebar .status .badge{background:rgba(255,255,255,.2);color:#fff;border:none}
  .main{margin-left:220px;min-height:100vh;padding:24px}
  .wrap{max-width:900px;margin:0 auto}
  .card{background:#fff;border-radius:16px;padding:24px;margin-bottom:18px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
  h2{font-size:18px;margin:0 0 16px;color:#222}
  .sub{color:#666;font-size:14px;margin-bottom:12px}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
  .btn.secondary{background:#f3f3f7;color:#555}
  .btn.danger{background:linear-gradient(135deg,#ff6b6b,#ee5a6f)}
  .input{flex:1;border:1px solid #eee;border-radius:10px;padding:10px 16px;font-size:14px;min-width:200px}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px}
  .kv b{color:#555}
  pre.code{background:#1e2230;color:#f5f5f5;padding:14px;border-radius:12px;overflow-x:auto;font-size:12px;line-height:1.6}
  .chat-box{height:320px;overflow-y:auto;padding:12px;background:#fafbff;border-radius:14px;border:1px solid #eee}
  .msg{margin:8px 0}
  .msg .bubble{padding:10px 14px;border-radius:14px;max-width:80%;line-height:1.5;font-size:14px}
  .msg.u{text-align:right}.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;display:inline-block;text-align:left}
  .msg.b .bubble{background:#fff;border:1px solid #eee;display:inline-block}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:#e8f8ee;color:#147a3e}
  .badge.bad{background:#fde6e6;color:#a33}
  .badge.wait{background:#fff8e1;color:#856404}
  .notice{background:#fff8e1;border:1px solid #ffd54f;border-radius:12px;padding:12px;font-size:13px;color:#665c00;margin-bottom:12px}
  .section{display:none}
  .section.active{display:block}
  @media(max-width:768px){.sidebar{position:relative;width:auto;bottom:auto}.main{margin-left:0}}
</style>
</head>
<body>
<div class="sidebar">
  <h1>🦞 ClawBot AI</h1>
  <div class="sub">v1.5 Cloudflare Suite</div>
  <nav>
    <a href="#" onclick="showSection('status')" class="active">📊 状态监控</a>
    <a href="#" onclick="showSection('control')">🎮 控制中心</a>
    <a href="#" onclick="showSection('config')">⚙️ 系统设置</a>
    <a href="#" onclick="showSection('chat')">🤖 AI 测试</a>
    <a href="#" onclick="showSection('deploy')">📦 部署命令</a>
  </nav>
  <div class="status">
    <div style="font-size:12px;color:rgba(255,255,255,.7);margin-bottom:8px">系统状态</div>
    <span class="badge ok">✓ 已登录</span>
    <span class="badge ok">✓ Worker AI</span>
    <span class="badge ${!!env.CLAWBOT_KV ? 'ok' : 'bad'}">${!!env.CLAWBOT_KV ? '✓' : '✗'} KV</span>
    <span class="badge ${!!env.CLAWBOT_DB ? 'ok' : 'bad'}">${!!env.CLAWBOT_DB ? '✓' : '✗'} D1</span>
    <span class="badge ${!!env.CLAWBOT_R2 ? 'ok' : 'bad'}">${!!env.CLAWBOT_R2 ? '✓' : '✗'} R2</span>
    <div style="margin-top:12px">
      <button class="btn" style="width:100%;background:rgba(255,255,255,.2);margin-top:8px" onclick="logout()">退出登录</button>
    </div>
  </div>
</div>
<div class="main">
  <div class="wrap">

    <div id="status" class="section active">
      <div class="card">
        <h2>📊 实时状态</h2>
        <div id="live-stats" class="kv">
          <b>登录状态</b><span>加载中...</span>
          <b>轮询次数</b><span>—</span>
          <b>累计处理</b><span>—</span>
          <b>AI 调用</b><span>—</span>
          <b>AI 失败</b><span>—</span>
          <b>连续失败</b><span>—</span>
          <b>上次轮询</b><span>—</span>
          <b>上次耗时</b><span>—</span>
        </div>
        <h3 style="font-size:14px;color:#666;margin:16px 0 8px">📈 过去 24 小时统计</h3>
        <div id="history-24h" class="sub" style="white-space:pre-wrap">加载中...</div>
        <h3 style="font-size:14px;color:#666;margin:16px 0 8px">🚨 最近错误</h3>
        <div id="recent-errors" class="sub" style="white-space:pre-wrap">暂无</div>
      </div>
    </div>

    <div id="control" class="section">
      <div class="card">
        <h2>🎮 控制中心</h2>
        <div class="sub">手动触发消息拉取和查看历史记录</div>
        ${hasAdmin ? `
        <input id="control-pwd" class="input" placeholder="管理员密码" style="max-width:220px"/>
        ` : '<div class="notice">🔐 请先设置管理员密码</div>'}
        <div class="row">
          <button class="btn" onclick="triggerPoll()">🔄 手动触发轮询</button>
          <button class="btn secondary" onclick="loadR2History()">📋 查看 R2 历史</button>
        </div>
        <div id="poll-result" class="sub" style="margin-top:12px"></div>
        <div style="margin-top:14px">
          <label style="font-size:13px;color:#555">查询用户</label>
          <input id="r2-user" class="input" placeholder="用户 ID（留空查询全部）" style="margin-top:6px"/>
        </div>
        <div id="r2-history" class="sub" style="white-space:pre-wrap;margin-top:12px;max-height:300px;overflow-y:auto"></div>
      </div>
    </div>

    <div id="config" class="section">
      <div class="card">
        <h2>⚙️ 系统设置</h2>
        <div class="sub">配置 AI 模型、人设提示词等参数（配置保存在 KV 中）</div>
        ${hasAdmin ? `
        <input id="config-pwd" class="input" placeholder="管理员密码" style="margin-bottom:16px"/>
        <div style="margin-bottom:14px">
          <label style="font-size:13px;color:#555">AI 模型</label>
          <input id="config-model" class="input" placeholder="@cf/meta/llama-3-8b-instruct" style="margin-top:6px" />
          <small style="color:#888;font-size:12px">可选: @cf/meta/llama-3-8b-instruct, @cf/mistral/mistral-7b-instruct-v0.1</small>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:13px;color:#555">AI 人设提示词</label>
          <textarea id="config-prompt" class="input" rows="4" placeholder="你是爪爪，一个友好的 AI 助手..." style="border-radius:12px;margin-top:6px;resize:vertical"></textarea>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:13px;color:#555">Turnstile Site Key（可选）</label>
          <input id="config-turnstile" class="input" placeholder="你的 Turnstile Site Key" style="margin-top:6px" />
        </div>
        <div class="row">
          <button class="btn" onclick="loadConfig()">加载配置</button>
          <button class="btn" onclick="saveConfig()">保存配置</button>
        </div>
        <div id="config-result" class="sub" style="margin-top:12px"></div>
        ` : '<div class="notice">🔐 请先设置管理员密码以使用设置功能</div>'}
      </div>
    </div>

    <div id="chat" class="section">
      <div class="card">
        <h2>🤖 AI 测试聊天</h2>
        <div class="sub">直接测试 AI 回复效果</div>
        <div class="chat-box" id="chat-box">
          <div class="msg b"><div class="bubble">你好！我是爪爪 AI。<br/>💡 常见问题走本地快捷回复表，零 Token 消耗。<br/>相同问题 12 小时内走 Cache 缓存。</div></div>
        </div>
        <div class="row" style="margin-top:12px">
          <input id="chat-input" class="input" placeholder="输入消息..." />
          <button class="btn" onclick="sendChat()">发送</button>
        </div>
      </div>
    </div>

    <div id="deploy" class="section">
      <div class="card">
        <h2>📦 部署命令</h2>
        <div class="sub">常用的 Cloudflare 部署命令</div>
        <pre class="code"># 安装依赖
npm install

# 创建 KV Namespace（必需）
wrangler kv namespace create CLAWBOT_KV

# 创建 D1 数据库（可选）
wrangler d1 create clawbot-stats
wrangler d1 execute clawbot-stats --file=./schema.sql

# 创建 R2 Bucket（可选）
wrangler r2 bucket create clawbot-history

# 创建 Queue（可选）
wrangler queues create clawbot-messages

# 设置环境变量
wrangler secret put ADMIN_PASSWORD

# 部署
wrangler deploy</pre>
      </div>
      <div class="card">
        <h2>💬 微信指令</h2>
        <div class="kv">
          <b>帮助 / help</b><span>返回使用指南（不调用 AI）</span>
          <b>关于 / about</b><span>机器人版本信息（不调用 AI）</span>
          <b>重置 / clear</b><span>清空该用户对话上下文（不调用 AI）</span>
          <b>你好 / 时间 / 谢谢 …</b><span>本地快捷回复表，零 Token</span>
          <b>其他文字</b><span>走 Worker AI，回复写入 Cache 12h</span>
        </div>
      </div>
    </div>

  </div>
</div>
<script>
function showSection(id){
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  event.preventDefault();
  event.target?.classList.add('active');
}
function getPwd(id){ const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function urlWithPwd(base, field){
  const pwd = getPwd(field);
  if(!pwd) return base;
  return base + (base.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(pwd);
}
async function refreshStats(){
  try {
    const [sRes, h24Res] = await Promise.all([
      fetch('/api/status',{cache:'no-store'}),
      fetch('/api/history?hours=24',{cache:'no-store'}).catch(()=>null),
    ]);
    const d = await sRes.json();
    const s = d.stats || {};
    const el = document.getElementById('live-stats');
    const errs = document.getElementById('recent-errors');
    if (el) {
      const fmt = (v)=> v == null ? '—' : v;
      const last = s.lastPollAt ? new Date(s.lastPollAt).toLocaleString() : '从未';
      const latency = s.lastLatencyMs == null ? '—' : s.lastLatencyMs + ' ms';
      const consecBadge = (s.consecutiveFails || 0) === 0 ? '✅ 0' : '🔥 ' + s.consecutiveFails;
      el.innerHTML =
        '<b>登录状态</b><span>' + (d.loggedIn ? '✅' : '❌') + '</span>' +
        '<b>轮询次数</b><span>' + fmt(s.polls) + '</span>' +
        '<b>累计处理</b><span>' + fmt(s.handled) + '</span>' +
        '<b>AI 调用</b><span>' + fmt(s.aiCalls) + '</span>' +
        '<b>AI 失败</b><span>' + fmt(s.aiFails) + '</span>' +
        '<b>连续失败</b><span>' + consecBadge + '</span>' +
        '<b>上次轮询</b><span>' + last + '</span>' +
        '<b>上次耗时</b><span>' + latency + '</span>';
    }
    if (errs) {
      const list = (s.recentErrors || []).slice(0, 10);
      if (!list.length) errs.textContent = '✅ 最近无错误';
      else errs.innerHTML = list.map(e => new Date(e.t).toLocaleString() + ' —— ' + (e.msg || '(无消息)')).join('\n');
    }
    if(h24Res){
      const h24 = await h24Res.json();
      const rows = (h24.data || []).slice(0, 24);
      const historyEl = document.getElementById('history-24h');
      if(historyEl){
        if(!rows.length){ historyEl.textContent = '(暂无数据, cron 运行后会累积)'; return; }
        const maxP = Math.max(1, ...rows.map(r => r.polls || 0));
        const lines = rows.map(r => {
          const t = new Date(r.hour_unix * 1000).toLocaleString();
          const bar = '█'.repeat(Math.max(1, Math.round(((r.polls || 0) / maxP) * 15)));
          return t + '  轮询 ' + r.polls + '  回复 ' + r.handled + '  AI ' + r.ai_calls + '  ' + bar;
        });
        historyEl.textContent = lines.join('\n');
      }
    }
  } catch(e){}
}
async function triggerPoll(){
  const el = document.getElementById('poll-result');
  el.textContent = '调用中...';
  try {
    const url = urlWithPwd('/api/trigger-poll', 'control-pwd');
    const r = await fetch(url, {method:'POST'});
    const d = await r.json();
    el.innerHTML = '结果: <pre style="background:#fafbff;padding:10px;border-radius:8px;overflow:auto">' + JSON.stringify(d,null,2) + '</pre>';
    refreshStats();
  } catch(e){ el.textContent = '错误：' + e.message; }
}
async function loadR2History(){
  const el = document.getElementById('r2-history');
  el.textContent = '查询中...';
  try {
    const user = document.getElementById('r2-user')?.value.trim() || '';
    let base = '/api/r2-history?limit=30';
    if(user) base += '&user=' + encodeURIComponent(user);
    const url = urlWithPwd(base, 'control-pwd');
    const r = await fetch(url, {cache:'no-store'});
    const d = await r.json();
    if(d.error){ el.textContent = '❌ ' + d.error; return; }
    const items = d.items || [];
    if(!items.length){ el.textContent = '(无数据)'; return; }
    el.textContent = items.slice(0,30).map(it => {
      let content; try { content = JSON.parse(it.content); } catch { content = it.content; }
      const role = typeof content === 'object' ? (content.role || '?') : 'raw';
      const text = typeof content === 'object' ? (content.content || '') : content;
      return new Date(it.ts).toLocaleString() + '  [' + role + '] ' + String(text).slice(0,120);
    }).join('\n');
  } catch(e){ el.textContent = '错误：' + e.message; }
}
async function logout(){
  if(!confirm('确认退出登录？')) return;
  const url = urlWithPwd('/api/logout', 'control-pwd');
  await fetch(url, {method:'POST'});
  location.href = '/login';
}
async function loadConfig(){
  const el = document.getElementById('config-result');
  el.textContent = '加载中...';
  try {
    const r = await fetch('/api/config', {cache:'no-store'});
    const d = await r.json();
    document.getElementById('config-model').value = d.aiModel || '';
    document.getElementById('config-prompt').value = d.aiSystemPrompt || '';
    document.getElementById('config-turnstile').value = d.turnstileSiteKey || '';
    el.textContent = '✅ 配置加载成功';
  } catch(e){ el.textContent = '❌ 加载失败：' + e.message; }
}
async function saveConfig(){
  const el = document.getElementById('config-result');
  el.textContent = '保存中...';
  try {
    const pwd = getPwd('config-pwd');
    const model = document.getElementById('config-model')?.value.trim() || '';
    const prompt = document.getElementById('config-prompt')?.value.trim() || '';
    const turnstile = document.getElementById('config-turnstile')?.value.trim() || '';
    const url = '/api/config' + (pwd ? '?pwd=' + encodeURIComponent(pwd) : '');
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ aiModel: model, aiSystemPrompt: prompt, turnstileSiteKey: turnstile })
    });
    const d = await r.json();
    if(d.ok){
      el.innerHTML = '✅ 配置保存成功！<br/>AI 模型: ' + (d.config?.aiModel || '(默认)') + '<br/>提示词: ' + (d.config?.aiSystemPrompt?.length || 0) + ' 字符';
    } else {
      el.textContent = '❌ ' + (d.error || '保存失败');
    }
  } catch(e){ el.textContent = '❌ 保存失败：' + e.message; }
}
const chatBox = document.getElementById('chat-box');
function addMsg(role,text){
  const d = document.createElement('div'); d.className='msg '+role;
  const b = document.createElement('div'); b.className='bubble'; b.textContent=text;
  d.appendChild(b); chatBox.appendChild(d); chatBox.scrollTop = chatBox.scrollHeight;
}
document.getElementById('chat-input')?.addEventListener('keydown',e=>{ if(e.key==='Enter') sendChat(); });
async function sendChat(){
  const inp = document.getElementById('chat-input');
  const q = inp ? inp.value.trim() : ''; if(!q) return;
  addMsg('u',q); inp.value='';
  try {
    const r = await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:q,userId:'web_user'})});
    const d = await r.json();
    addMsg('b',(d.reply||'') + (d.source==='shortcut' ? ' [快捷回复]' : ''));
  } catch(e){ addMsg('b','错误：'+e.message); }
}
refreshStats();
setInterval(refreshStats, 30000);
</script>
</body>
</html>`;
}