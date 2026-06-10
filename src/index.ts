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
} from "./ai-service";

// ---------- KV key 常量 ----------
const KV_CRED = "clawbot:credentials";

export interface Env {
  AI: any;
  CLAWBOT_KV: KVNamespace;
  AI_SYSTEM_PROMPT?: string;
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

// 消息去重 —— 用 Cache API 代替 KV，零写额度
// 2 小时 TTL 足够，因为 cron 每 2 分钟拉一次，消息不会被反复推很久
function seenCacheKey(msgId: string): string {
  return `https://clawbot.local/seen/${encodeURIComponent(msgId)}`;
}

async function markMessageSeen(msgId: string): Promise<boolean> {
  try {
    const cache = caches.default;
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

// ---------- 轻量统计（纯内存，不写存储，冷启动清零）----------
const stats = {
  polls: 0,
  handled: 0,
  shortcuts: 0,
  aiCalls: 0,
  cacheHits: 0,
  lastPollAt: 0,
  lastLatencyMs: 0,
};

// ======================================================================
//  核心：拉取 + 处理 + 回复
// ======================================================================
async function pollAndReply(env: Env): Promise<{
  pulled: number;
  handled: number;
  error?: string;
  latencyMs: number;
}> {
  const start = Date.now();
  const creds = await getCredentials(env);
  if (!creds) return { pulled: 0, handled: 0, error: "未登录", latencyMs: 0 };

  const res = await ilink.getUpdates(
    creds.token,
    "",
    creds.baseUrl,
    4000
  );

  stats.polls++;
  stats.lastPollAt = Date.now();

  if (res.ret !== 0) {
    return {
      pulled: 0,
      handled: 0,
      error: `ret=${res.ret}${res.errcode ? ",errcode=" + res.errcode : ""}`,
      latencyMs: Date.now() - start,
    };
  }

  const msgs = res.msgs || [];

  // 排序 + 按 from_user_id 串行回复：
  // - 按 create_time 升序保证聊天时序
  // - 同一用户多条消息按顺序回复，避免并发写同一个人触发频率限制
  msgs.sort(
    (a, b) => (a.create_time || 0) - (b.create_time || 0)
  );

  const handledBy = new Set<string>(); // 当前轮已处理过的用户（用于串行）
  let handled = 0;

  for (const msg of msgs) {
    const from = msg.from_user_id;
    const ctxToken = msg.context_token;
    const text = ilink.extractText(msg);
    if (!text) continue;

    // 1) 消息去重（Cache API，零写额度）
    const seenKey = msg.msg_id || `${msg.create_time}:${from}`;
    const seen = await markMessageSeen(seenKey);
    if (seen) continue;

    // 2) 同一用户在本轮已回复过：加一点间隔（避免连续消息丢一条）
    if (handledBy.has(from)) {
      await new Promise((r) => setTimeout(r, 220));
    }

    // 3) 指令 / 关键词处理
    const cmd = tryHandleCommand(text);
    if (cmd.handled) {
      if (cmd.reset) await clearContext(from);
      await ilink.replyText(
        creds.token,
        from,
        ctxToken,
        cmd.reply || "ok",
        creds.baseUrl
      );
      stats.shortcuts++;
      stats.handled++;
      handledBy.add(from);
      handled++;
      continue;
    }

    // 4) 设置"输入中"（非阻塞）
    ilink.sendTyping(creds.token, from, true, creds.baseUrl).catch(() => {});

    // 5) 调用 AI（上下文读/写走 Cache API）
    const reply = await turnAndSave(
      env.AI,
      from,
      text,
      env.AI_SYSTEM_PROMPT
    );

    // 6) 回复给微信（replyText 内部会自动关掉 typing、处理过长文本）
    await ilink.replyText(creds.token, from, ctxToken, reply, creds.baseUrl);
    stats.aiCalls++;
    stats.handled++;
    handledBy.add(from);
    handled++;
  }

  return {
    pulled: msgs.length,
    handled,
    latencyMs: (() => { const ms = Date.now() - start; stats.lastLatencyMs = ms; return ms; })(),
  };
}

// ======================================================================
//  fetch 主路由
// ======================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz")
      return json({ ok: true, time: new Date().toISOString() });

    // ---------- 扫码登录 ----------
    if (path === "/api/qrcode" && method === "GET") {
      try {
        const { key, imgUrl } = await ilink.getQRCode();
        // 把 key 存在 KV —— 只在登录流程里写一次，不属于高频写
        await env.CLAWBOT_KV.put("clawbot:qrcode_key", key, {
          expirationTtl: 5 * 60,
        });
        return json({ qrcode: key, qrcode_img_content: imgUrl });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/qrcode-status" && method === "GET") {
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

    // ---------- 手动触发一次消息拉取 ----------
    if (path === "/api/trigger-poll" && method === "POST") {
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
        version: "v1.2-optimized",
        stats,
      });
    }

    // ---------- 退出登录 ----------
    if (path === "/api/logout" && method === "POST") {
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
        if (cmd.handled) return json({ reply: cmd.reply || "", source: "shortcut" });

        const uid = body.userId || "web_user";
        const reply = await turnAndSave(env.AI, uid, message, env.AI_SYSTEM_PROMPT);
        return json({ reply, source: "ai" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- 扫码登录页 ----------
    if (path === "/login") return html(LOGIN_PAGE);

    // ---------- 管理面板 ----------
    if (path === "/" || path === "") {
      const creds = await getCredentials(env);
      return html(HOME_PAGE(env, !!creds));
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
};

// ======================================================================
//  HTML 页面
// ======================================================================
function HOME_PAGE(env: Env, loggedIn: boolean): string {
  const statusBadge = (ok: boolean, text: string) =>
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"} ${text}</span>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>🦞 爪爪 ClawBot AI · 优化版</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5 0%,#f0f7ff 50%,#f5efff 100%);min-height:100vh;color:#222}
  .wrap{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  .card{background:#fff;border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 8px 28px rgba(0,0,0,.06)}
  h1{margin:0 0 4px;font-size:28px;color:#ff4d8d}
  .sub{color:#666;font-size:14px;margin-bottom:12px}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
  .btn.secondary{background:#f3f3f7;color:#555}
  .btn.danger{background:linear-gradient(135deg,#ff6b6b,#ee5a6f)}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:13px}
  .kv b{color:#555}
  pre.code{background:#1e2230;color:#f5f5f5;padding:14px;border-radius:12px;overflow-x:auto;font-size:12px;line-height:1.6}
  .chat-box{height:320px;overflow-y:auto;padding:12px;background:#fafbff;border-radius:14px;border:1px solid #eee}
  .msg{margin:8px 0}
  .msg .bubble{padding:10px 14px;border-radius:14px;max-width:80%;line-height:1.5;font-size:14px}
  .msg.u{text-align:right}.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;display:inline-block;text-align:left}
  .msg.b .bubble{background:#fff;border:1px solid #eee;display:inline-block}
  h2{font-size:18px;margin:0 0 8px;color:#ff4d8d}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:#e8f8ee;color:#147a3e}
  .badge.bad{background:#fde6e6;color:#a33}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🦞 爪爪 ClawBot AI · v1.2</h1>
    <div class="sub">Cloudflare Workers + Worker AI · 上下文走 Cache API · 零 KV 高频写 · AI 输出微信友好格式化</div>
    <div class="row">
      ${statusBadge(loggedIn, "已登录微信")}
      ${statusBadge(true, "Worker AI 已绑定")}
      ${statusBadge(true, "KV 凭证存储")}
      ${statusBadge(true, "Cache API 上下文/去重")}
    </div>
  </div>

  <div class="card">
    <h2>📊 实时状态</h2>
    <div id="live-stats" class="kv">
      <b>轮询次数</b><span>—</span>
      <b>处理消息</b><span>—</span>
      <b>AI 调用</b><span>—</span>
      <b>快捷回复</b><span>—</span>
      <b>上次轮询</b><span>—</span>
    </div>
  </div>

  <div class="card">
    <h2>📱 1. 扫码登录微信</h2>
    <div class="sub">在微信 → 设置 → 插件 → ClawBot 里扫描二维码。</div>
    <div class="row">
      <button class="btn" onclick="location.href='/login'">去扫码登录</button>
      ${loggedIn ? `<button class="btn danger" onclick="logout()">退出登录</button>` : ""}
    </div>
  </div>

  <div class="card">
    <h2>📡 2. 拉取 &amp; 回复消息</h2>
    <div class="kv">
      <b>调度器</b><span>cron 每 2 分钟自动触发</span>
      <b>长轮询时间</b><span>每次 ~4s（避免超时 Worker 免费额度）</span>
      <b>去重策略</b><span>msg_id → Cache API，零写额度</span>
      <b>文本格式化</b><span>自动移除 code fence / markdown / HTML</span>
    </div>
    <button class="btn" style="margin-top:12px" onclick="triggerPoll()">手动触发一次拉取</button>
    <div id="poll-result" class="sub" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>🤖 3. 直接测试 AI 回复</h2>
    <div id="chat" class="chat-box">
      <div class="msg b"><div class="bubble">你好！我是爪爪 AI。<br/>💡 常见问题（例如"你好"、"几点了"）会走本地快捷回复表，零 Token 消耗。<br/>相同问题在 12 小时内会走 Cache 缓存，不重复调用 AI。</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input id="inp" style="flex:1;border:1px solid #eee;border-radius:999px;padding:10px 18px;font-size:14px" placeholder="输入你的问题，回车发送..."/>
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
wrangler deploy

# 首次登录
# 打开 https://<你的 worker 域名>/login 扫码

# 可选：调整 cron 频率
# 见 wrangler.toml 的 [triggers] 部分</pre>
  </div>
</div>

<script>
async function refreshStats(){
  try {
    const r = await fetch('/api/status',{cache:'no-store'});
    const d = await r.json();
    const s = d.stats || {};
    const el = document.getElementById('live-stats');
    if(!el) return;
    const fmt = (v)=> v == null ? '—' : v;
    const last = s.lastPollAt ? new Date(s.lastPollAt).toLocaleString() : '从未';
    el.innerHTML =
      '<b>登录状态</b><span>' + (d.loggedIn ? '✅' : '❌') + '</span>' +
      '<b>轮询次数</b><span>' + fmt(s.polls) + '</span>' +
      '<b>累计处理消息</b><span>' + fmt(s.handled) + '</span>' +
      '<b>AI 调用</b><span>' + fmt(s.aiCalls) + '</span>' +
      '<b>快捷回复</b><span>' + fmt(s.shortcuts) + '</span>' +
      '<b>上次轮询</b><span>' + last + '</span>';
  } catch(e){}
}
async function triggerPoll(){
  const el = document.getElementById('poll-result');
  el.textContent = '调用中...';
  try {
    const r = await fetch('/api/trigger-poll',{method:'POST'});
    const d = await r.json();
    el.innerHTML = '结果: <pre style="background:#fafbff;padding:10px;border-radius:8px;overflow:auto">' + JSON.stringify(d,null,2) + '</pre>';
    refreshStats();
  } catch(e){ el.textContent = '错误：' + e.message; }
}
async function logout(){
  if(!confirm('确认退出登录？')) return;
  await fetch('/api/logout',{method:'POST'});
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
  const inp = document.getElementById('inp');
  const q = inp.value.trim(); if(!q) return;
  addMsg('u',q); inp.value='';
  try {
    const r = await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:q,userId:'web_user'})});
    const d = await r.json();
    addMsg('b',(d.reply||'') + (d.source==='shortcut' ? ' [快捷回复]' : ''));
  } catch(e){ addMsg('b','错误：'+e.message); }
}
// 打开页面先拉一次状态，之后每 30s 刷新
refreshStats();
setInterval(refreshStats, 30000);
</script>
</body>
</html>`;
}

const LOGIN_PAGE = `<!doctype html>
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
  .qr{border:1px dashed #ffb6c8;border-radius:16px;padding:22px;margin:16px 0;min-height:220px;display:flex;align-items:center;justify-content:center;background:#fffafc}
  .qr img{max-width:220px;max-height:220px}
  .status{margin:14px 0;font-size:14px;color:#555}
  .status.ok{color:#147a3e;font-weight:600}
  .status.bad{color:#a33}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:12px 28px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<div class="card">
  <h1>🦞 登录微信 ClawBot</h1>
  <div class="sub">微信 → 设置 → 插件 → ClawBot → 扫描下面的二维码</div>
  <div class="qr" id="qr"><button class="btn" onclick="getQR()">获取二维码</button></div>
  <div class="status" id="status">点击按钮开始</div>
</div>
<script>
let timer = null;
const qrEl = document.getElementById('qr');
const stEl = document.getElementById('status');

async function getQR(){
  qrEl.innerHTML = '加载中...'; stEl.textContent = '';
  try {
    const r = await fetch('/api/qrcode', {cache:'no-store'});
    const d = await r.json();
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
      const r = await fetch('/api/qrcode-status',{cache:'no-store'});
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
