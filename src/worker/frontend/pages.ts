// 前端页面渲染 - 使用 CDN Vue 3，无需构建
import { html } from "../utils";

export function renderLoginPage(): Response {
  return html(LOGIN_HTML);
}

export function renderAdminPage(): Response {
  return html(ADMIN_HTML);
}

// 登录页面 HTML
const LOGIN_HTML = "<!doctype html>" +
"<html lang='zh-CN'>" +
"<head>" +
"<meta charset='utf-8'/>" +
"<meta name='viewport' content='width=device-width,initial-scale=1'/>" +
"<title>扫码登录 · ClawBot AI</title>" +
"<script type='importmap'>" + JSON.stringify({ imports: { vue: "https://unpkg.com/vue@3.4.21/dist/vue.esm-browser.prod.js" } }) + "</script>" +
"<style>" + LOGIN_CSS + "</style>" +
"</head><body><div id='app'></div><script type='module'>" + LOGIN_SCRIPT + "</script></body></html>";

const LOGIN_CSS = `
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif;background:linear-gradient(135deg,#fff0f5,#f0f7ff);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:22px;padding:36px 28px;box-shadow:0 8px 28px rgba(0,0,0,.08);text-align:center;max-width:420px;width:100%}
h1{color:#ff4d8d;margin:0 0 8px;font-size:24px}
.sub{color:#666;font-size:14px;margin-bottom:20px}
.input{width:100%;border:1px solid #e0e0e5;border-radius:12px;padding:14px 18px;font-size:15px;box-sizing:border-box;margin-bottom:16px}
.input:focus{outline:none;border-color:#ff6b9d;box-shadow:0 0 0 3px rgba(255,107,157,.1)}
.btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:14px 28px;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;width:100%}
.btn:disabled{opacity:.5;cursor:not-allowed}
.qr{border:1px dashed #ffb6c8;border-radius:20px;padding:24px;margin:20px 0;min-height:240px;display:flex;align-items:center;justify-content:center;background:#fffafc}
.qr img{max-width:220px;max-height:220px;border-radius:12px}
.badge{display:inline-block;padding:8px 18px;border-radius:999px;font-size:14px;font-weight:600}
.badge.ok{background:#e8f8ee;color:#147a3e}
.badge.wait{background:#fff4e5;color:#b37400}
.badge.bad{background:#fde6e6;color:#a33}
.notice{background:#fff8e1;border:1px solid #ffd54f;border-radius:12px;padding:14px;font-size:13px;color:#665c00;margin-bottom:16px;text-align:left;line-height:1.6}
.loader{width:36px;height:36px;border:3px solid #ffb6c8;border-top-color:#ff6b9d;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
`;

const LOGIN_SCRIPT = `
import { createApp, ref, onUnmounted } from "vue";
createApp({
  setup() {
    const password = ref("");
    const qrCode = ref("");
    const qrImage = ref("");
    const qrStatus = ref("");
    const error = ref("");
    const isLoading = ref(false);
    const loggedIn = ref(false);
    let pollTimer = null;
    function withPwd(p){ return pwd() ? p + "?pwd=" + encodeURIComponent(pwd()) : p; }
    function pwd(){ return password.value; }
    async function startLogin() {
      error.value = "";
      if (!pwd()) { error.value = "请输入管理员密码"; return; }
      isLoading.value = true;
      try {
        const res = await fetch(withPwd("/api/qrcode"));
        const data = await res.json();
        if (data.error) { error.value = data.error; isLoading.value = false; return; }
        qrCode.value = data.qrcode;
        qrImage.value = "data:image/png;base64," + data.qrcode_img_content;
        qrStatus.value = "等待扫码...";
        pollStatus();
      } catch (e) { error.value = "获取二维码失败: " + e.message; }
      finally { isLoading.value = false; }
    }
    async function pollStatus() {
      try {
        const res = await fetch(withPwd("/api/qrcode-status"));
        const data = await res.json();
        if (data.ok || data.status === "confirmed") {
          qrStatus.value = "登录成功！";
          loggedIn.value = true;
          setTimeout(function(){ location.href = "/"; }, 1500);
          return;
        }
        if (data.status === "scaned") qrStatus.value = "已扫码，请在手机上确认";
        else if (data.status === "expired") { qrStatus.value = "二维码已过期，请刷新重试"; return; }
        else qrStatus.value = "等待扫码...";
        pollTimer = setTimeout(pollStatus, 2000);
      } catch { pollTimer = setTimeout(pollStatus, 3000); }
    }
    function reset() {
      if (pollTimer) clearTimeout(pollTimer);
      qrCode.value = ""; qrImage.value = ""; qrStatus.value = ""; error.value = ""; loggedIn.value = false;
    }
    onUnmounted(function(){ if (pollTimer) clearTimeout(pollTimer); });
    return { password, qrCode, qrImage, qrStatus, error, isLoading, loggedIn, startLogin, reset };
  },
  template: "<div class='card'><h1>🦞 ClawBot AI</h1><div class='sub'>微信机器人管理面板</div>" +
    "<div v-if='!qrCode'><input class='input' v-model='password' placeholder='管理员密码' type='password' @keyup.enter='startLogin'/><button class='btn' :disabled='isLoading' @click='startLogin'>{{ isLoading ? '加载中...' : '获取二维码' }}</button></div>" +
    "<div v-else-if='!loggedIn'><div class='qr'><img :src='qrImage' alt='QR Code'/></div><div v-if='qrStatus' class='badge wait'>{{ qrStatus }}</div><div style='margin-top:20px'><button class='btn' style='background:#f3f3f7;color:#555' @click='reset'>重新获取</button></div></div>" +
    "<div v-else><span class='badge ok'>✅ 登录成功！正在跳转...</span></div>" +
    "<div v-if='error' class='notice' style='margin-top:16px'>{{ error }}</div>" +
    "</div>"
}).mount("#app");
`;

// 管理面板 HTML
const ADMIN_HTML = "<!doctype html>" +
"<html lang='zh-CN'>" +
"<head>" +
"<meta charset='utf-8'/>" +
"<meta name='viewport' content='width=device-width,initial-scale=1'/>" +
"<title>🦞 ClawBot AI · 管理面板</title>" +
"<script type='importmap'>" + JSON.stringify({ imports: { vue: "https://unpkg.com/vue@3.4.21/dist/vue.esm-browser.prod.js" } }) + "</script>" +
"<style>" + ADMIN_CSS + "</style>" +
"</head><body><div id='app'></div><script type='module'>" + ADMIN_SCRIPT + "</script></body></html>";

const ADMIN_CSS = `
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",Helvetica,Arial,sans-serif;background:#f5f7fa;min-height:100vh;color:#222}
.app-layout{display:flex;min-height:100vh}
.sidebar{width:260px;background:linear-gradient(180deg,#ff6b9d 0%,#ff8c5a 100%);color:#fff;padding:24px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;box-sizing:border-box}
.sidebar h1{font-size:20px;font-weight:700;margin:0 0 4px}
.sidebar .ver{color:rgba(255,255,255,.7);font-size:12px;margin-bottom:24px}
.sidebar nav{display:flex;flex-direction:column;gap:2px;flex:1}
.sidebar .nav-item{color:#fff;text-decoration:none;padding:12px 16px;border-radius:12px;font-size:14px;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:10px}
.sidebar .nav-item:hover{background:rgba(255,255,255,.15)}
.sidebar .nav-item.active{background:rgba(255,255,255,.25);font-weight:600}
.sidebar .nav-icon{font-size:16px;width:20px;text-align:center}
.sidebar .password-box{background:rgba(0,0,0,.12);border-radius:12px;padding:14px;margin-top:16px}
.sidebar .password-box label{font-size:12px;color:rgba(255,255,255,.85);display:block;margin-bottom:8px}
.sidebar .password-box input{width:100%;border:0;background:rgba(255,255,255,.95);border-radius:8px;padding:8px 10px;font-size:13px;box-sizing:border-box;color:#222}
.sidebar .password-box input:focus{outline:none;background:#fff}
.sidebar .logout-btn{margin-top:10px;width:100%;background:rgba(255,255,255,.9);color:#ff6b9d;border:0;padding:10px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer}
.main-content{flex:1;padding:28px 36px;overflow-y:auto;box-sizing:border-box}
.card{background:#fff;border-radius:18px;padding:28px;margin-bottom:18px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
.card h2{font-size:18px;margin:0 0 6px;color:#222}
.card .desc{color:#888;font-size:13px;margin-bottom:20px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:12px}
.stat-item{background:#f8f9fc;border-radius:12px;padding:14px}
.stat-label{font-size:12px;color:#888;margin-bottom:6px}
.stat-value{font-size:18px;font-weight:700;color:#222}
.btn{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff;border:0;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.btn:hover{opacity:.9}
.btn:active{transform:scale(.98)}
.btn.secondary{background:#f3f3f7;color:#555}
.btn.secondary:hover{background:#e8e8ef}
.input{width:100%;border:1px solid #e0e0e5;border-radius:10px;padding:10px 14px;font-size:14px;box-sizing:border-box;font-family:inherit}
.input:focus{outline:none;border-color:#ff6b9d;box-shadow:0 0 0 3px rgba(255,107,157,.1)}
textarea.input{resize:vertical;min-height:80px;line-height:1.6}
label{font-size:13px;color:#555;display:block;margin-bottom:6px}
.field{margin-bottom:16px}
.chat-box{background:#f8f9fc;border-radius:14px;padding:16px;min-height:240px;max-height:400px;overflow-y:auto;margin-bottom:12px}
.msg{margin:10px 0;display:flex}
.msg.u{justify-content:flex-end}
.msg.b{justify-content:flex-start}
.msg .bubble{padding:10px 16px;border-radius:16px;max-width:80%;font-size:14px;line-height:1.5}
.msg.u .bubble{background:linear-gradient(135deg,#ff6b9d,#ff8c5a);color:#fff}
.msg.b .bubble{background:#fff;border:1px solid #e8eaef;color:#222}
.chat-input{display:flex;gap:10px}
.chat-input input{flex:1}
.result-box{background:#f8f9fc;border-radius:10px;padding:12px;font-family:SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:#444;margin-top:12px;white-space:pre-wrap;word-break:break-word}
.notice{background:#fff4e5;border:1px solid #ffd54f;border-radius:12px;padding:14px;font-size:13px;color:#8a6400;margin-bottom:16px;line-height:1.6}
.notice code{background:#fff8dc;padding:2px 6px;border-radius:4px;font-size:12px}
@media(max-width:768px){.app-layout{flex-direction:column}.sidebar{width:auto;height:auto;position:relative}.main-content{padding:16px}}
`;

const ADMIN_SCRIPT = `
import { createApp, ref, reactive, onMounted, onUnmounted } from "vue";
createApp({
  setup() {
    const activeSection = ref("status");
    const password = ref("");
    const status = reactive({ loggedIn: false, polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "从未", lastLatencyMs: "—" });
    const config = reactive({ aiModel: "", aiSystemPrompt: "" });
    const configResult = ref("");
    const chatMessages = ref([]);
    const chatInput = ref("");
    const pollResult = ref("");
    const isPolling = ref(false);
    let refreshTimer = null;
    const sections = [
      { key: "status", label: "状态监控", icon: "📊" },
      { key: "control", label: "消息控制", icon: "🎮" },
      { key: "config", label: "系统配置", icon: "⚙️" },
      { key: "chat", label: "AI 测试", icon: "🤖" },
    ];
    function withPwd(p){ return password.value ? p + (p.includes("?") ? "&" : "?") + "pwd=" + encodeURIComponent(password.value) : p; }
    async function refreshStatus() {
      try {
        const res = await fetch(withPwd("/api/status"));
        const d = await res.json();
        status.loggedIn = !!d.loggedIn;
        status.polls = d.stats?.polls || 0;
        status.handled = d.stats?.handled || 0;
        status.aiCalls = d.stats?.aiCalls || 0;
        status.aiFails = d.stats?.aiFails || 0;
        status.lastPollAt = d.stats?.lastPollAt ? new Date(d.stats.lastPollAt).toLocaleString() : "从未";
        status.lastLatencyMs = d.stats?.lastLatencyMs == null ? "—" : d.stats.lastLatencyMs + " ms";
      } catch {}
    }
    async function triggerPoll() {
      isPolling.value = true; pollResult.value = "正在轮询...";
      try {
        const res = await fetch(withPwd("/api/trigger-poll"), { method: "POST" });
        const d = await res.json();
        pollResult.value = "✅ 轮询完成\\n拉取: " + (d.pulled || 0) + " 条\\n回复: " + (d.handled || 0) + " 条\\n耗时: " + (d.latencyMs || 0) + "ms" + (d.error ? "\\n⚠️ " + d.error : "");
        refreshStatus();
      } catch (e) { pollResult.value = "❌ 失败: " + e.message; }
      finally { isPolling.value = false; }
    }
    async function loadConfig() {
      configResult.value = "加载中...";
      try {
        const res = await fetch(withPwd("/api/config"));
        const d = await res.json();
        config.aiModel = d.aiModel || ""; config.aiSystemPrompt = d.aiSystemPrompt || "";
        configResult.value = "✅ 已加载当前配置";
      } catch (e) { configResult.value = "❌ 加载失败: " + e.message; }
    }
    async function saveConfig() {
      configResult.value = "保存中...";
      try {
        const res = await fetch(withPwd("/api/config"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
        const d = await res.json();
        if (d.ok) configResult.value = "✅ 配置已保存！下次消息将使用新配置";
        else configResult.value = "❌ " + (d.error || "保存失败");
      } catch (e) { configResult.value = "❌ 保存失败: " + e.message; }
    }
    async function sendChat() {
      const q = chatInput.value.trim(); if (!q) return;
      chatMessages.value.push({ role: "u", text: q }); chatInput.value = "";
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: q }) });
        const d = await res.json();
        chatMessages.value.push({ role: "b", text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : "") });
      } catch (e) { chatMessages.value.push({ role: "b", text: "错误: " + e.message }); }
    }
    async function logout() {
      if (!confirm("确认退出登录？退出后需重新扫码。")) return;
      try { await fetch(withPwd("/api/logout"), { method: "POST" }); } catch {}
      location.href = "/login";
    }
    onMounted(function(){ refreshStatus(); loadConfig(); refreshTimer = setInterval(refreshStatus, 30000); });
    onUnmounted(function(){ if (refreshTimer) clearInterval(refreshTimer); });
    return { activeSection, sections, password, status, config, configResult, chatMessages, chatInput, pollResult, isPolling, triggerPoll, loadConfig, saveConfig, sendChat, logout };
  },
  template: ADMIN_TEMPLATE
}).mount("#app");
`.replace("ADMIN_TEMPLATE", JSON.stringify(getAdminTemplate()));

function getAdminTemplate() {
  return `
    <div class="app-layout">
      <aside class="sidebar">
        <h1>🦞 ClawBot AI</h1>
        <div class="ver">v2.0 · bee-swarm arch</div>
        <nav>
          <div v-for="s in sections" :key="s.key" class="nav-item" :class="{ active: activeSection === s.key }" @click="activeSection = s.key">
            <span class="nav-icon">{{ s.icon }}</span><span>{{ s.label }}</span>
          </div>
        </nav>
        <div class="password-box">
          <label>🔐 管理员密码</label>
          <input v-model="password" type="password" placeholder="执行操作前填写"/>
          <button class="logout-btn" @click="logout">退出登录</button>
        </div>
      </aside>
      <main class="main-content">
        <section v-if="activeSection === 'status'">
          <div class="card">
            <h2>📊 实时状态</h2>
            <div class="desc">机器人运行状态、API 调用统计</div>
            <div class="stat-grid">
              <div class="stat-item"><div class="stat-label">登录状态</div><div class="stat-value">{{ status.loggedIn ? '✅ 在线' : '❌ 未登录' }}</div></div>
              <div class="stat-item"><div class="stat-label">累计轮询</div><div class="stat-value">{{ status.polls }}</div></div>
              <div class="stat-item"><div class="stat-label">累计处理</div><div class="stat-value">{{ status.handled }}</div></div>
              <div class="stat-item"><div class="stat-label">AI 调用</div><div class="stat-value">{{ status.aiCalls }}</div></div>
              <div class="stat-item"><div class="stat-label">AI 失败</div><div class="stat-value">{{ status.aiFails }}</div></div>
              <div class="stat-item"><div class="stat-label">上次耗时</div><div class="stat-value">{{ status.lastLatencyMs }}</div></div>
            </div>
            <div style="margin-top:16px;font-size:13px;color:#888">最后轮询: {{ status.lastPollAt }}</div>
          </div>
        </section>
        <section v-if="activeSection === 'control'">
          <div class="card">
            <h2>🎮 消息控制</h2>
            <div class="desc">手动触发消息拉取，测试微信消息流</div>
            <div style="display:flex;gap:10px;align-items:center">
              <button class="btn" :disabled="isPolling" @click="triggerPoll">{{ isPolling ? '轮询中...' : '🔄 立即拉取消息' }}</button>
            </div>
            <div v-if="pollResult" class="result-box">{{ pollResult }}</div>
            <div class="notice" style="margin-top:20px">💡 <strong>提示：</strong>手动轮询适合测试场景。生产环境建议在 wrangler.toml 中配置 cron 触发器，每 2 分钟自动拉取一次消息。</div>
          </div>
        </section>
        <section v-if="activeSection === 'config'">
          <div class="card">
            <h2>⚙️ 系统配置</h2>
            <div class="desc">配置 AI 模型和人设提示词，保存后即时生效</div>
            <div class="field"><label>AI 模型</label><input class="input" v-model="config.aiModel" placeholder="@cf/meta/llama-3-8b-instruct"/><div style="font-size:12px;color:#888;margin-top:6px">留空使用默认模型。支持 Cloudflare Worker AI 系列模型</div></div>
            <div class="field"><label>人设提示词 (system prompt)</label><textarea class="input" v-model="config.aiSystemPrompt" placeholder="你是爪爪，一个友好的 AI 助手..."></textarea><div style="font-size:12px;color:#888;margin-top:6px">定义机器人的性格和行为。留空使用默认人设</div></div>
            <div style="display:flex;gap:10px;margin-top:16px"><button class="btn secondary" @click="loadConfig">📥 加载当前配置</button><button class="btn" @click="saveConfig">💾 保存配置</button></div>
            <div v-if="configResult" class="result-box">{{ configResult }}</div>
          </div>
        </section>
        <section v-if="activeSection === 'chat'">
          <div class="card">
            <h2>🤖 AI 测试聊天</h2>
            <div class="desc">直接与 AI 对话，测试回复效果和配置</div>
            <div class="chat-box">
              <div v-if="chatMessages.length === 0" style="text-align:center;color:#aaa;padding:40px 20px">👋 开始输入你的问题吧...</div>
              <div v-for="(msg, i) in chatMessages" :key="i" class="msg" :class="msg.role"><div class="bubble">{{ msg.text }}</div></div>
            </div>
            <div class="chat-input"><input class="input" v-model="chatInput" placeholder="输入消息..." @keyup.enter="sendChat"/><button class="btn" @click="sendChat">发送</button></div>
            <div class="notice" style="margin-top:16px">💬 <strong>提示：</strong>常见问候语使用本地快捷回复（零 Token 消耗），其他消息走 Cloudflare Worker AI 模型。</div>
          </div>
        </section>
      </main>
    </div>
  `;
}
