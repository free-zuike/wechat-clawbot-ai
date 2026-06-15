<template>
  <div class="app-layout">
    <!-- 侧边栏 -->
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

      <button class="theme-toggle" @click="toggleTheme">
        {{ isDark ? '☀️ 亮色模式' : '🌙 暗色模式' }}
      </button>

      <div style="margin-top:12px;padding:10px 12px;background:rgba(255,255,255,0.15);border-radius:10px;font-size:12px;color:rgba(255,255,255,0.9);line-height:1.6">
        💡 微信 iLink Token 有效期较短，提示未登录时请重新扫码
      </div>

      <button class="logout-btn" @click="handleLogout">退出登录</button>
    </aside>

    <!-- 主内容 -->
    <main class="main-content">
      <!-- 状态监控 -->
      <section v-if="activeSection === 'status'">
        <div class="card">
          <h2>📊 实时状态</h2>
          <div class="desc">机器人运行状态、系统健康度、API 调用统计</div>
          <div v-if="statusLoading" class="skeleton-grid">
            <div v-for="i in 10" :key="i" class="skeleton-item"></div>
          </div>
          <template v-else>
            <div class="stat-grid">
              <!-- 登录与健康 -->
              <div class="stat-item" :class="healthData.kv === 'OK' ? 'success' : 'error'">
                <div class="stat-label">KV 存储</div>
                <div class="stat-value">{{ healthData.kv === 'OK' ? '✅ 正常' : '❌ 异常' }}</div>
              </div>
              <div class="stat-item" :class="status.loggedIn ? 'success' : 'warning'">
                <div class="stat-label">登录状态</div>
                <div class="stat-value">{{ status.loggedIn ? "✅ 在线" : "❌ 未登录" }}</div>
              </div>
              <div class="stat-item" v-if="status.loginAgeText">
                <div class="stat-label">登录时长</div>
                <div class="stat-value">{{ status.loginAgeText }}</div>
              </div>
              <div class="stat-item" v-if="status.tokenHealth && status.tokenHealth !== 'unknown'">
                <div class="stat-label">Token 状态</div>
                <div class="stat-value">
                  <span v-if="status.tokenHealth === 'valid'" style="color:var(--success)">有效</span>
                  <span v-else-if="status.tokenHealth === 'expired'" style="color:var(--error)">已过期</span>
                  <span v-else-if="status.tokenHealth === 'error'" style="color:var(--warning)">检查失败</span>
                  <span v-else style="color:var(--text-muted)">未检测</span>
                </div>
              </div>

              <!-- 轮询与消息 -->
              <div class="stat-item">
                <div class="stat-label">累计轮询</div>
                <div class="stat-value">{{ status.polls.toLocaleString() }}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">累计处理</div>
                <div class="stat-value">{{ status.handled.toLocaleString() }}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">AI 调用</div>
                <div class="stat-value">{{ status.aiCalls.toLocaleString() }}</div>
              </div>
              <div class="stat-item" :class="{ warning: status.aiFails > 0 }">
                <div class="stat-label">AI 失败</div>
                <div class="stat-value">{{ status.aiFails.toLocaleString() }}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">上次耗时</div>
                <div class="stat-value">{{ status.lastLatencyMs }}</div>
              </div>

              <!-- 报警摘要 -->
              <div class="stat-item" :class="{ warning: (healthData.unresolvedAlerts || 0) > 0 }">
                <div class="stat-label">未解决报警</div>
                <div class="stat-value">{{ healthData.unresolvedAlerts || 0 }}</div>
              </div>
              <div class="stat-item" :class="{ error: (healthData.criticalAlerts || 0) > 0 }">
                <div class="stat-label">严重报警</div>
                <div class="stat-value">{{ healthData.criticalAlerts || 0 }}</div>
              </div>
            </div>

            <div style="margin-top: 16px; font-size: 13px; color: var(--text-secondary)">
              最后更新: {{ healthData.timestamp || status.lastPollAt || '—' }}
            </div>
            <div v-if="status.tokenHealth === 'expired'" style="margin-top:12px;padding:10px 14px;background:var(--alert-error-bg);border-radius:8px;font-size:13px;color:var(--error)">
              ⚠️ Token 已过期，需要重新扫码登录
            </div>
          </template>
        </div>

        <!-- 调试面板 -->
        <div class="card" style="margin-top:16px">
          <h2>🔧 登录诊断</h2>
          <div class="desc">查看登录凭证和 getUpdates 测试结果</div>
          <button class="btn secondary" :disabled="debugLoading" @click="handleDebug">
            {{ debugLoading ? "诊断中..." : "🔍 运行诊断" }}
          </button>
          <div v-if="debugInfo" style="margin-top: 12px">
            <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:8px;font-size:12px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all">{{ debugInfo }}</pre>
          </div>
        </div>
      </section>

      <!-- 消息控制 -->
      <section v-if="activeSection === 'control'">
        <!-- 微信绑定 -->
        <div class="card" style="margin-bottom: 16px">
          <h2>🔗 绑定微信</h2>
          <div class="desc">扫码绑定微信账号，绑定后可接收和回复消息</div>
          <div v-if="!qrCodeBound">
            <template v-if="!qrCode">
              <button class="btn" @click="handleGetQRCode" :disabled="qrLoading">
                {{ qrLoading ? "加载中..." : "📱 获取二维码" }}
              </button>
            </template>
            <template v-else>
              <div class="qr" v-if="qrImage">
                <img :src="qrImage" alt="QR Code" />
              </div>
              <div v-if="qrStatus" class="badge wait">{{ qrStatus }}</div>
              <button class="btn secondary" style="width:100%; margin-top:12px" @click="resetQR">重新获取</button>
            </template>
          </div>
          <div v-else style="padding:12px; background:var(--alert-success-bg); border-radius:8px; color:var(--success)">
            ✅ 微信已绑定
          </div>
        </div>

        <!-- 消息控制 -->
        <div class="card">
          <h2>🎮 消息控制</h2>
          <div class="desc">手动触发消息拉取 + 实时消息推送</div>
          <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 16px">
            <button class="btn" :disabled="isPolling" @click="handleTriggerPoll">
              {{ isPolling ? "轮询中..." : "🔄 立即拉取消息" }}
            </button>
            <span :style="{ color: wsConnected ? 'var(--success)' : 'var(--error)', fontSize: '13px' }">
              {{ wsConnected ? '🟢 实时连接已建立' : '🔴 未连接' }}
            </span>
          </div>
          <div v-if="pollResult" class="result-box">{{ pollResult }}</div>

          <!-- 实时消息列表 -->
          <div v-if="wsMessages.length > 0" style="margin-top: 20px">
            <h3 style="font-size: 14px; margin-bottom: 8px">📡 实时消息 ({{ wsMessages.length }})</h3>
            <div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: 8px">
              <div
                v-for="(msg, i) in wsMessages"
                :key="i"
                style="padding: 10px 14px; border-bottom: 1px solid var(--bg-alert-error); font-size: 13px"
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
            <button class="btn secondary small" style="margin-top: 8px" @click="wsMessages = []">清空消息</button>
          </div>

          <div class="notice" style="margin-top: 20px">
            💡 <strong>提示：</strong>实时消息通过 WebSocket 推送，无需手动刷新。手动轮询适合测试场景。
          </div>
        </div>
      </section>

      <!-- 系统配置 -->
      <section v-if="activeSection === 'config'">
        <div class="card">
          <h2>⚙️ 系统配置</h2>
          <div class="desc">配置 AI 提供商、模型和人设提示词</div>

          <div class="field">
            <label>AI 提供商</label>
            <select v-model="config.aiProvider" class="input">
              <option value="cloudflare">Cloudflare Workers AI</option>
              <option value="openai">OpenAI 兼容 API（DeepSeek/通义千问/Moonshot/智谱GLM 等）</option>
            </select>
          </div>

          <div class="field">
            <label>AI 模型</label>
            <input
              v-model="config.aiModel"
              class="input"
              :placeholder="config.aiProvider === 'openai' ? 'deepseek-chat / qwen-turbo / glm-4-flash' : '@cf/meta/llama-3-8b-instruct'"
            />
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
              {{ config.aiProvider === 'openai' ? '填写对应平台的模型名称' : '留空使用默认模型 @cf/meta/llama-3.2-3b-instruct' }}
            </div>
          </div>

          <template v-if="config.aiProvider === 'openai'">
            <div class="field">
              <label>API 地址</label>
              <input
                v-model="config.aiBaseUrl"
                class="input"
                placeholder="https://api.deepseek.com"
              />
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
                OpenAI 兼容接口地址，不要加 /v1/chat/completions 后缀
              </div>
            </div>

            <div class="field">
              <label>API 密钥</label>
              <input
                v-model="config.aiApiKey"
                class="input"
                type="password"
                placeholder="sk-..."
              />
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
                已有密钥时留空不修改，填写新密钥则覆盖
              </div>
            </div>

            <div class="field">
              <label>最大 Token 数</label>
              <input
                v-model.number="config.aiMaxTokens"
                class="input"
                type="number"
                min="1"
                max="32000"
                placeholder="1024"
              />
            </div>
          </template>

          <div class="field">
            <label>人设提示词 (system prompt)</label>
            <textarea
              v-model="config.aiSystemPrompt"
              class="input"
              placeholder="你是爪爪，一个友好的 AI 助手..."
              rows="8"
            ></textarea>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
              定义机器人的性格和行为。留空使用默认人设
            </div>
          </div>

          <div style="display: flex; gap: 10px; margin-top: 16px">
            <button class="btn secondary" @click="handleLoadConfig">📥 加载当前配置</button>
            <button class="btn" :disabled="configSaving" @click="handleSaveConfig">
              {{ configSaving ? "保存中..." : "💾 保存配置" }}
            </button>
          </div>
          <div v-if="configResult" :class="['result-box', configResult.includes('✅') ? 'success' : '']">
            {{ configResult }}
          </div>
        </div>
      </section>

      <!-- AI 测试 -->
      <section v-if="activeSection === 'chat'">
        <div class="card">
          <h2>🤖 AI 测试聊天</h2>
          <div class="desc">直接与 AI 对话，测试回复效果和配置</div>

          <div class="chat-box">
            <div
              v-if="chatMessages.length === 0"
              style="text-align: center; color: var(--text-dim); padding: 40px 20px"
            >
              👋 开始输入你的问题吧...
            </div>
            <div
              v-for="(msg, i) in chatMessages"
              :key="i"
              class="msg"
              :class="msg.role"
            >
              <div class="bubble">{{ msg.text }}</div>
            </div>
          </div>

          <div class="chat-input">
            <input
              v-model="chatInput"
              class="input"
              placeholder="输入消息..."
              :disabled="chatLoading"
              @keyup.enter="handleSendChat"
            />
            <button class="btn" :disabled="chatLoading || !chatInput.trim()" @click="handleSendChat">
              {{ chatLoading ? "发送中..." : "发送" }}
            </button>
          </div>

          <div class="notice" style="margin-top: 16px">
            💬 <strong>提示：</strong>常见问候语使用本地快捷回复（零 Token 消耗），其他消息走
            Cloudflare Worker AI 模型。
          </div>
        </div>
      </section>

      <!-- 报警中心 -->
      <section v-if="activeSection === 'alerts'">
        <div class="card">
          <h2>🚨 报警中心</h2>
          <div class="desc">系统错误报警和异常监控</div>

          <div v-if="alertsLoading" class="skeleton-grid">
            <div v-for="i in 5" :key="i" class="skeleton-item"></div>
          </div>

          <template v-else>
            <div class="stat-grid" style="margin-top:12px">
              <div class="stat-item">
                <div class="stat-label">总报警</div>
                <div class="stat-value">{{ alertSummary.total }}</div>
              </div>
              <div class="stat-item" style="color:var(--error)">
                <div class="stat-label">严重</div>
                <div class="stat-value">{{ alertSummary.byLevel?.critical || 0 }}</div>
              </div>
              <div class="stat-item" style="color:var(--warning)">
                <div class="stat-label">错误</div>
                <div class="stat-value">{{ alertSummary.byLevel?.error || 0 }}</div>
              </div>
              <div class="stat-item" style="color:var(--warning)">
                <div class="stat-label">警告</div>
                <div class="stat-value">{{ alertSummary.byLevel?.warning || 0 }}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">未解决</div>
                <div class="stat-value" :style="{color: alertSummary.unresolved > 0 ? 'var(--error)' : 'var(--success)'}">
                  {{ alertSummary.unresolved }}
                </div>
              </div>
            </div>

            <!-- 搜索 + 过滤 -->
            <div class="filter-bar">
              <input
                v-model="alertsSearch"
                class="input small"
                placeholder="🔍 搜索报警内容..."
                @input="handleRefreshAlerts"
              />
              <select v-model="alertsLevelFilter" class="input small" @change="handleRefreshAlerts">
                <option value="">所有级别</option>
                <option value="critical">严重</option>
                <option value="error">错误</option>
                <option value="warning">警告</option>
                <option value="info">信息</option>
              </select>
              <label class="checkbox-label">
                <input type="checkbox" v-model="alertsOnlyActive" @change="handleRefreshAlerts" />
                只看未解决
              </label>
              <button class="btn secondary small" @click="handleRefreshAlerts">🔄 刷新</button>
              <button
                class="btn secondary small"
                :disabled="alertSummary.unresolved === 0"
                @click="handleResolveAllAlerts"
              >
                ✅ 解决全部
              </button>
            </div>

            <!-- 报警列表 -->
            <div v-if="alerts.length === 0" class="empty-state">
              🎉 暂无报警记录
            </div>
            <div v-else>
              <div
                v-for="alert in alerts"
                :key="alert.id"
                class="alert-item"
                :class="{ resolved: alert.resolved }"
              >
                <div class="alert-header">
                  <span class="alert-level" :class="alert.level">
                    {{ getAlertLevelText(alert.level) }}
                  </span>
                  <span class="alert-time">{{ formatTime(alert.timestamp) }}</span>
                  <span v-if="alert.count > 1" class="alert-count">×{{ alert.count }}</span>
                  <span v-if="alert.resolved" class="alert-resolved">✅ 已解决</span>
                  <button v-else class="btn-link" @click="handleResolveAlert(alert.id)">解决</button>
                </div>
                <div class="alert-message">{{ alert.message }}</div>
                <div v-if="alert.error" class="alert-error">{{ alert.error }}</div>
                <div class="alert-meta">
                  <span v-if="alert.endpoint">端点: {{ alert.endpoint }}</span>
                </div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="alertsTotalPages > 1" class="pagination">
              <button
                class="btn secondary small"
                :disabled="alertsPage <= 1"
                @click="alertsPage--; handleRefreshAlerts()"
              >
                ← 上一页
              </button>
              <span>第 {{ alertsPage }} / {{ alertsTotalPages }} 页（共 {{ alertsTotal }} 条）</span>
              <button
                class="btn secondary small"
                :disabled="alertsPage >= alertsTotalPages"
                @click="alertsPage++; handleRefreshAlerts()"
              >
                下一页 →
              </button>
            </div>
          </template>
        </div>
      </section>

      <!-- 用户会话 -->
      <section v-if="activeSection === 'sessions'">
        <div class="card">
          <h2>💬 用户会话</h2>
          <div class="desc">查看所有活跃用户的对话记录</div>

          <div v-if="sessionsLoading" class="skeleton-grid">
            <div v-for="i in 5" :key="i" class="skeleton-item" style="grid-column: 1 / -1"></div>
          </div>

          <template v-else>
            <div class="filter-bar">
              <input
                v-model="sessionsSearch"
                class="input small"
                placeholder="🔍 搜索用户ID..."
                @input="sessionsPage = 1; handleRefreshSessions()"
              />
              <button class="btn secondary small" @click="handleRefreshSessions">🔄 刷新</button>
            </div>

            <div v-if="sessions.length === 0" class="empty-state">
              暂无会话记录
            </div>
            <div v-else>
              <div class="session-item" v-for="session in sessions" :key="session.from_user_id">
                <div class="session-user">👤 {{ session.from_user_id }}</div>
                <div class="session-info">
                  <span>📨 {{ session.message_count }} 条消息</span>
                  <span>🕒 {{ formatTime(session.last_message_at) }}</span>
                </div>
              </div>
            </div>

            <!-- 分页 -->
            <div v-if="sessionsTotalPages > 1" class="pagination">
              <button
                class="btn secondary small"
                :disabled="sessionsPage <= 1"
                @click="sessionsPage--; handleRefreshSessions()"
              >
                ← 上一页
              </button>
              <span>第 {{ sessionsPage }} / {{ sessionsTotalPages }} 页（共 {{ sessionsTotal }} 条）</span>
              <button
                class="btn secondary small"
                :disabled="sessionsPage >= sessionsTotalPages"
                @click="sessionsPage++; handleRefreshSessions()"
              >
                下一页 →
              </button>
            </div>
          </template>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import {
  fetchStatus,
  fetchConfig,
  saveConfig,
  triggerPoll,
  logout,
  chat,
  checkLogin,
  debugLogin,
  fetchAlerts,
  resolveAlert,
  resolveAllAlerts,
  fetchSessions,
  fetchHealth,
  ApiError,
} from "../api";

const router = useRouter();

// ===== 主题切换 =====
const isDark = ref(localStorage.getItem("theme") === "dark");

function applyTheme() {
  document.documentElement.classList.toggle("dark", isDark.value);
}

function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem("theme", isDark.value ? "dark" : "light");
  applyTheme();
}

applyTheme();

const navItems = [
  { key: "status", label: "状态监控", icon: "📊" },
  { key: "control", label: "消息控制", icon: "🎮" },
  { key: "config", label: "系统配置", icon: "⚙️" },
  { key: "chat", label: "AI 测试", icon: "🤖" },
  { key: "alerts", label: "报警中心", icon: "🚨" },
  { key: "sessions", label: "用户会话", icon: "💬" },
];

const activeSection = ref("status");
let isFirstRefresh = true;
let refreshTimer: number | null = null;

// ===== 状态数据 =====
const status = reactive({
  loggedIn: false,
  tokenHealth: "",
  loginAgeText: "",
  polls: 0,
  handled: 0,
  aiCalls: 0,
  aiFails: 0,
  lastPollAt: "从未",
  lastLatencyMs: "—",
});
const statusLoading = ref(false);

// ===== 配置数据 =====
const config = reactive({ aiProvider: "cloudflare", aiModel: "", aiBaseUrl: "", aiApiKey: "", aiMaxTokens: 1024, aiSystemPrompt: "" });
const configResult = ref("");
const configSaving = ref(false);

// ===== 聊天数据 =====
const chatMessages = ref<Array<{ role: string; text: string }>>([]);
const chatInput = ref("");
const chatLoading = ref(false);

// ===== QR码绑定 =====
import { getQRCode, getQRCodeStatus } from "../api";
import QRCode from "qrcode";

async function handleGetQRCode() {
  qrLoading.value = true;
  try {
    const data = await getQRCode("");
    if (data.qrcode && data.qrcode_url) {
      qrCode.value = data.qrcode;
      qrImage.value = await QRCode.toDataURL(data.qrcode_url, { width: 200, margin: 2 });
      qrStatus.value = "等待扫码...";
      pollQRStatus();
    }
  } catch (e: any) {
    qrStatus.value = "获取失败: " + (e.message || "未知错误");
  } finally {
    qrLoading.value = false;
  }
}

let qrPollTimer: number | null = null;
async function pollQRStatus() {
  try {
    const data = await getQRCodeStatus("", qrCode.value);
    if (data.ok || data.status === "confirmed") {
      qrStatus.value = "绑定成功！";
      qrCodeBound.value = true;
      return;
    }
    if (data.status === "expired") {
      qrStatus.value = "二维码已过期，请重新获取";
      return;
    }
    qrStatus.value = "等待扫码...";
    qrPollTimer = window.setTimeout(pollQRStatus, 2000);
  } catch (e: any) {
    qrPollTimer = window.setTimeout(pollQRStatus, 3000);
  }
}

function resetQR() {
  if (qrPollTimer) clearTimeout(qrPollTimer);
  qrCode.value = "";
  qrImage.value = "";
  qrStatus.value = "";
  handleGetQRCode();
}
const pollResult = ref("");
const isPolling = ref(false);

// ===== QR码绑定 =====
const qrCode = ref("");
const qrImage = ref("");
const qrStatus = ref("");
const qrLoading = ref(false);
const qrCodeBound = ref(false);

// ===== WebSocket 实时消息 =====
const wsConnected = ref(false);
const wsMessages = ref<Array<{ type: string; data: any }>>([]);
let ws: WebSocket | null = null;
let wsRetryCount = 0;

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws.onopen = () => { wsConnected.value = true; wsRetryCount = 0; };
  ws.onclose = () => {
    wsConnected.value = false;
    wsRetryCount++;
    const delay = Math.min(wsRetryCount * 3000, 30000);
    setTimeout(connectWebSocket, delay);
  };
  ws.onerror = () => { ws.close(); };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      wsMessages.value.push(msg);
      if (wsMessages.value.length > 200) wsMessages.value.shift();
    } catch {}
  };
}

// ===== 调试数据 =====
const debugInfo = ref("");
const debugLoading = ref(false);

// ===== 报警数据 =====
const alerts = ref<any[]>([]);
const alertsLoading = ref(false);
const alertsOnlyActive = ref(false);
const alertsLevelFilter = ref("");
const alertsSearch = ref("");
const alertsPage = ref(1);
const alertsTotalPages = ref(1);
const alertsTotal = ref(0);
const alertSummary = reactive({
  total: 0,
  byLevel: { info: 0, warning: 0, error: 0, critical: 0 },
  unresolved: 0,
});

// ===== 会话数据 =====
const sessions = ref<any[]>([]);
const sessionsLoading = ref(false);
const sessionsSearch = ref("");
const sessionsPage = ref(1);
const sessionsTotalPages = ref(1);
const sessionsTotal = ref(0);

// ===== 健康数据 =====
const healthData = reactive({
  kv: "—",
  loggedIn: false,
  totalPolls: 0,
  totalHandled: 0,
  totalAICalls: 0,
  totalAIFails: 0,
  unresolvedAlerts: 0,
  criticalAlerts: 0,
  errorAlerts: 0,
  warningAlerts: 0,
  timestamp: "",
});
const healthLoading = ref(false);

// ===== 通用错误处理 =====
function handleApiError(error: unknown, defaultMessage: string): string {
  if (error instanceof ApiError) {
    if (error.isAuthError) {
      router.push("/login");
      return "请先登录";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return defaultMessage;
}

// ===== 状态刷新 =====
const firstLoadDone = ref(false);

async function handleRefreshStatus() {
  if (!firstLoadDone.value) statusLoading.value = true;

  try {
    let statusData: any = null;

    try {
      statusData = await fetchStatus(isFirstRefresh);
    } catch (e: any) {
      if (!(e instanceof ApiError && e.isCancelled)) {
        console.error("状态API失败:", e);
      }
    }

    if (statusData && statusData !== null) {
      status.loggedIn = !!statusData.loggedIn;
      status.tokenHealth = statusData.tokenHealth || "";
      status.loginAgeText = statusData.loginAgeText || "";
      status.polls = statusData.stats?.polls || 0;
      status.handled = statusData.stats?.handled || 0;
      status.aiCalls = statusData.stats?.aiCalls || 0;
      status.aiFails = statusData.stats?.aiFails || 0;
      status.lastPollAt = statusData.stats?.lastPollAt
        ? new Date(statusData.stats.lastPollAt).toLocaleString()
        : "从未";
      status.lastLatencyMs = statusData.stats?.lastLatencyMs == null ? "—" : statusData.stats.lastLatencyMs + " ms";

      qrCodeBound.value = !!statusData.hasBotCredentials;

      healthData.kv = statusData.kv || "—";
      healthData.loggedIn = statusData.loggedIn;
      healthData.totalPolls = statusData.stats?.polls || 0;
      healthData.totalHandled = statusData.stats?.handled || 0;
      healthData.totalAICalls = statusData.stats?.aiCalls || 0;
      healthData.totalAIFails = statusData.stats?.aiFails || 0;
      healthData.unresolvedAlerts = statusData.alerts?.unresolved || 0;
      healthData.criticalAlerts = statusData.alerts?.critical || 0;
      healthData.errorAlerts = statusData.alerts?.error || 0;
      healthData.warningAlerts = statusData.alerts?.warning || 0;
      healthData.timestamp = statusData.timestamp || new Date().toISOString();

      isFirstRefresh = false;
      firstLoadDone.value = true;
    }
  } catch (e: any) {
    console.error("状态刷新失败:", e);
  } finally {
    statusLoading.value = false;
  }
}

// ===== 消息轮询 =====
async function handleTriggerPoll() {
  isPolling.value = true;
  pollResult.value = "正在轮询...";
  try {
    const d = await triggerPoll();
    pollResult.value =
      `✅ 轮询完成\n` +
      `拉取: ${d.pulled || 0} 条\n` +
      `回复: ${d.handled || 0} 条\n` +
      `耗时: ${d.latencyMs || 0}ms` +
      (d.error ? `\n⚠️ ${d.error}` : "");
    handleRefreshStatus();
  } catch (e: any) {
    pollResult.value = "❌ 失败: " + handleApiError(e, "轮询失败");
  } finally {
    isPolling.value = false;
  }
}

// ===== 配置操作 =====
async function handleLoadConfig() {
  configResult.value = "加载中...";
  try {
    const d = await fetchConfig();
    if (d === null) return;
    config.aiProvider = d.aiProvider || "cloudflare";
    config.aiModel = d.aiModel || "";
    config.aiBaseUrl = d.aiBaseUrl || "";
    config.aiApiKey = d.aiApiKey || "";
    config.aiMaxTokens = d.aiMaxTokens || 1024;
    config.aiSystemPrompt = d.aiSystemPrompt || "";
    configResult.value = d.hasEnvOverride
      ? "✅ 已加载当前配置（注意：当前有环境变量覆盖）"
      : "✅ 已加载当前配置";
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) return;
    configResult.value = "❌ 加载失败: " + handleApiError(e, "加载失败");
  }
}

async function handleSaveConfig() {
  configSaving.value = true;
  configResult.value = "保存中...";
  try {
    const d = await saveConfig(config);
    if (d.ok) {
      configResult.value = "✅ " + (d.message || "配置已保存");
    } else if (d.error === "VALIDATION_ERROR") {
      configResult.value = "⚠️ 验证失败: " + (d.errors || []).join("; ");
    } else {
      configResult.value = "❌ " + (d.error || "保存失败");
    }
  } catch (e: any) {
    configResult.value = "❌ 保存失败: " + handleApiError(e, "保存失败");
  } finally {
    configSaving.value = false;
  }
}

// ===== 聊天 =====
async function handleSendChat() {
  const q = chatInput.value.trim();
  if (!q || chatLoading.value) return;

  chatMessages.value.push({ role: "u", text: q });
  chatInput.value = "";
  chatLoading.value = true;

  try {
    const d = await chat(q);
    if (d === null) { // 被新请求取消
      chatLoading.value = false;
      return;
    }
    chatMessages.value.push({
      role: "b",
      text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : ""),
    });
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) {
      chatLoading.value = false;
      return;
    }
    chatMessages.value.push({
      role: "b",
      text: "错误: " + handleApiError(e, "AI 回复失败"),
    });
  } finally {
    chatLoading.value = false;
  }
}

// ===== 登出 =====
async function handleLogout() {
  if (!confirm("确认退出登录？退出后需重新扫码。")) return;
  try {
    await logout();
  } catch {}
  localStorage.removeItem("clawbot_auth");
  window.location.href = "/login";
}

// ===== 调试 =====
async function handleDebug() {
  debugLoading.value = true;
  debugInfo.value = "诊断中...";
  try {
    const d = await debugLogin();
    debugInfo.value = JSON.stringify(d, null, 2);
  } catch (e: any) {
    debugInfo.value = "错误: " + handleApiError(e, "诊断失败");
  } finally {
    debugLoading.value = false;
  }
}

// ===== 报警操作 =====
async function handleRefreshAlerts() {
  alertsLoading.value = true;
  try {
    const data = await fetchAlerts(alertsOnlyActive.value);
    if (data === null) return; // 被新请求替换

    if (data && data.alerts) {
      alerts.value = data.alerts;
      alertsTotal.value = data.total || 0;
      alertsTotalPages.value = data.totalPages || 1;
      if (data.summary) {
        alertSummary.total = data.summary.total || 0;
        alertSummary.unresolved = data.summary.unresolved || 0;
        alertSummary.byLevel = {
          info: data.summary.byLevel?.info || 0,
          warning: data.summary.byLevel?.warning || 0,
          error: data.summary.byLevel?.error || 0,
          critical: data.summary.byLevel?.critical || 0,
        };
      }
    }
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) return;
    console.error("刷新报警失败:", e);
  } finally {
    alertsLoading.value = false;
  }
}

async function handleResolveAlert(id: string) {
  try {
    const data = await resolveAlert(id);
    if (data.success) {
      handleRefreshAlerts();
    }
  } catch (e: any) {
    console.error("解决报警失败:", e);
  }
}

async function handleResolveAllAlerts() {
  if (!confirm("确认解决所有报警？")) return;
  try {
    const data = await resolveAllAlerts();
    if (data.success) {
      handleRefreshAlerts();
    }
  } catch (e: any) {
    console.error("解决所有报警失败:", e);
  }
}

// ===== 会话操作 =====
async function handleRefreshSessions() {
  sessionsLoading.value = true;
  try {
    const data = await fetchSessions(50, sessionsPage.value, sessionsSearch.value);
    if (data === null) return;

    if (data && data.sessions) {
      sessions.value = data.sessions;
      sessionsTotal.value = data.total || 0;
      sessionsTotalPages.value = data.totalPages || 1;
      if (sessionsPage.value > sessionsTotalPages.value) {
        sessionsPage.value = sessionsTotalPages.value || 1;
      }
    }
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) return;
    console.error("刷新会话失败:", e);
  } finally {
    sessionsLoading.value = false;
  }
}

// ===== 健康检查 =====
async function handleRefreshHealth() {
  healthLoading.value = true;
  try {
    const data = await fetchHealth();
    if (data === null) return;

    healthData.kv = data.kv || "—";
    healthData.loggedIn = !!data.loggedIn;
    healthData.totalPolls = data.totalPolls || 0;
    healthData.totalHandled = data.totalHandled || 0;
    healthData.totalAICalls = data.totalAICalls || 0;
    healthData.totalAIFails = data.totalAIFails || 0;
    healthData.unresolvedAlerts = data.unresolvedAlerts || 0;
    healthData.criticalAlerts = data.criticalAlerts || 0;
    healthData.errorAlerts = data.errorAlerts || 0;
    healthData.warningAlerts = data.warningAlerts || 0;
    healthData.timestamp = data.timestamp || new Date().toISOString();
  } catch (e: any) {
    if (e instanceof ApiError && e.isCancelled) return;
    console.error("刷新健康状态失败:", e);
  } finally {
    healthLoading.value = false;
  }
}

// ===== 工具函数 =====
function getAlertLevelText(level: string): string {
  const map: Record<string, string> = {
    info: "ℹ️ 信息",
    warning: "⚠️ 警告",
    error: "❌ 错误",
    critical: "🔥 严重",
  };
  return map[level] || level;
}

function formatTime(isoString: string): string {
  if (!isoString) return "—";
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

// ===== 生命周期 =====
onMounted(async () => {
  // 先检查本地登录状态
  if (localStorage.getItem("clawbot_auth") === "ok") {
    // 本地已登录，直接加载页面
  } else {
    // 本地无登录状态，检查后端
    let loginOk = true;
    try {
      const d = await checkLogin();
      if (!d.loggedIn) loginOk = false;
    } catch {
      loginOk = false;
    }
    if (!loginOk) {
      router.push("/login");
      return;
    }
  }

  // 并行加载所有页面数据
  handleRefreshStatus();
  handleLoadConfig();
  handleRefreshAlerts();
  handleRefreshSessions();

  // 启动 WebSocket 实时连接
  connectWebSocket();

  // 用 setTimeout 替代 setInterval，避免请求重叠
  async function tick() {
    try {
      await handleRefreshStatus();
      if (activeSection.value === "alerts") await handleRefreshAlerts();
    } finally {
      refreshTimer = window.setTimeout(tick, 30000);
    }
  }
  refreshTimer = window.setTimeout(tick, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<style scoped>
.alert-item {
  border: 1px solid var(--border-alert);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: var(--bg-card);
  transition: background 0.3s;
}

.alert-item.resolved {
  opacity: 0.6;
  background: var(--alert-resolved-bg);
}

.alert-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 6px;
}

.alert-level {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.alert-level.info { background: var(--alert-info-bg); color: var(--alert-info-text); }
.alert-level.warning { background: var(--alert-warn-bg); color: var(--alert-warn-text); }
.alert-level.error { background: var(--alert-error-bg); color: var(--alert-error-text); }
.alert-level.critical { background: var(--alert-critical-bg); color: #fff; }

.alert-time { color: var(--text-muted); font-size: 12px; }
.alert-count { color: var(--text-muted); font-size: 12px; font-weight: 600; }
.alert-resolved { color: var(--success); font-size: 12px; margin-left: auto; }

.alert-message {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.alert-error {
  font-size: 12px;
  color: var(--text-muted);
  font-family: monospace;
  background: var(--bg-alert-error);
  padding: 6px;
  border-radius: 4px;
  margin-bottom: 4px;
}

.alert-meta {
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  gap: 12px;
}

.session-item {
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: var(--bg-card);
  transition: background 0.3s;
}

.session-user {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
  margin-bottom: 4px;
  word-break: break-all;
}

.session-info {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  gap: 16px;
}

.btn-link {
  background: none;
  border: none;
  color: var(--link);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  margin-left: auto;
}

.btn-link:hover { text-decoration: underline; }

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-checkbox);
  cursor: pointer;
}

.input.small {
  font-size: 13px;
  padding: 6px 10px;
  min-width: 150px;
  max-width: 300px;
}

.btn.small {
  font-size: 12px;
  padding: 6px 12px;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--text-muted);
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-dim);
  font-size: 14px;
}

.result-box.success {
  background: var(--alert-success-bg);
  color: var(--alert-success-text);
  border-color: var(--alert-success-text);
}

/* 骨架屏样式 */
.skeleton-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.skeleton-item {
  height: 60px;
  background: linear-gradient(90deg, var(--bg-skeleton-1) 25%, var(--bg-skeleton-2) 50%, var(--bg-skeleton-1) 75%);
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s infinite;
  border-radius: 8px;
}

@keyframes skeleton-loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
