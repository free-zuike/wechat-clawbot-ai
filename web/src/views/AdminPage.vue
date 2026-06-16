<template>
  <div class="app-layout">
    <aside class="sidebar">
      <h1>🦞 ClawBot AI</h1>
      <div class="version">v2.0 · bee-swarm arch</div>
      <nav>
        <div
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: activeSection === item.key }"
          @click="activeSection = item.key"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </div>
      </nav>
      <button class="theme-toggle" @click="toggleTheme">{{ isDark ? '☀️ 亮色模式' : '🌙 暗色模式' }}</button>
      <div style="margin-top:12px;padding:10px 12px;background:rgba(255,255,255,0.15);border-radius:10px;font-size:12px;color:rgba(255,255,255,0.9);line-height:1.6">
        💡 微信 iLink Token 有效期较短，提示未登录时请重新扫码
      </div>
      <button class="logout-btn" @click="handleLogout">退出登录</button>
    </aside>

    <main class="main-content">
      <section v-if="activeSection === 'status'">
        <StatusPanel
          :status="status"
          :health="healthData"
          :loading="statusLoading"
          :debug-info="debugInfo"
          :debug-loading="debugLoading"
          @debug="handleDebug"
        />
      </section>

      <section v-if="activeSection === 'control'">
        <TaskPanel
          :status="status"
          :bound="qrCodeBound"
          :accounts="accountsList"
          :is-polling="isPolling"
          :poll-result="pollResult"
          :ws-connected="wsConnected"
          :ws-messages="wsMessages"
          :qr-image="qrImage"
          :qr-status="qrStatus"
          :qr-loading="qrLoading"
          @trigger-poll="handleTriggerPoll"
          @get-q-r="handleGetQRCode"
          @reset-q-r="resetQR"
          @unbind="(id: string) => handleUnbindWeChatById(id)"
          @clear-messages="wsMessages = []"
        />
        <!-- WebSocket 实时消息列表 -->
        <div v-if="wsMessages.length > 0" class="card" style="margin-top: 16px">
          <h2>📡 实时消息 ({{ wsMessages.length }})</h2>
          <div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: 8px">
            <div
              v-for="(msg, i) in wsMessages"
              :key="i"
              style="padding: 10px 14px; border-bottom: 1px solid var(--border-light); font-size: 13px"
            >
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                <span style="font-weight: 600; color: var(--link)">📩 {{ msg.data?.fromUserId || '未知' }}</span>
                <span style="color: var(--text-dim); font-size: 12px">{{ msg.data?.timestamp || '' }}</span>
              </div>
              <div style="color: var(--text-primary)">{{ msg.data?.content || msg.data }}</div>
              <div v-if="msg.data?.replyContent" style="color: var(--success); margin-top: 4px; padding: 6px 8px; background: var(--alert-success-bg); border-radius: 4px">
                💬 {{ msg.data.replyContent }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="activeSection === 'config'">
        <ConfigPanel
          :config="config"
          :result="configResult"
          :saving="configSaving"
          @load="handleLoadConfig"
          @save="handleSaveConfig"
        />
      </section>

      <section v-if="activeSection === 'chat'">
        <ChatPanel
          :messages="chatMessages"
          :input="chatInput"
          :loading="chatLoading"
          @send="handleSendChat"
          @update:input="(v: string) => chatInput = v"
        />
      </section>

      <section v-if="activeSection === 'alerts'">
        <AlertsPanel
          v-model:search-text="alertsSearch"
          v-model:level-filter="alertsLevelFilter"
          v-model:only-active="alertsOnlyActive"
          :items="alerts"
          :loading="alertsLoading"
          :summary="alertSummary"
          :page="alertsPage"
          :total-pages="alertsTotalPages"
          :total="alertsTotal"
          @refresh="handleRefreshAlerts"
          @resolve="handleResolveAlert"
          @resolve-all="handleResolveAllAlerts"
          @prev-page="alertsPage--; handleRefreshAlerts()"
          @next-page="alertsPage++; handleRefreshAlerts()"
        />
      </section>

      <section v-if="activeSection === 'sessions'">
        <SessionsPanel
          :items="sessions"
          :loading="sessionsLoading"
          :search="sessionsSearch"
          :page="sessionsPage"
          :total-pages="sessionsTotalPages"
          :total="sessionsTotal"
          @refresh="handleRefreshSessions"
          @prev-page="sessionsPage--; handleRefreshSessions()"
          @next-page="sessionsPage++; handleRefreshSessions()"
          @update:search="(v: string) => { sessionsSearch = v; sessionsPage = 1; }"
        />
      </section>

      <section v-if="activeSection === 'templates'">
        <TemplatesPanel @send="(content: string) => { activeSection = 'chat'; chatInput = content; }" />
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import {
  fetchStatus, fetchConfig, saveConfig, triggerPoll, logout, chat,
  checkLogin, debugLogin, fetchAlerts, resolveAlert, resolveAllAlerts,
  fetchSessions, fetchHealth, getQRCode, getQRCodeStatus, ApiError,
} from "../api";
import QRCode from "qrcode";
import StatusPanel from "../components/admin/StatusPanel.vue";
import ConfigPanel from "../components/admin/ConfigPanel.vue";
import ChatPanel from "../components/admin/ChatPanel.vue";
import AlertsPanel from "../components/admin/AlertsPanel.vue";
import SessionsPanel from "../components/admin/SessionsPanel.vue";
import TemplatesPanel from "../components/admin/TemplatesPanel.vue";
import TaskPanel from "../components/admin/TaskPanel.vue";

const router = useRouter();

// ===== Theme =====
const isDark = ref(localStorage.getItem("theme") === "dark");
function applyTheme() { document.documentElement.classList.toggle("dark", isDark.value); }
function toggleTheme() { isDark.value = !isDark.value; localStorage.setItem("theme", isDark.value ? "dark" : "light"); applyTheme(); }
applyTheme();

// ===== Nav =====
const navItems = [
  { key: "status", label: "状态监控", icon: "📊" },
  { key: "control", label: "操作面板", icon: "🎯" },
  { key: "config", label: "系统配置", icon: "⚙️" },
  { key: "chat", label: "AI 测试", icon: "🤖" },
  { key: "alerts", label: "报警中心", icon: "🚨" },
  { key: "sessions", label: "用户会话", icon: "💬" },
  { key: "templates", label: "消息模板", icon: "📋" },
];
const activeSection = ref("status");
let isFirstRefresh = true;
let refreshTimer: number | null = null;

// ===== Status =====
const status = reactive({
  loggedIn: false, tokenHealth: "", loginAgeText: "",
  polls: 0, handled: 0, aiCalls: 0, aiFails: 0, lastPollAt: "从未", lastLatencyMs: "—" as string | number,
});
const statusLoading = ref(false);
const firstLoadDone = ref(false);

// ===== Config =====
const config = reactive({ version: 0, aiProvider: "cloudflare", aiModel: "", aiBaseUrl: "", aiApiKey: "", aiMaxTokens: 1024, aiSystemPrompt: "", webhookEnabled: false, webhookUrl: "", webhookTitle: "", webhookApiKey: "", webhookChannels: [] as string[], aiCustomProviders: [] as Array<{ id: string; name: string; icon: string }>, aiPresets: [] as Array<{ id: string; model: string; baseUrl: string; apiKey: string; maxTokens: number }> });
const configResult = ref("");
const configSaving = ref(false);

// ===== Chat =====
const chatMessages = ref<Array<{ role: string; text: string }>>([]);
const chatInput = ref("");
const chatLoading = ref(false);

// ===== QR =====
const qrCode = ref(""); const qrImage = ref(""); const qrStatus = ref("");
const qrLoading = ref(false); const qrCodeBound = ref(false);
let qrPollTimer: number | null = null;

// ===== Poll =====
const pollResult = ref(""); const isPolling = ref(false);

// ===== WebSocket =====
const wsConnected = ref(false); const wsMessages = ref<Array<{ type: string; data: any }>>([]);
let ws: WebSocket | null = null; let wsRetryCount = 0;

// ===== Debug =====
const debugInfo = ref(""); const debugLoading = ref(false);

// ===== Alerts =====
const alerts = ref<any[]>([]); const alertsLoading = ref(false);
const alertsOnlyActive = ref(false); const alertsLevelFilter = ref("");
const alertsSearch = ref(""); const alertsPage = ref(1);
const alertsTotalPages = ref(1); const alertsTotal = ref(0);
const alertSummary = reactive({ total: 0, byLevel: { info: 0, warning: 0, error: 0, critical: 0 }, unresolved: 0 });

// ===== Sessions =====
const sessions = ref<any[]>([]); const sessionsLoading = ref(false);
const sessionsSearch = ref(""); const sessionsPage = ref(1);
const sessionsTotalPages = ref(1); const sessionsTotal = ref(0);

// ===== Accounts =====
const accountsList = ref<Array<{ accountId: string; baseUrl: string; lastPollAt: string; pollLoopRunning: boolean }>>([]);

// ===== Health =====
const healthData = reactive({
  kv: "—", loggedIn: false, totalPolls: 0, totalHandled: 0, totalAICalls: 0, totalAIFails: 0,
  unresolvedAlerts: 0, criticalAlerts: 0, errorAlerts: 0, warningAlerts: 0, timestamp: "",
});

// ===== Error handling =====
function handleApiError(error: unknown, defaultMessage: string): string {
  if (error instanceof ApiError) { if (error.isAuthError) { router.push("/login"); return "请先登录"; } return error.message; }
  if (error instanceof Error) return error.message;
  return defaultMessage;
}

// ===== Status refresh =====
async function handleRefreshStatus() {
  if (!firstLoadDone.value) statusLoading.value = true;
  try {
    let statusData: any = null;
    try { statusData = await fetchStatus(isFirstRefresh); } catch (e: any) { if (!(e instanceof ApiError && e.isCancelled)) console.error("状态API失败:", e); }
    if (statusData && statusData !== null) {
      status.loggedIn = !!statusData.loggedIn;
      status.tokenHealth = statusData.tokenHealth || "";
      status.loginAgeText = statusData.loginAgeText || "";
      status.polls = statusData.stats?.polls || 0;
      status.handled = statusData.stats?.handled || 0;
      status.aiCalls = statusData.stats?.aiCalls || 0;
      status.aiFails = statusData.stats?.aiFails || 0;
      status.lastPollAt = statusData.stats?.lastPollAt ? new Date(statusData.stats.lastPollAt).toLocaleString() : "从未";
      status.lastLatencyMs = statusData.stats?.lastLatencyMs == null ? "—" : statusData.stats.lastLatencyMs + " ms";
      qrCodeBound.value = !!statusData.hasBotCredentials;
      accountsList.value = statusData.accounts || [];
      healthData.kv = statusData.kv || "—";
      healthData.loggedIn = statusData.loggedIn;
      healthData.unresolvedAlerts = statusData.alerts?.unresolved || 0;
      healthData.criticalAlerts = statusData.alerts?.critical || 0;
      healthData.errorAlerts = statusData.alerts?.error || 0;
      healthData.warningAlerts = statusData.alerts?.warning || 0;
      healthData.timestamp = statusData.timestamp || new Date().toISOString();
      isFirstRefresh = false; firstLoadDone.value = true;
    }
  } catch (e: any) { console.error("状态刷新失败:", e); } finally { statusLoading.value = false; }
}

// ===== Poll =====
async function handleTriggerPoll() {
  isPolling.value = true; pollResult.value = "正在轮询...";
  try {
    const d = await triggerPoll();
    pollResult.value = `✅ 轮询完成\n拉取: ${d.pulled || 0} 条\n回复: ${d.handled || 0} 条\n耗时: ${d.latencyMs || 0}ms` + (d.error ? `\n⚠️ ${d.error}` : "");
    handleRefreshStatus();
  } catch (e: any) { pollResult.value = "❌ 失败: " + handleApiError(e, "轮询失败"); } finally { isPolling.value = false; }
}

// ===== Config =====
async function handleLoadConfig() {
  configResult.value = "加载中...";
  try {
    const d = await fetchConfig(); if (d === null) return;
    config.version = d.version || 0;
    config.aiProvider = d.aiProvider || "cloudflare"; config.aiModel = d.aiModel || "";
    config.aiBaseUrl = d.aiBaseUrl || ""; config.aiApiKey = d.aiApiKey || "";
    config.aiMaxTokens = d.aiMaxTokens || 1024;     config.aiSystemPrompt = d.aiSystemPrompt || "";
    config.webhookEnabled = d.webhookEnabled || false;
    config.webhookUrl = d.webhookUrl || "";
    config.webhookTitle = d.webhookTitle || "";
    config.webhookApiKey = d.webhookApiKey || "";
    config.webhookChannels = d.webhookChannels || [];
    config.aiCustomProviders = d.aiCustomProviders || [];
    // 加载预设数据（每个提供商独立配置）
    config.aiPresets = d.aiPresets || [];
    // 从旧的 aiPresets 迁移到 aiCustomProviders
    if (config.aiCustomProviders.length === 0 && config.aiPresets.length > 0) {
      config.aiCustomProviders = config.aiPresets.map((p: any) => ({
        id: p.id, name: p.name, icon: "🤖",
      }));
    }
    configResult.value = d.hasEnvOverride ? "✅ 已加载当前配置（注意：当前有环境变量覆盖）" : "✅ 已加载当前配置";
  } catch (e: any) { if (e instanceof ApiError && e.isCancelled) return; configResult.value = "❌ 加载失败: " + handleApiError(e, "加载失败"); }
}
async function handleSaveConfig() {
  configSaving.value = true; configResult.value = "保存中...";
  try {
    const d = await saveConfig({ ...config, _version: config.version });
    if (d.ok) {
      configResult.value = "✅ " + (d.message || "配置已保存");
      // 保存成功后重新加载配置，确保预设等数据同步
      await handleLoadConfig();
    }
    else if (d.error === "CONFLICT") configResult.value = "⚠️ " + (d.message || "配置已被其他人修改，请刷新后重试");
    else if (d.error === "VALIDATION_ERROR") configResult.value = "⚠️ 验证失败: " + (d.errors || []).join("; ");
    else configResult.value = "❌ " + (d.error || "保存失败");
  } catch (e: any) { configResult.value = "❌ 保存失败: " + handleApiError(e, "保存失败"); } finally { configSaving.value = false; }
}

// ===== Chat =====
async function handleSendChat() {
  const q = chatInput.value.trim(); if (!q || chatLoading.value) return;
  chatMessages.value.push({ role: "u", text: q }); chatInput.value = ""; chatLoading.value = true;
  try {
    const d = await chat(q);
    if (d === null) { chatLoading.value = false; return; }
    chatMessages.value.push({ role: "b", text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : "") });
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) { chatLoading.value = false; return; }
    chatMessages.value.push({ role: "b", text: "错误: " + handleApiError(e, "AI 回复失败") });
  } finally { chatLoading.value = false; }
}

// ===== QR =====
async function handleGetQRCode() {
  qrLoading.value = true;
  try {
    const data = await getQRCode("");
    if (data.qrcode && data.qrcode_url) {
      qrCode.value = data.qrcode;
      qrImage.value = await QRCode.toDataURL(data.qrcode_url, { width: 200, margin: 2 });
      qrStatus.value = "等待扫码..."; pollQRStatus();
    }
  } catch (e: any) { qrStatus.value = "获取失败: " + (e.message || "未知错误"); } finally { qrLoading.value = false; }
}
async function pollQRStatus() {
  try {
    const data = await getQRCodeStatus("", qrCode.value);
    if (data.ok || data.status === "confirmed") { qrStatus.value = "绑定成功！"; qrCodeBound.value = true; qrCode.value = ""; qrImage.value = ""; handleRefreshStatus(); return; }
    if (data.status === "expired") { qrStatus.value = "二维码已过期，请重新获取"; return; }
    qrStatus.value = "等待扫码..."; qrPollTimer = window.setTimeout(pollQRStatus, 2000);
  } catch { qrPollTimer = window.setTimeout(pollQRStatus, 3000); }
}
function resetQR() { if (qrPollTimer) clearTimeout(qrPollTimer); qrCode.value = ""; qrImage.value = ""; qrStatus.value = ""; handleGetQRCode(); }
async function handleUnbindWeChat() {
  if (!confirm("确定要解绑微信吗？解绑后需要重新扫码绑定。")) return;
  try { await fetch("/api/unbind-wechat", { method: "POST" }); qrCodeBound.value = false; qrCode.value = ""; qrImage.value = ""; } catch (e: any) { alert("解绑失败: " + (e.message || "未知错误")); }
}
async function handleUnbindWeChatById(accountId: string) {
  try {
    await fetch("/api/unbind-wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    handleRefreshStatus();
  } catch (e: any) { alert("解绑失败: " + (e.message || "未知错误")); }
}

// ===== WebSocket =====
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws.onopen = () => { wsConnected.value = true; wsRetryCount = 0; };
  ws.onclose = () => { wsConnected.value = false; wsRetryCount++; setTimeout(connectWebSocket, Math.min(wsRetryCount * 3000, 30000)); };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = (e) => { try { const msg = JSON.parse(e.data); if (msg.type === "connected") return; wsMessages.value.push(msg); if (wsMessages.value.length > 200) wsMessages.value.shift(); } catch {} };
}

// ===== Debug =====
async function handleDebug() {
  debugLoading.value = true; debugInfo.value = "诊断中...";
  try { const d = await debugLogin(); debugInfo.value = JSON.stringify(d, null, 2); }
  catch (e: any) { debugInfo.value = "错误: " + handleApiError(e, "诊断失败"); } finally { debugLoading.value = false; }
}

// ===== Alerts =====
async function handleRefreshAlerts() {
  alertsLoading.value = true;
  try {
    const data = await fetchAlerts(alertsOnlyActive.value); if (data === null) return;
    if (data && data.alerts) {
      alerts.value = data.alerts; alertsTotal.value = data.total || 0; alertsTotalPages.value = data.totalPages || 1;
      if (data.summary) { alertSummary.total = data.summary.total || 0; alertSummary.unresolved = data.summary.unresolved || 0; alertSummary.byLevel = { info: data.summary.byLevel?.info || 0, warning: data.summary.byLevel?.warning || 0, error: data.summary.byLevel?.error || 0, critical: data.summary.byLevel?.critical || 0 }; }
    }
  } catch (e: any) { if (!(e instanceof ApiError && e.isCancelled)) console.error("刷新报警失败:", e); } finally { alertsLoading.value = false; }
}
async function handleResolveAlert(id: string) { try { const d = await resolveAlert(id); if (d.success) handleRefreshAlerts(); } catch (e: any) { console.error("解决报警失败:", e); } }
async function handleResolveAllAlerts() { if (!confirm("确认解决所有报警？")) return; try { const d = await resolveAllAlerts(); if (d.success) handleRefreshAlerts(); } catch (e: any) { console.error("解决所有报警失败:", e); } }

// ===== Sessions =====
async function handleRefreshSessions() {
  sessionsLoading.value = true;
  try {
    const data = await fetchSessions(50, sessionsPage.value, sessionsSearch.value); if (data === null) return;
    if (data && data.sessions) { sessions.value = data.sessions; sessionsTotal.value = data.total || 0; sessionsTotalPages.value = data.totalPages || 1; if (sessionsPage.value > sessionsTotalPages.value) sessionsPage.value = sessionsTotalPages.value || 1; }
  } catch (e: any) { if (!(e instanceof ApiError && e.isCancelled)) console.error("刷新会话失败:", e); } finally { sessionsLoading.value = false; }
}

// ===== Logout =====
async function handleLogout() {
  if (!confirm("确认退出登录？退出后需重新扫码。")) return;
  try { await logout(); } catch {} localStorage.removeItem("clawbot_auth"); window.location.href = "/login";
}

// ===== Lifecycle =====
onMounted(async () => {
  if (localStorage.getItem("clawbot_auth") === "ok") {} else {
    let loginOk = true; try { const d = await checkLogin(); if (!d.loggedIn) loginOk = false; } catch { loginOk = false; }
    if (!loginOk) { router.push("/login"); return; }
  }
  handleRefreshStatus(); handleLoadConfig(); handleRefreshAlerts(); handleRefreshSessions(); connectWebSocket();
  async function tick() { try { await handleRefreshStatus(); if (activeSection.value === "alerts") await handleRefreshAlerts(); } finally { refreshTimer = window.setTimeout(tick, 30000); } }
  refreshTimer = window.setTimeout(tick, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
});
</script>

<style scoped>
.alert-item { border: 1px solid var(--border-alert); border-radius: 8px; padding: 12px; margin-bottom: 8px; background: var(--bg-card); transition: background 0.3s; }
.alert-item.resolved { opacity: 0.6; background: var(--alert-resolved-bg); }
.alert-header { display: flex; align-items: center; gap: 10px; font-size: 13px; margin-bottom: 6px; }
.alert-level { padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.alert-level.info { background: var(--alert-info-bg); color: var(--alert-info-text); }
.alert-level.warning { background: var(--alert-warn-bg); color: var(--alert-warn-text); }
.alert-level.error { background: var(--alert-error-bg); color: var(--alert-error-text); }
.alert-level.critical { background: var(--alert-critical-bg); color: #fff; }
.alert-time { color: var(--text-muted); font-size: 12px; }
.alert-count { color: var(--text-muted); font-size: 12px; font-weight: 600; }
.alert-resolved { color: var(--success); font-size: 12px; margin-left: auto; }
.alert-message { font-size: 14px; color: var(--text-primary); margin-bottom: 4px; }
.alert-error { font-size: 12px; color: var(--text-muted); font-family: monospace; background: var(--bg-alert-error); padding: 6px; border-radius: 4px; margin-bottom: 4px; }
.alert-meta { font-size: 11px; color: var(--text-dim); display: flex; gap: 12px; }
.session-item { border: 1px solid var(--border-light); border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; background: var(--bg-card); transition: background 0.3s; }
.session-user { font-weight: 600; color: var(--text-primary); font-size: 14px; margin-bottom: 4px; word-break: break-all; }
.session-info { font-size: 12px; color: var(--text-muted); display: flex; gap: 16px; }
.btn-link { background: none; border: none; color: var(--link); cursor: pointer; font-size: 12px; padding: 2px 6px; margin-left: auto; }
.btn-link:hover { text-decoration: underline; }
.filter-bar { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-checkbox); cursor: pointer; }
.input.small { font-size: 13px; padding: 6px 10px; min-width: 150px; max-width: 300px; }
.btn.small { font-size: 12px; padding: 6px 12px; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 15px; margin-top: 16px; font-size: 13px; color: var(--text-muted); }
.empty-state { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }
.result-box.success { background: var(--alert-success-bg); color: var(--alert-success-text); border-color: var(--alert-success-text); }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.skeleton-item { height: 60px; background: linear-gradient(90deg, var(--bg-skeleton-1) 25%, var(--bg-skeleton-2) 50%, var(--bg-skeleton-1) 75%); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: 8px; }
@keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
