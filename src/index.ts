// ======================================================================
//  ClawBot AI 主入口 —— Cloudflare Worker
// ----------------------------------------------------------------------
//  路由:
//    GET  /                       管理面板 (HTML)
//    GET  /api/qrcode             发起扫码登录,返回二维码 URL
//    GET  /api/qrcode-status      轮询扫码状态
//    POST /api/trigger-poll       手动触发一次消息拉取并处理
//    GET  /api/status             运行状态 (凭证 / 最后拉取时间等)
//    POST /api/logout             退出登录,删除凭证
//    POST /api/chat               直接调用 AI (JSON API)
//    GET  /healthz                健康检查
//    GET  /login                  扫码登录网页
// ======================================================================

import * as ilink from "./ilink";
import {
  tryHandleCommand,
  turnAndSave,
  loadContext,
  saveContext,
  clearContext,
  loadBuf,
  saveBuf,
} from "./ai-service";

// Cloudflare 绑定
export interface Env {
  // AI binding (wrangler.toml 里开启)
  AI: any;
  // KV 绑定: 用于凭证、上下文、长轮询游标
  CLAWBOT_KV: KVNamespace;
  // 可配置的变量
  AI_SYSTEM_PROMPT?: string;
  // 可选的管理员密码,用于保护 /login 等页面
  ADMIN_PASSWORD?: string;
}

// KV keys
const KV_CRED = "clawbot:credentials";
const KV_STATE = "clawbot:state"; // {lastPollAt, totalMessages, errorCount}
const KV_QR = "clawbot:qrcode_pending"; // 登录过程中的 qrcode key

// ---------------- 工具 ----------------

function json(data: any, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
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

// 需要密码的路径简单校验
function checkAuth(req: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) return null; // 未配置直接放行 (适合仅本地/仅自己使用)
  const url = new URL(req.url);
  const header = req.headers.get("Authorization") || "";
  const pw = header.replace(/^Bearer\s+/i, "").trim();
  if (pw === env.ADMIN_PASSWORD) return null;
  const qp = url.searchParams.get("pw") || "";
  if (qp === env.ADMIN_PASSWORD) return null;
  return new Response("Unauthorized", { status: 401 });
}

async function getCredentials(env: Env): Promise<ilink.LoginCredentials | null> {
  try {
    const raw = await env.CLAWBOT_KV.get(KV_CRED);
    if (!raw) return null;
    return JSON.parse(raw) as ilink.LoginCredentials;
  } catch {
    return null;
  }
}

async function saveCredentials(env: Env, creds: ilink.LoginCredentials) {
  await env.CLAWBOT_KV.put(KV_CRED, JSON.stringify(creds));
}

async function deleteCredentials(env: Env) {
  await env.CLAWBOT_KV.delete(KV_CRED);
}

async function getState(env: Env): Promise<Record<string, any>> {
  try {
    const raw = await env.CLAWBOT_KV.get(KV_STATE);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return { lastPollAt: 0, totalMessages: 0, errorCount: 0, lastError: null };
}

async function setState(env: Env, patch: Record<string, any>) {
  const cur = await getState(env);
  const next = { ...cur, ...patch };
  await env.CLAWBOT_KV.put(KV_STATE, JSON.stringify(next));
  return next;
}

// ---------------- 业务: 处理一次消息拉取 ----------------

async function pollAndReply(env: Env): Promise<{
  polled: number;
  messages: string[];
  error?: string;
}> {
  const creds = await getCredentials(env);
  if (!creds) return { polled: 0, messages: [], error: "未登录" };

  const buf = await loadBuf(env.CLAWBOT_KV);
  // 短轮询 3~5s,Worker 不适合长轮询
  const res = await ilink.getUpdates(creds.token, buf, creds.baseUrl, 5000);
  await saveBuf(env.CLAWBOT_KV, res.get_updates_buf || buf);

  if (res.errcode || res.ret !== 0) {
    const err = res.errmsg || `ret=${res.ret}, errcode=${res.errcode}`;
    await setState(env, {
      errorCount: (await getState(env)).errorCount + 1,
      lastError: err,
      lastPollAt: Date.now(),
    });
    return { polled: 0, messages: [], error: err };
  }

  const handled: string[] = [];
  for (const msg of res.msgs || []) {
    const text = ilink.extractText(msg);
    if (!text) continue;
    const fromId = msg.from_user_id;
    const contextToken = msg.context_token;

    // 1) 系统指令
    const cmd = tryHandleCommand(text);
    if (cmd.handled) {
      if (cmd.reset) await clearContext(env.CLAWBOT_KV, fromId);
      await ilink.replyText(creds.token, fromId, contextToken, cmd.reply || "ok", creds.baseUrl);
      handled.push(`[cmd] ${text} -> ${cmd.reply?.slice(0, 40)}`);
      continue;
    }

    // 2) 发送"正在输入"状态 (可选)
    ilink.sendTyping(creds.token, fromId, true, creds.baseUrl).catch(() => {});

    // 3) AI 回答
    const reply = await turnAndSave(
      env.AI,
      env.CLAWBOT_KV,
      fromId,
      text,
      env.AI_SYSTEM_PROMPT
    );

    // 4) 回复给微信
    const sendRes = await ilink.replyText(
      creds.token,
      fromId,
      contextToken,
      reply,
      creds.baseUrl
    );

    ilink.sendTyping(creds.token, fromId, false, creds.baseUrl).catch(() => {});

    handled.push(
      `${text.slice(0, 30)} -> ${reply.slice(0, 40)} (send.ret=${sendRes.ret})`
    );
  }

  const state = await setState(env, {
    lastPollAt: Date.now(),
    totalMessages: (await getState(env)).totalMessages + (res.msgs?.length || 0),
  });

  return { polled: res.msgs?.length || 0, messages: handled, error: state.lastError };
}

// ======================================================================
//  fetch 主路由
// ======================================================================

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 健康检查
    if (path === "/healthz") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // 需要登录的路径做简单校验
    const protectedPaths = [
      "/api/qrcode",
      "/api/qrcode-status",
      "/api/trigger-poll",
      "/api/logout",
      "/login",
    ];
    if (protectedPaths.includes(path)) {
      const denied = checkAuth(request, env);
      if (denied) return denied;
    }

    // ---------- 扫码登录 ----------
    if (path === "/api/qrcode" && method === "GET") {
      try {
        const { key, imgUrl } = await ilink.getQRCode();
        // 把 key 存在 KV,后面 status 接口拿
        await env.CLAWBOT_KV.put(KV_QR, key, { expirationTtl: 5 * 60 });
        return json({ qrcode: key, qrcode_img_content: imgUrl });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/qrcode-status" && method === "GET") {
      try {
        const key = (await env.CLAWBOT_KV.get(KV_QR)) || url.searchParams.get("qrcode") || "";
        if (!key) return json({ status: "unknown" });
        const s = await ilink.getQRCodeStatus(key);
        if (s.status === "confirmed" && s.bot_token) {
          const creds: ilink.LoginCredentials = {
            token: s.bot_token,
            accountId: s.ilink_bot_id || "",
            userId: s.ilink_user_id || "",
            baseUrl: s.baseurl || ilink.I_LINK_BASE,
            createdAt: Date.now(),
          };
          await saveCredentials(env, creds);
          await env.CLAWBOT_KV.delete(KV_QR);
          return json({ status: "confirmed", ok: true });
        }
        return json({ status: s.status, detail: s });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- 主动触发一次消息拉取 ----------
    if (path === "/api/trigger-poll" && method === "POST") {
      const result = await pollAndReply(env);
      return json(result);
    }

    // ---------- 状态 ----------
    if (path === "/api/status") {
      const creds = await getCredentials(env);
      const state = await getState(env);
      // 上下文数量粗略统计
      return json({
        loggedIn: !!creds,
        accountId: creds?.accountId || "",
        userIdMasked: creds?.userId ? (creds.userId.slice(0, 6) + "***") : "",
        baseUrl: creds?.baseUrl || "",
        state,
        hasAi: !!env.AI,
        hasKv: !!env.CLAWBOT_KV,
      });
    }

    // ---------- 退出 ----------
    if (path === "/api/logout" && method === "POST") {
      await deleteCredentials(env);
      await saveBuf(env.CLAWBOT_KV, "");
      return json({ ok: true });
    }

    // ---------- JSON 对话 API (非微信场景直接调用 AI) ----------
    if (path === "/api/chat" && method === "POST") {
      try {
        const body = (await request.json()) as { message: string; userId?: string };
        const message = body?.message;
        if (!message) return json({ error: "missing message" }, 400);
        const uid = body.userId || "web_user";
        const reply = await turnAndSave(
          env.AI,
          env.CLAWBOT_KV,
          uid,
          message,
          env.AI_SYSTEM_PROMPT
        );
        return json({ reply });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- 登录页 ----------
    if (path === "/login") {
      return html(LOGIN_PAGE);
    }

    // ---------- 首页: 管理面板 ----------
    if (path === "/" || path === "") {
      const state = await getState(env);
      const creds = await getCredentials(env);
      return html(HOME_PAGE(env, state, !!creds));
    }

    return json({ error: "Not Found" }, 404);
  },

  // 定时触发消息拉取 (cron)
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const creds = await getCredentials(env);
    if (!creds) return;
    try {
      await pollAndReply(env);
    } catch (e) {
      console.error("[cron] error:", e);
    }
  },
};

// ======================================================================
//  页面模板
// ======================================================================

function HOME_PAGE(env: Env, state: Record<string, any>, loggedIn: boolean): string {
  const pw = env.ADMIN_PASSWORD ? `&pw=${encodeURIComponent(env.ADMIN_PASSWORD)}` : "";
  const lastPoll = state.lastPollAt
    ? new Date(state.lastPollAt).toLocaleString("zh-CN")
    : "从未";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>🦞 爪爪 ClawBot AI</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5 0%,#f0f7ff 50%,#f5efff 100%);min-height:100vh;color:#222}
  .wrap{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  .card{background:#fff;border-radius:18px;padding:22px;margin-bottom:18px;box-shadow:0 8px 28px rgba(0,0,0,.06)}
  h1{margin:0 0 4px;font-size:28px;color:#ff4d8d}
  .sub{color:#666;font-size:14px;margin-bottom:16px}
  .row{display:flex;gap:12px;flex-wrap:wrap}
  .btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer;transition:transform .1s}
  .btn:hover{transform:translateY(-1px)}
  .btn.secondary{background:#f3f3f7;color:#555}
  .btn.danger{background:linear-gradient(135deg,#ff6b6b,#ee5a6f)}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;margin-right:6px}
  .ok{background:#e8f7ee;color:#147a3e}
  .bad{background:#fde8e8;color:#a33}
  .muted{color:#888}
  pre.code{background:#1e2230;color:#f5f5f5;padding:14px;border-radius:12px;overflow-x:auto;font-size:12px;line-height:1.6}
  h2{font-size:18px;margin:18px 0 8px;color:#ff4d8d}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px}
  .kv b{color:#555}
  .chat-box{height:320px;overflow-y:auto;padding:12px;background:#fafbff;border-radius:14px;border:1px solid #eee}
  .msg{margin:8px 0}.msg .bubble{padding:10px 14px;border-radius:14px;max-width:80%;line-height:1.5;font-size:14px}
  .msg.u{text-align:right}.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;display:inline-block;text-align:left}
  .msg.b .bubble{background:#fff;border:1px solid #eee;display:inline-block}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🦞 爪爪 ClawBot AI</h1>
    <div class="sub">基于 Cloudflare Worker + Worker AI 的微信个人号机器人</div>
    <div class="row">
      <span class="badge ${loggedIn ? "ok" : "bad"}">${loggedIn ? "✓ 已登录微信" : "✗ 未登录"}</span>
      <span class="badge ok">Worker AI 已绑定</span>
      <span class="badge ${env.CLAWBOT_KV ? "ok" : "bad"}">${env.CLAWBOT_KV ? "KV 存储可用" : "缺少 KV"}</span>
    </div>
  </div>

  <div class="card">
    <h2>📱 1. 扫码登录微信</h2>
    <div class="sub">用微信 → 设置 → 插件 → ClawBot → 扫码登录</div>
    <div class="row">
      <button class="btn" onclick="location.href='/login${pw}'">去扫码登录</button>
      ${
        loggedIn
          ? `<button class="btn danger" onclick="logout()">退出登录</button>`
          : ""
      }
    </div>
  </div>

  <div class="card">
    <h2>📡 2. 拉取 & 回复消息</h2>
    <div class="kv">
      <b>上次拉取时间:</b><span>${lastPoll}</span>
      <b>累计处理消息:</b><span>${state.totalMessages || 0}</span>
      <b>累计错误:</b><span class="${state.errorCount ? "muted" : ""}">${state.errorCount || 0}</span>
      <b>最近错误:</b><span class="muted">${state.lastError || "无"}</span>
    </div>
    <p class="sub">Worker 使用 *短轮询* 拉取微信服务器 (每次 3~5 秒)。<br/>
      建议在 wrangler.toml 中启用 <code class="inline">crons = ["* * * * *"]</code> 让它每分钟自动跑一次。<br/>
      也可以手动点击按钮触发一次。</p>
    <button class="btn" onclick="triggerPoll()">手动触发一次拉取</button>
    <div id="poll-result" class="sub" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>🤖 3. 直接测试 AI 回复</h2>
    <div id="chat" class="chat-box">
      <div class="msg b"><div class="bubble">你好!我是爪爪 AI,有什么想问的?<br/>💡 你也可以在微信里直接跟我对话,这里只是同一个模型的网页测试。</div></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input id="inp" style="flex:1;border:1px solid #eee;border-radius:999px;padding:10px 18px;font-size:14px" placeholder="输入你的问题,回车发送..."/>
      <button class="btn" onclick="sendChat()">发送</button>
    </div>
  </div>

  <div class="card">
    <h2>🧩 部署 & 配置</h2>
    <pre class="code"># 1. 安装依赖
npm install

# 2. 修改 wrangler.toml,确保 AI + KV 绑定

# 3. 创建 KV namespace (第一次需要)
wrangler kv:namespace create CLAWBOT_KV
# 然后把返回的 id 加到 wrangler.toml 的 [[kv_namespaces]]

# 4. 部署
npm run deploy

# 5. 打开 /login 扫码,每分钟 cron 自动处理消息</pre>
  </div>

  <div class="card">
    <h2>💬 微信指令</h2>
    <div class="kv">
      <b>帮助 / help</b><span>返回使用指南</span>
      <b>重置 / clear</b><span>清空该用户上下文</span>
      <b>关于 / about</b><span>返回机器人版本信息</span>
      <b>其他消息</b><span>交由 AI 自动回复</span>
    </div>
  </div>
</div>

<script>
const PW = ${JSON.stringify(pw)};
async function triggerPoll(){
  const el = document.getElementById('poll-result');
  el.textContent = '正在调用...';
  try {
    const r = await fetch('/api/trigger-poll' + PW, {method:'POST'});
    const d = await r.json();
    el.innerHTML = '结果: <pre style="background:#fafbff;padding:10px;border-radius:8px;overflow:auto">' +
      JSON.stringify(d,null,2) + '</pre>';
  } catch(e){ el.textContent = '错误:' + e.message; }
}
async function logout(){
  if(!confirm('确认退出登录?下次需重新扫码。')) return;
  await fetch('/api/logout' + PW, {method:'POST'});
  location.reload();
}
const chat = document.getElementById('chat');
function addMsg(role, text){
  const d = document.createElement('div'); d.className = 'msg ' + role;
  const b = document.createElement('div'); b.className='bubble'; b.textContent=text;
  d.appendChild(b); chat.appendChild(d); chat.scrollTop = chat.scrollHeight;
}
document.getElementById('inp').addEventListener('keydown', e => { if(e.key==='Enter') sendChat(); });
async function sendChat(){
  const inp = document.getElementById('inp');
  const q = inp.value.trim(); if(!q) return;
  addMsg('u', q); inp.value = '';
  try {
    const r = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message: q, userId:'web_user'})});
    const d = await r.json();
    addMsg('b', d.reply || '(空)');
  } catch(e){ addMsg('b', '错误:' + e.message); }
}
</script>
</body>
</html>`;
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>扫码登录 · 爪爪 ClawBot</title>
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
  .muted{color:#888;font-size:12px;margin-top:16px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
  <h1>🦞 登录微信 ClawBot</h1>
  <div class="sub">用微信「我 → 设置 → 插件 → ClawBot」扫码绑定</div>
  <div class="qr" id="qr"><button class="btn" onclick="getQR()">获取二维码</button></div>
  <div class="status" id="status">点击按钮开始</div>
  <div class="muted">扫码完成后,凭证保存在 Worker 的 KV 中。<br/>Worker 会在 cron 触发时拉取并回复消息。</div>
</div>
<script>
let pollTimer = null;
const qrEl = document.getElementById('qr');
const stEl = document.getElementById('status');

async function getQR(){
  qrEl.innerHTML = '加载中...'; stEl.textContent = '';
  try {
    const r = await fetch('/api/qrcode' + location.search, {cache:'no-store'});
    const d = await r.json();
    if (!d.qrcode_img_content) throw new Error('未返回二维码');
    qrEl.innerHTML = '<img src="' + d.qrcode_img_content + '" alt="wechat qrcode"/>';
    stEl.textContent = '请用微信扫描二维码';
    startStatusPoll();
  } catch(e){
    qrEl.innerHTML = '<button class="btn" onclick="getQR()">重试</button>';
    stEl.textContent = '错误:' + e.message;
    stEl.className = 'status bad';
  }
}
function startStatusPoll(){
  if(pollTimer) clearInterval(pollTimer);
  let tries = 0;
  pollTimer = setInterval(async () => {
    tries++;
    if(tries > 60){ clearInterval(pollTimer); stEl.textContent='超时,请重新获取二维码'; stEl.className='status bad'; return; }
    try {
      const r = await fetch('/api/qrcode-status' + location.search, {cache:'no-store'});
      const d = await r.json();
      if(d.status === 'confirmed'){
        clearInterval(pollTimer);
        stEl.textContent = '✅ 登录成功! 2 秒后跳回首页...'; stEl.className='status ok';
        setTimeout(()=>location.href='/'+location.search, 2000);
      } else if(d.status === 'expired'){
        clearInterval(pollTimer);
        stEl.textContent = '二维码已过期,请重新获取'; stEl.className='status bad';
        qrEl.innerHTML = '<button class="btn" onclick="getQR()">重新获取</button>';
      } else if(d.status === 'scaned'){
        stEl.textContent = '已扫码,请在手机上确认';
        stEl.className = 'status';
      } else {
        stEl.textContent = '等待扫码... (' + tries + ')';
      }
    } catch(e){ stEl.textContent = '轮询错误:' + e.message; stEl.className='status bad'; }
  }, 2000);
}
// 自动获取一次
getQR();
</script>
</body>
</html>`;
