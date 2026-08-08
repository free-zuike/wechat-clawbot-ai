<template>
  <div class="app-layout">
    <aside class="sidebar">
      <h1>🦞 ClawBot AI</h1>
      <div class="version">v2.0</div>
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
              v-for="(msg, i) in mergedMessages"
              :key="i"
              style="padding: 10px 14px; border-bottom: 1px solid var(--border-light); font-size: 13px"
            >
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
                <span style="font-weight: 600; color: var(--link)">📩 {{ msg.data?.fromUserId || (msg.type === 'media_generated' ? '🎨 媒体生成' : '未知') }}</span>
                <span style="color: var(--text-dim); font-size: 12px">{{ msg.data?.timestamp || msg.timestamp || '' }}</span>
              </div>
              <div v-if="msg.type === 'media_generated' && msg.url && !msg.data?.replyContent" style="margin-top: 4px">
                <div style="color: var(--text-dim); margin-bottom: 4px">{{ msg.mediaType === 'video' ? '🎬' : '🎨' }} {{ msg.provider || '' }} · {{ msg.model || '' }}</div>
                <img v-if="msg.mediaType !== 'video'" :src="msg.url" style="max-width: 100%; max-height: 300px; border-radius: 8px" />
                <video v-else :src="msg.url" controls style="max-width: 100%; max-height: 300px; border-radius: 8px"></video>
              </div>
              <div v-else-if="msg.data?.content || msg.data" style="color: var(--text-primary)">{{ msg.data?.content || msg.data }}</div>
              <div v-if="msg.data?.replyContent" style="color: var(--success); margin-top: 4px; padding: 6px 8px; background: var(--alert-success-bg); border-radius: 4px">
                💬 {{ msg.data.replyContent }}
              </div>
              <div v-if="msg._media" style="margin-top: 6px">
                <div style="color: var(--text-dim); font-size: 12px; margin-bottom: 4px">{{ msg._media.mediaType === 'video' ? '🎬' : '🎨' }} {{ msg._media.provider || '' }} · {{ msg._media.model || '' }}</div>
                <img v-if="msg._media.mediaType !== 'video'" :src="msg._media.url" style="max-width: 100%; max-height: 300px; border-radius: 8px" />
                <video v-else :src="msg._media.url" controls style="max-width: 100%; max-height: 300px; border-radius: 8px"></video>
              </div>
              <div v-if="msg._error" style="color: var(--error); margin-top: 4px; padding: 6px 8px; background: var(--alert-error-bg); border-radius: 4px">
                ❌ {{ msg._error }}
              </div>
              <div v-if="msg.type === 'media_error'" style="color: var(--error); margin-top: 4px; padding: 6px 8px; background: var(--alert-error-bg); border-radius: 4px">
                ❌ {{ msg.message || '生成失败' }}
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
          @save="debouncedSaveConfig"
        />
      </section>

      <section v-if="activeSection === 'chat'">
        <ChatPanel
          :messages="chatMessages"
          :input="chatInput"
          :loading="chatLoading"
          :quote-text="chatQuoteText"
          @send="handleSendChat"
          @update:input="(v: string) => chatInput = v"
          @resend="(text: string) => { chatInput = text; handleSendChat(); }"
          @edit="(idx: number, newText: string) => handleEditChat(idx, newText)"
          @quote="(text: string) => chatQuoteText = text"
          @clear-quote="chatQuoteText = ''"
          @clear-chat="chatMessages = []"
          @delete-msg="(idx: number) => chatMessages.splice(idx, 1)"
        />
      </section>

      <section v-if="activeSection === 'templates'">
        <TemplatesPanel @send="(content: string) => { activeSection = 'chat'; chatInput = content; }" />
      </section>
      <section v-if="activeSection === 'videos'">
        <PendingVideosPanel :customProviders="config.aiCustomProviders" />
      </section>
      <section v-if="activeSection === 'logs'">
        <GenerationLogsPanel />
      </section>
      <section v-if="activeSection === 'mcp'">
        <MCPServerPanel />
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import {
  fetchStatus, fetchConfig, saveConfig, triggerPoll, logout, chat,
  checkLogin, debugLogin,
  fetchHealth, getQRCode, getQRCodeStatus, ApiError,
} from "../api";
import QRCode from "qrcode";
import StatusPanel from "../components/admin/StatusPanel.vue";
import ConfigPanel from "../components/admin/ConfigPanel.vue";
import ChatPanel from "../components/admin/ChatPanel.vue";
import TemplatesPanel from "../components/admin/TemplatesPanel.vue";
import TaskPanel from "../components/admin/TaskPanel.vue";
import PendingVideosPanel from "../components/admin/PendingVideosPanel.vue";
import GenerationLogsPanel from "../components/admin/GenerationLogsPanel.vue";
import MCPServerPanel from "../components/admin/MCPServerPanel.vue";

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
  { key: "templates", label: "消息模板", icon: "📋" },
  { key: "videos", label: "视频任务", icon: "🎬" },
  { key: "logs", label: "生成记录", icon: "📝" },
  { key: "mcp", label: "MCP 服务", icon: "🔌" },
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
const config = reactive({ version: 0, aiProvider: "cloudflare", aiModel: "", aiImageModel: "@cf/black-forest-labs/flux-1-schnell", aiVideoModel: "bytedance/seedance-2.0-fast", aiBaseUrl: "", aiApiKey: "", aiMaxTokens: 1024, aiMaxContextChars: 12000, aiSystemPrompt: "", aiMaxRetries: 2, aiThinking: false, webhookEnabled: false, webhookUrl: "", webhookTitle: "", webhookApiKey: "", webhookChannels: [] as string[], aiCustomProviders: [] as Array<{ id: string; name: string; icon: string }>, aiPresets: [] as Array<{ id: string; model: string; imageModel: string; videoModel: string; baseUrl: string; apiKey: string; apiKeys: string[]; maxTokens: number; maxContextChars?: number }> });
const configResult = ref("");
const configSaving = ref(false);

// ===== Chat =====
const chatMessages = ref<Array<{ role: string; text: string }>>([]);
const chatInput = ref("");
const chatQuoteText = ref("");
const chatLoading = ref(false);

// 加载聊天记录（从后端 KV）
async function loadChatMessages() {
  try {
    const resp = await fetch("/api/chat-messages", {
      headers: { Authorization: `Bearer ${localStorage.getItem("clawbot_auth") || ""}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.messages) chatMessages.value = data.messages;
    }
  } catch {}
}

// 保存聊天记录到后端 D1
async function saveChatMessages() {
  try {
    const resp = await fetch("/api/chat-messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${localStorage.getItem("clawbot_auth") || ""}`,
      },
      body: JSON.stringify({ messages: chatMessages.value.slice(-100) }),
    });
    if (!resp.ok) console.error("Save chat failed:", resp.status);
  } catch (e) { console.error("Save chat error:", e); }
}

// 聊天记录自动保存到后端
watch(chatMessages, () => { saveChatMessages(); }, { deep: true });

// ===== QR =====
const qrCode = ref(""); const qrImage = ref(""); const qrStatus = ref("");
const qrLoading = ref(false); const qrCodeBound = ref(false);
let qrPollTimer: number | null = null;

// ===== Poll =====
const pollResult = ref(""); const isPolling = ref(false);

// ===== WebSocket =====
const wsConnected = ref(false); const wsMessages = ref<Array<{ type: string; data: any }>>([]);
let ws: WebSocket | null = null; let wsRetryCount = 0;

// 合并实时消息：将 media_generated 附加到相邻的 message 上，跳过 chat 来源
const mergedMessages = computed(() => {
  const result: Array<{ type: string; data: any; _media?: { url: string; mediaType: string; model?: string; provider?: string }; _error?: string }> = [];
  for (let i = 0; i < wsMessages.value.length; i++) {
    const msg = wsMessages.value[i];
    // AI测试来源的媒体/错误不显示在实时消息区
    if ((msg.type === "media_generated" || msg.type === "media_error") && msg.source === "chat") continue;
    if (msg.type === "media_generated" && msg.url) {
      // 向前合并：如果前一条是 message，附加到前一条
      if (result.length > 0 && result[result.length - 1].type === "message" && result[result.length - 1].data?.replyContent) {
        result[result.length - 1]._media = { url: msg.url, mediaType: msg.mediaType, model: msg.model, provider: msg.provider };
        continue;
      }
      // 向后合并：如果后一条是 message，附加到后一条
      if (i + 1 < wsMessages.value.length && wsMessages.value[i + 1].type === "message" && wsMessages.value[i + 1].data?.replyContent) {
        const nextMsg = { ...wsMessages.value[i + 1] };
        nextMsg._media = { url: msg.url, mediaType: msg.mediaType, model: msg.model, provider: msg.provider };
        result.push(nextMsg);
        i++; // 跳过下一条 message
        continue;
      }
      // 无相邻 message，保留为独立条目
      result.push({ ...msg });
      continue;
    }
    if (msg.type === "media_error") {
      // 错误通知：向后合并到 message，或独立显示
      if (result.length > 0 && result[result.length - 1].type === "message" && result[result.length - 1].data?.replyContent) {
        result[result.length - 1]._error = msg.message;
        continue;
      }
      result.push({ ...msg });
      continue;
    }
    result.push({ ...msg });
  }
  return result;
});

// ===== Debug =====
const debugInfo = ref(""); const debugLoading = ref(false);

// ===== Accounts =====
const accountsList = ref<Array<{ accountId: string; baseUrl: string; lastPollAt: string; pollLoopRunning: boolean }>>([]);

// ===== Health =====
const healthData = reactive({
  kv: "—", loggedIn: false, totalPolls: 0, totalHandled: 0, totalAICalls: 0, totalAIFails: 0,
  timestamp: "",
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
let saveTimer: number | null = null;
function debouncedSaveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { handleSaveConfig(); }, 300);
}

async function handleLoadConfig() {
  configResult.value = "加载中...";
  try {
    const d = await fetchConfig(); if (d === null) return;
    config.version = d.version || 0;
    config.aiProvider = d.aiProvider || "cloudflare"; config.aiModel = d.aiModel || "";
    config.aiImageModel = d.aiImageModel || "@cf/black-forest-labs/flux-1-schnell";
    config.aiVideoModel = d.aiVideoModel || "";
    config.aiBaseUrl = d.aiBaseUrl || ""; config.aiApiKey = d.aiApiKey || "";
    config.aiMaxTokens = d.aiMaxTokens || 1024;     config.aiMaxContextChars = d.aiMaxContextChars || 12000;     config.aiSystemPrompt = d.aiSystemPrompt || "";
    config.aiMaxRetries = d.aiMaxRetries ?? 2;
    config.aiThinking = d.aiThinking || false;
    config.webhookEnabled = d.webhookEnabled || false;
    config.webhookUrl = d.webhookUrl || "";
    config.webhookTitle = d.webhookTitle || "";
    config.webhookApiKey = d.webhookApiKey || "";
    config.webhookChannels = d.webhookChannels || [];
    config.aiCustomProviders = d.aiCustomProviders || [];
    config.aiPresets = d.aiPresets || [];
    if (config.aiCustomProviders.length === 0 && config.aiPresets.length > 0) {
      config.aiCustomProviders = config.aiPresets.map((p: any) => ({
        id: p.id, name: p.name || p.id.replace("custom_", "提供商 "), icon: "🤖",
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
      configResult.value = "✅" + (d.message || "配置已保存");
      await handleLoadConfig();
    }
    else if (d.error === "CONFLICT") {
      configResult.value = "⚠️ " + (d.message || "配置已被其他人修改，正在重新加载...");
      await handleLoadConfig();
    }
    else if (d.error === "VALIDATION_ERROR") configResult.value = "⚠️ 验证失败: " + (d.message || "请检查配置项");
    else configResult.value = "❌" + (d.error || "保存失败");
  } catch (e: any) {
    if (e instanceof ApiError && e.isAuthError) {
      configResult.value = "❌ 登录已过期，请刷新页面重新登录";
    } else {
      configResult.value = "❌ 保存失败: " + handleApiError(e, "保存失败");
    }
  } finally { configSaving.value = false; }
}

// ===== Chat =====
async function handleSendChat() {
  const q = chatInput.value.trim(); if (!q || chatLoading.value) return;
  const fullMessage = chatQuoteText.value ? `[引用] ${chatQuoteText.value}\n\n${q}` : q;
  chatMessages.value.push({ role: "u", text: q }); chatInput.value = ""; chatQuoteText.value = ""; chatLoading.value = true;
  try {
    const d = await chat(fullMessage);
    if (d === null) { chatLoading.value = false; return; }
    chatMessages.value.push({ role: "b", text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : "") });
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) { chatLoading.value = false; return; }
    chatMessages.value.push({ role: "b", text: "错误: " + handleApiError(e, "AI 回复失败") });
  } finally { chatLoading.value = false; }
}

// ===== Chat Edit: 修改用户消息并重新发送 =====
function handleEditChat(idx: number, newText: string) {
  if (idx < 0 || idx >= chatMessages.value.length) return;
  // 找到对应的用户消息，删除后续的 bot 回复
  chatMessages.value.splice(idx);
  // 设置新的输入并发送
  chatMessages.value.push({ role: "u", text: newText });
  chatInput.value = "";
  chatLoading.value = true;
  chat(newText).then(d => {
    if (d) chatMessages.value.push({ role: "b", text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : "") });
  }).catch(e => {
    chatMessages.value.push({ role: "b", text: "错误: " + handleApiError(e, "AI 回复失败") });
  }).finally(() => { chatLoading.value = false; });
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
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "connected") return;
      wsMessages.value.push(msg);
      if (wsMessages.value.length > 200) wsMessages.value.shift();
      // Queue 生成的图片/视频 → 添加到 AI 测试聊天区（chat 来源）或实时消息区（微信来源）
      if (msg.type === "media_generated" && msg.url) {
        if (msg.source === "chat") {
          const icon = msg.mediaType === "video" ? "🎬" : "🎨";
          const modelInfo = `${msg.provider || "unknown"} · ${msg.model || "unknown"}`;
          const quoteText = msg.prompt ? `<blockquote>${msg.prompt}</blockquote>\n` : "";
          chatMessages.value.push({
            role: "b",
            text: `${quoteText}${icon} ${modelInfo}\n\n${msg.mediaType === "video" ? "视频已生成！" : "图片已生成！"}\n\n${msg.mediaType === "video" ? `<video src="${msg.url}" controls style="max-width:100%;border-radius:8px"></video>` : `![生成的图片](${msg.url})`}`,
          });
        }
        // 微信来源的已在 mergedMessages 实时消息区显示
      }
      // 生成失败通知
      if (msg.type === "media_error") {
        if (msg.source === "chat") {
          chatMessages.value.push({ role: "b", text: `❌ ${msg.message || "生成失败"}` });
        } else {
          wsMessages.value.push({ type: "media_error", message: msg.message || "生成失败", source: msg.source, timestamp: new Date().toLocaleString() });
        }
      }
    } catch {}
  };
}

// ===== Debug =====
async function handleDebug() {
  debugLoading.value = true; debugInfo.value = "诊断中...";
  try { const d = await debugLogin(); debugInfo.value = JSON.stringify(d, null, 2); }
  catch (e: any) { debugInfo.value = "错误: " + handleApiError(e, "诊断失败"); } finally { debugLoading.value = false; }
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
  handleRefreshStatus(); handleLoadConfig(); connectWebSocket(); loadChatMessages();
  async function tick() { try { await handleRefreshStatus(); } finally { refreshTimer = window.setTimeout(tick, 30000); } }
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
