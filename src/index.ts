// ======================================================================
//  ClawBot AI 主入口 —— Cloudflare Worker（优化版）
// ----------------------------------------------------------------------
//  路由:
//    GET  /                       管理面板
//    GET  /login                  扫码登录
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
  // 必须配置密码
  if (!hasAdminPassword(env)) {
    return { ok: false, error: "请先配置 ADMIN_PASSWORD（wrangler secret put ADMIN_PASSWORD）" };
  }
  // 检查 Authorization 头
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
  // 检查 URL 参数
  const queryPwd = new URL(request.url).searchParams.get("pwd") || "";
  if (headerOk || queryPwd === env.ADMIN_PASSWORD) {
    return { ok: true };
  }
  return { ok: false, error: "管理员密码不正确" };
}

// Turnstile 验证（可选，仅在配置 TURNSTILE_SECRET_KEY 后生效）
async function verifyTurnstile(token: string | null, env: Env, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true; // 没配就放行
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
// 2 小时 TTL 足够，因为 cron 每 2 分钟拉一次，消息不会被反复推很久
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
    return false; // 任何异常都放过，避免丢消息
  }
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

// ---------- 轻量统计 + 错误环形日志（纯内存，冷启动清零）----------
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
  alertedAt: 0, // 上次发告警的时间戳，节流用
};

// ---------- 注册 AI 监听器：成功/失败都会回调 ----------
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

// 非 AI 失败（比如网络/ilink 拉取失败）也记一条
function logNonAiError(msg: string) {
  recentErrors.unshift({ t: Date.now(), ok: false, msg: msg.slice(0, 200) });
  if (recentErrors.length > MAX_LOG) recentErrors.pop();
}

// 给 stats 一个只读导出（主要给管理面板用）
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

// ---------- D1 聚合写（每小时 1 条，省 D1 写额度）
// 关键点:
//   - 同一 hour_unix 做 upsert：INSERT…ON CONFLICT DO UPDATE SET … = … + 1
//   - 所有占位符数量必须与 .bind(...) 参数数量一致
//   - recentErrors 入队一次就清空，避免重复写
async function writeHourlyStats(env: Env) {
  if (!env.CLAWBOT_DB) return;
  try {
    const hourUnix = Math.floor(Date.now() / 3_600_000) * 3_600;

    // 1) 小时统计 upsert（polls +1，其它字段走上下文增量）
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

    // 2) 最近错误批量入 D1（仅在有新错误时写，每次最多 5 条）
    if (recentErrors.length > 0) {
      const batch = recentErrors.splice(0, 5); // 取走前 5 条，避免下一轮重复写
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
        // 保留最近 200 条，超量清理（LIMIT -1 在部分库不兼容，改用正数值并倒序删除）
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

// D1 查询：最近 N 小时聚合
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

  // ---------- 分支 1：配置了 Queue → 入队异步消费（强推荐）----------
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
        // Cloudflare Queue: sendBatch 一次最多 100 条
        for (let i = 0; i < jobs.length; i += 100) {
          await env.CLAWBOT_QUEUE.sendBatch(jobs.slice(i, i + 100));
        }
        queued = jobs.length;
      } catch (e) {
        console.error("[queue] sendBatch error", e);
        // Queue 失败则回退到同步处理，避免丢消息
      }
    }
  }

  // ---------- 分支 2：没配 Queue → 同步处理（旧行为）----------
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
      const reply = await turnAndSave(env.AI, from, text, env.AI_SYSTEM_PROMPT, env.AI_MODEL);
      await ilink.replyText(creds.token, from, ctxToken, reply, creds.baseUrl);
      stats.aiCalls++;
      stats.handled++;
      handledBy.add(from);
      handled++;
    }
  }

  // ---------- 连续失败告警（节流 10 分钟）----------
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

  // ---------- 可选：D1 落盘（只有配置了 CLAWBOT_DB 才写, 1 小时 upsert 1 条, 省写额度）
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
    // 启动时注入 R2 (在 Worker 首次请求时做一次即可, 多次调用也幂等)
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
    // 扫码登录、手动触发、历史查询等全部需要正确的 ADMIN_PASSWORD

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

    // ---------- 手动触发一次消息拉取 (需要管理员) ----------
    if (path === "/api/trigger-poll" && method === "POST") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      // 可选: Turnstile 机器人检查
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

    // ---------- 状态 ----------
    if (path === "/api/status") {
      const creds = await getCredentials(env);
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
      });
    }

    // ---------- 历史统计 ----------
    if (path === "/api/history" && method === "GET") {
      const hours = Math.min(
        24 * 7,
        Math.max(24, parseInt(url.searchParams.get("hours") || "24", 10))
      );
      const data = await readHourlyStats(env, hours);
      return json({ hours, data });
    }

    // ---------- R2 长期对话历史查询 (需要管理员) ----------
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

    // ---------- 退出登录 ----------
    if (path === "/api/logout" && method === "POST") {
      const v = verifyAdmin(request, env);
      if (!v.ok) return json({ error: v.error || "无权访问" }, 401);
      await deleteCredentials(env);
      return json({ ok: true });
    }

    // ---------- JSON 对话 API ----------
    if (path === "/api/chat" && method === "POST") {
      try {
        const body = (await request.json()) as { message: string; userId?: string };
        const message = body?.message;
        if (!message) return json({ error: "missing message" }, 400);

        // 先试关键词
        const cmd = tryHandleCommand(message);
        if (cmd.handled) {
          const uid = body.userId || "web_user";
          writeHistory(uid, "user", message).catch(() => {});
          writeHistory(uid, "assistant", cmd.reply || "", { source: "shortcut" }).catch(() => {});
          return json({ reply: cmd.reply || "", source: "shortcut" });
        }

        const uid = body.userId || "web_user";
        const reply = await turnAndSave(env.AI, uid, message, env.AI_SYSTEM_PROMPT, env.AI_MODEL);
        return json({ reply, source: "ai" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- 扫码登录页（含管理员密码输入框）----------
    if (path === "/login") return html(LOGIN_PAGE(env, hasAdminPassword(env)));

    // ---------- 管理面板 ----------
    if (path === "/" || path === "") {
      const creds = await getCredentials(env);
      return html(HOME_PAGE(env, !!creds, hasAdminPassword(env)));
    }

    return json({ error: "Not Found" }, 404);
  },

  // 定时触发 —— cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await pollAndReply(env);
    } catch (e) {
      console.error("[cron] error:", e);
    }
  },

  // Queue 消费者：逐条处理入队消息
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const handledBy = new Set<string>();
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
        const reply = await turnAndSave(env.AI, from, text, env.AI_SYSTEM_PROMPT, env.AI_MODEL);
        await ilink.replyText(body.token, from, body.context_token, reply, body.baseUrl);
        stats.aiCalls++;
        stats.handled++;
        handledBy.add(from);
        m.ack();
      } catch (e) {
        console.error("[queue] error", e);
        // 失败则 retry（Cloudflare Queue 自动重试至多 3 次后入死信）
        m.retry();
      }
    }

    // 每批消费完后也写一次 D1 统计
    writeHourlyStats(env).catch(() => {});
  },
};

// ======================================================================
//  HTML 页面
// ======================================================================
function HOME_PAGE(env: Env, loggedIn: boolean, hasAdmin: boolean): string {
  const statusBadge = (ok: boolean, text: string) =>
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${text}</span>`;

  const turnstileScript = env.TURNSTILE_SITE_KEY
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";
  const turnstileWidget = env.TURNSTILE_SITE_KEY
    ? `<div class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}"></div>`
    : "";

  const needPwdNotice = hasAdmin
    ? ""
    : `<div class="notice" style="margin-top:12px">🔐 管理功能需要先设置管理员密码。<br/>执行：<code>wrangler secret put ADMIN_PASSWORD</code> 然后 <code>wrangler deploy</code></div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>🦞 爪爪 ClawBot AI · Cloudflare Suite</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5 0%,#f0f7ff 50%,#f5efff 100%);min-height:100vh;color:#222}
  .wrap{max-width:880px;margin:0 auto;padding:32px 20px 80px}
  .card{background:#fff;border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 8px 28px rgba(0,0,0,.06)}
  h1{margin:0 0 4px;font-size:28px;color:#ff4d8d}
  .sub{color:#666;font-size:14px;margin-bottom:12px}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
  .btn.secondary{background:#f3f3f7;color:#555}
  .btn.danger{background:linear-gradient(135deg,#ff6b6b,#ee5a6f)}
  .input{flex:1;border:1px solid #eee;border-radius:999px;padding:10px 18px;font-size:14px}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:13px}
  .kv b{color:#555}
  pre.code{background:#1e2230;color:#f5f5f5;padding:14px;border-radius:12px;overflow-x:auto;font-size:12px;line-height:1.6}
  .chat-box{height:320px;overflow-y:auto;padding:12px;background:#fafbff;border-radius:14px;border:1px solid #eee}
  .msg{margin:8px 0}
  .msg .bubble{padding:10px 14px;border-radius:14px;max-width:80%;line-height:1.5;font-size:14px}
  .msg.u{text-align:right}.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;display:inline-block;text-align:left}
  .msg.b .bubble{background:#fff;border:1px solid #eee;display:inline-block}
  h2{font-size:18px;margin:0 0 8px;color:#ff4d8d}
  h3{font-size:14px;margin:14px 0 4px;color:#ff4d8d}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:#e8f8ee;color:#147a3e}
  .badge.bad{background:#fde6e6;color:#a33}
  .notice{background:#fff8e1;border:1px solid #ffd54f;border-radius:12px;padding:12px;font-size:13px;color:#665c00;margin-bottom:12px}
</style>
</head>
<body>
${turnstileScript}
<div class="wrap">
  <div class="card">
    <h1>🦞 爪爪 ClawBot AI · v1.5 Cloudflare Suite</h1>
    <div class="sub">Workers + Worker AI + D1 + Queues + R2 + Turnstile · 全 Cloudflare 套件</div>
    <div class="row">
      ${statusBadge(loggedIn, "已登录微信")}
      ${statusBadge(true, "Worker AI")}
      ${statusBadge(!!env.CLAWBOT_KV, "KV 凭证")}
      ${statusBadge(!!env.CLAWBOT_DB, "D1 统计")}
      ${statusBadge(!!env.CLAWBOT_QUEUE, "Queues 异步")}
      ${statusBadge(!!env.CLAWBOT_R2, "R2 历史")}
      ${statusBadge(!!env.TURNSTILE_SECRET_KEY, "Turnstile")}
    </div>
    ${hasAdmin ? `<div class="notice" style="margin-top:12px">🔐 管理功能受密码保护，请把 <code>?pwd=你的密码</code> 加到 URL 后，或在下方输入密码后使用管理功能。</div>` : ""}
  </div>

  <div class="card">
    <h2>📊 实时状态</h2>
    <div id="live-stats" class="kv">
      <b>登录状态</b><span>—</span>
      <b>轮询次数</b><span>—</span>
      <b>处理消息</b><span>—</span>
      <b>AI 调用</b><span>—</span>
      <b>AI 失败</b><span>—</span>
      <b>连续失败</b><span>—</span>
      <b>上次轮询</b><span>—</span>
      <b>上次耗时</b><span>—</span>
    </div>
    <h3>📈 过去 24 小时统计</h3>
    <div id="history-24h" class="sub" style="white-space:pre-wrap">加载中...</div>
    <h3>📆 过去 7 天统计</h3>
    <div id="history-7d" class="sub" style="white-space:pre-wrap">加载中...</div>
    <h3>🚨 最近错误</h3>
    <div id="recent-errors" class="sub" style="white-space:pre-wrap">暂无</div>
  </div>

  <div class="card">
    <h2>📱 1. 扫码登录微信</h2>
    <div class="sub">在微信 → 设置 → 插件 → ClawBot 里扫描二维码。</div>
    <div class="row">
      ${hasAdmin ? `<input id="login-pwd" class="input" placeholder="管理员密码（可选）" style="max-width:220px"/>` : ""}
      <button class="btn" onclick="goLogin()">去扫码登录</button>
      ${loggedIn ? `<button class="btn danger" onclick="logout()">退出登录</button>` : ""}
    </div>
  </div>

  <div class="card">
    <h2>📡 2. 拉取 &amp; 回复消息</h2>
    <div class="kv">
      <b>调度器</b><span>cron 每 2 分钟自动触发</span>
      <b>长轮询时间</b><span>每次 ~4s</span>
      <b>去重策略</b><span>msg_id → Cache API，零写额度</span>
      <b>异步处理</b><span>${env.CLAWBOT_QUEUE ? "配置了 Queue：拉取后异步消费，防止 cron 超时" : "同步处理（未配置 Queue）"}</span>
    </div>
    ${turnstileWidget ? `<div style="margin-top:12px">${turnstileWidget}</div>` : ""}
    <div class="row" style="align-items:center">
      ${hasAdmin ? `<input id="poll-pwd" class="input" placeholder="管理员密码" style="max-width:220px"/>` : ""}
      <button class="btn" onclick="triggerPoll()">手动触发一次拉取</button>
    </div>
    <div id="poll-result" class="sub" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>📜 3. R2 长期对话历史 ${env.CLAWBOT_R2 ? "" : "(未配置)"}</h2>
    <div class="sub">查询用户对话历史（仅管理员可用，按用户/时间倒序列出）。</div>
    <div class="row" style="align-items:center">
      ${hasAdmin ? `<input id="r2-pwd" class="input" placeholder="管理员密码" style="max-width:180px"/>` : ""}
      <input id="r2-user" class="input" placeholder="用户 ID（留空=全部）" style="max-width:220px"/>
      <button class="btn" onclick="queryR2()">查询</button>
    </div>
    <div id="r2-result" class="sub" style="white-space:pre-wrap;margin-top:12px">点击按钮查询</div>
  </div>

  <div class="card">
    <h2>🤖 4. 直接测试 AI 回复</h2>
    <div id="chat" class="chat-box">
      <div class="msg b"><div class="bubble">你好！我是爪爪 AI。<br/>💡 常见问题走本地快捷回复表，零 Token 消耗。<br/>相同问题 12 小时内走 Cache 缓存。</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input id="inp" class="input" placeholder="输入你的问题，回车发送..."/>
      <button class="btn" onclick="sendChat()">发送</button>
    </div>
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

  <div class="card">
    <h2>🔧 部署 &amp; 配置</h2>
    <pre class="code">npm install
wrangler login
wrangler kv:namespace create CLAWBOT_KV          # 凭证（必需）
wrangler d1 create clawbot-stats                 # 统计（可选）
wrangler d1 execute clawbot-stats --file=./schema.sql
wrangler r2 bucket create clawbot-history        # 长期历史（可选）
wrangler queues create clawbot-messages          # 异步队列（可选）
wrangler deploy
# 可选: wrangler secret put ADMIN_PASSWORD       # 管理密码
# 可选: wrangler secret put TURNSTILE_SECRET_KEY  # Turnstile 私钥</pre>
  </div>
</div>

<script>
function getPwd(field){
  const el = document.getElementById(field);
  return el ? el.value.trim() : '';
}
function urlWithPwd(base, field){
  const pwd = getPwd(field);
  if(!pwd) return base;
  return base + (base.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(pwd);
}
function getTurnstileToken(){
  try {
    const els = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
    // 简单取第一个 cf-turnstile response
    const t = document.querySelector('.cf-turnstile');
    if(!t) return '';
    // Cloudflare Turnstile 在 widget 上暴露出 response
    const widget = window.turnstile && window.turnstile.getResponse
      ? window.turnstile.getResponse() : '';
    return widget;
  } catch { return ''; }
}

async function refreshStats(){
  try {
    const [sRes, h24Res, h7Res] = await Promise.all([
      fetch('/api/status',{cache:'no-store'}),
      fetch('/api/history?hours=24',{cache:'no-store'}).catch(()=>null),
      fetch('/api/history?hours=168',{cache:'no-store'}).catch(()=>null),
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
      else errs.innerHTML = list.map(e => new Date(e.t).toLocaleString() + '  —— ' + (e.msg || '(无消息)')).join('\n');
    }
    renderHistory('history-24h', h24Res, '24 小时');
    renderHistory('history-7d', h7Res, '7 天');
  } catch(e){}
}
function renderHistory(id, res, label){
  const el = document.getElementById(id);
  if (!el) return;
  if (!res) { el.textContent = '⚠️ 未配置 D1, 无法查询历史'; return; }
  res.json().then((d) => {
    const rows = (d.data || []).slice(0, 48);
    if (!rows.length) { el.textContent = '(' + label + ') 暂无数据, cron 运行后会累积'; return; }
    const maxP = Math.max(1, ...rows.map(r => r.polls || 0));
    const lines = rows.slice(0, 24).map(r => {
      const t = new Date(r.hour_unix * 1000).toLocaleString();
      const bar = '█'.repeat(Math.max(1, Math.round(((r.polls || 0) / maxP) * 15)));
      return t + '  轮询 ' + r.polls + '  回复 ' + r.handled + '  AI ' + r.ai_calls + '  ' + bar;
    });
    el.textContent = lines.join('\n');
  }).catch(()=>{ el.textContent = '⚠️ 读取失败'; });
}
function goLogin(){
  const pwd = getPwd('login-pwd');
  location.href = '/login' + (pwd ? '?pwd=' + encodeURIComponent(pwd) : '');
}
async function triggerPoll(){
  const el = document.getElementById('poll-result');
  el.textContent = '调用中...';
  try {
    const url = urlWithPwd('/api/trigger-poll', 'poll-pwd');
    const ts = getTurnstileToken();
    const headers: Record<string,string> = {};
    if(ts) headers['X-Turnstile-Token'] = ts;
    const r = await fetch(url, {method:'POST', headers});
    const d = await r.json();
    el.innerHTML = '结果: <pre style="background:#fafbff;padding:10px;border-radius:8px;overflow:auto">' + JSON.stringify(d,null,2) + '</pre>';
    refreshStats();
  } catch(e){ el.textContent = '错误：' + e.message; }
}
async function queryR2(){
  const el = document.getElementById('r2-result');
  el.textContent = '查询中...';
  try {
    const user = (document.getElementById('r2-user') as HTMLInputElement)?.value.trim() || '';
    let base = '/api/r2-history?limit=30';
    if(user) base += '&user=' + encodeURIComponent(user);
    const url = urlWithPwd(base, 'r2-pwd');
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
  const url = urlWithPwd('/api/logout', 'poll-pwd');
  await fetch(url, {method:'POST'});
  location.reload();
}
const chat = document.getElementById('chat');
function addMsg(role,text){
  const d = document.createElement('div'); d.className='msg '+role;
  const b = document.createElement('div'); b.className='bubble'; b.textContent=text;
  d.appendChild(b); chat.appendChild(d); chat.scrollTop = chat.scrollHeight;
}
document.getElementById('inp').addEventListener('keydown',e=>{ if(e.key==='Enter') sendChat(); });
async function sendChat(){
  const inp = document.getElementById('inp') as HTMLInputElement;
  const q = inp.value.trim(); if(!q) return;
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

function LOGIN_PAGE(_env: Env, hasAdmin: boolean): string {
  const pwdNotice = hasAdmin
    ? ""
    : `<div class="notice" style="margin-bottom:12px">🔐 请先设置管理员密码后重新部署：<br/><code>wrangler secret put ADMIN_PASSWORD</code><br/><code>wrangler deploy</code></div>`;

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
  .status{margin:14px 0;font-size:14px;color:#555}
  .status.ok{color:#147a3e;font-weight:600}
  .status.bad{color:#a33}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
  .input{width:100%;border:1px solid #eee;border-radius:999px;padding:10px 18px;font-size:14px;box-sizing:border-box}
</style>
</head>
<body>
<div class="card">
  <h1>🦞 登录微信 ClawBot</h1>
  <div class="sub">微信 → 设置 → 插件 → ClawBot → 扫描下面的二维码</div>
  ${pwdNotice}
  <input id="pwd" class="input" placeholder="管理员密码"/>
  <div class="qr" id="qr"><button class="btn" onclick="getQR()">获取二维码</button></div>
  <div class="status" id="status">点击按钮开始</div>
</div>
<script>
let timer = null;
const qrEl = document.getElementById('qr');
const stEl = document.getElementById('status');
function urlWithPwd(base){
  const pwdEl = document.getElementById('pwd');
  const pwd = pwdEl ? (pwdEl as HTMLInputElement).value.trim() : '';
  return base + (pwd ? (base.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(pwd) : '');
}
async function getQR(){
  qrEl.innerHTML = '加载中...'; stEl.textContent = '';
  try {
    const r = await fetch(urlWithPwd('/api/qrcode'), {cache:'no-store'});
    const d = await r.json();
    if(d.error){ stEl.textContent = '错误：' + d.error; stEl.className='status bad'; return; }
    if(!d.qrcode_img_content) throw new Error('未返回二维码');
    qrEl.innerHTML = '<img src="' + d.qrcode_img_content + '" alt="wechat qrcode"/>';
    stEl.textContent = '请用微信扫描二维码';
    startPolling();
  } catch(e){
    qrEl.innerHTML = '<button class="btn" onclick="getQR()">重试</button>';
    stEl.textContent = '错误：' + e.message;
    stEl.className = 'status bad';
  }
}
function startPolling(){
  if(timer) clearInterval(timer);
  let n = 0;
  timer = setInterval(async () => {
    n++;
    if(n > 60){ clearInterval(timer); stEl.textContent='超时，请重新获取'; return; }
    try {
      const r = await fetch(urlWithPwd('/api/qrcode-status'),{cache:'no-store'});
      const d = await r.json();
      if(d.status === 'confirmed'){
        clearInterval(timer);
        stEl.textContent = '✅ 登录成功，2 秒后跳回首页...'; stEl.className='status ok';
        setTimeout(()=>location.href='/', 2000);
      } else if(d.status === 'scaned'){
        stEl.textContent = '已扫码，请在手机上确认'; stEl.className='status';
      } else if(d.status === 'expired'){
        clearInterval(timer);
        stEl.textContent = '二维码已过期'; stEl.className='status bad';
        qrEl.innerHTML = '<button class="btn" onclick="getQR()">重新获取</button>';
      } else {
        stEl.textContent = '等待扫码... (' + n + ')';
      }
    } catch(e){
      stEl.textContent='轮询错误：'+e.message; stEl.className='status bad';
    }
  }, 2000);
}
getQR();
</script>
</body>
</html>`;
}
