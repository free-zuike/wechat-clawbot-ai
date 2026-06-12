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

      <div style="margin-top:12px;padding:10px 12px;background:#fff7ed;border-radius:10px;font-size:12px;color:#c2410c;line-height:1.6">
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
          <div class="desc">机器人运行状态、API 调用统计</div>
          <div class="stat-grid">
            <div class="stat-item">
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
                <span v-if="status.tokenHealth === 'valid'" style="color:#16a34a">有效</span>
                <span v-else-if="status.tokenHealth === 'expired'" style="color:#dc2626">已过期</span>
                <span v-else-if="status.tokenHealth === 'error'" style="color:#d97706">检查失败</span>
                <span v-else style="color:#6b7280">未检测</span>
              </div>
            </div>
            <div class="stat-item">
              <div class="stat-label">累计轮询</div>
              <div class="stat-value">{{ status.polls }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">累计处理</div>
              <div class="stat-value">{{ status.handled }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">AI 调用</div>
              <div class="stat-value">{{ status.aiCalls }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">AI 失败</div>
              <div class="stat-value">{{ status.aiFails }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">上次耗时</div>
              <div class="stat-value">{{ status.lastLatencyMs }}</div>
            </div>
          </div>
          <div style="margin-top: 16px; font-size: 13px; color: #888">
            最后轮询: {{ status.lastPollAt }}
          </div>
          <div v-if="status.tokenHealth === 'expired'" style="margin-top:12px;padding:10px 14px;background:#fef2f2;border-radius:8px;font-size:13px;color:#b91c1c">
            ⚠️ Token 已过期，需要重新扫码登录
          </div>
        </div>

        <!-- 调试面板 -->
        <div class="card" style="margin-top:16px">
          <h2>🔧 登录诊断</h2>
          <div class="desc">查看登录凭证和 getUpdates 测试结果</div>
          <button class="btn secondary" :disabled="debugLoading" @click="handleDebug">
            {{ debugLoading ? "诊断中..." : "🔍 运行诊断" }}
          </button>
          <div v-if="debugInfo" style="margin-top:12px">
            <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:8px;font-size:12px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all">{{ debugInfo }}</pre>
          </div>
        </div>
      </section>

      <!-- 消息控制 -->
      <section v-if="activeSection === 'control'">
        <div class="card">
          <h2>🎮 消息控制</h2>
          <div class="desc">手动触发消息拉取，测试微信消息流</div>
          <button class="btn" :disabled="isPolling" @click="handleTriggerPoll">
            {{ isPolling ? "轮询中..." : "🔄 立即拉取消息" }}
          </button>
          <div v-if="pollResult" class="result-box">{{ pollResult }}</div>
          <div class="notice" style="margin-top: 20px">
            💡 <strong>提示：</strong>手动轮询适合测试场景。生产环境建议在
            wrangler.toml 中配置 cron 触发器，每 2 分钟自动拉取一次消息。
          </div>
        </div>
      </section>

      <!-- 系统配置 -->
      <section v-if="activeSection === 'config'">
        <div class="card">
          <h2>⚙️ 系统配置</h2>
          <div class="desc">配置 AI 模型和人设提示词，保存后即时生效</div>

          <div class="field">
            <label>AI 模型</label>
            <input
              v-model="config.aiModel"
              class="input"
              placeholder="@cf/meta/llama-3-8b-instruct"
            />
            <div style="font-size: 12px; color: #888; margin-top: 6px">
              留空使用默认模型。支持 Cloudflare Worker AI 系列模型
            </div>
          </div>

          <div class="field">
            <label>人设提示词 (system prompt)</label>
            <textarea
              v-model="config.aiSystemPrompt"
              class="input"
              placeholder="你是爪爪，一个友好的 AI 助手..."
            ></textarea>
            <div style="font-size: 12px; color: #888; margin-top: 6px">
              定义机器人的性格和行为。留空使用默认人设
            </div>
          </div>

          <div style="display: flex; gap: 10px; margin-top: 16px">
            <button class="btn secondary" @click="handleLoadConfig">📥 加载当前配置</button>
            <button class="btn" @click="handleSaveConfig">💾 保存配置</button>
          </div>
          <div v-if="configResult" class="result-box">{{ configResult }}</div>
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
              style="text-align: center; color: #aaa; padding: 40px 20px"
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
              @keyup.enter="handleSendChat"
            />
            <button class="btn" @click="handleSendChat">发送</button>
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
          
          <div class="stat-grid" style="margin-top:12px">
            <div class="stat-item">
              <div class="stat-label">总报警</div>
              <div class="stat-value">{{ alertSummary.total }}</div>
            </div>
            <div class="stat-item" style="color:#dc2626">
              <div class="stat-label">严重</div>
              <div class="stat-value">{{ alertSummary.byLevel.critical }}</div>
            </div>
            <div class="stat-item" style="color:#d97706">
              <div class="stat-label">错误</div>
              <div class="stat-value">{{ alertSummary.byLevel.error }}</div>
            </div>
            <div class="stat-item" style="color:#ca8a04">
              <div class="stat-label">警告</div>
              <div class="stat-value">{{ alertSummary.byLevel.warning }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">未解决</div>
              <div class="stat-value" :style="{color: alertSummary.unresolved > 0 ? '#dc2626' : '#16a34a'}">
                {{ alertSummary.unresolved }}
              </div>
            </div>
          </div>

          <div style="display:flex; gap:10px; margin-top:12px">
            <button class="btn secondary" @click="handleRefreshAlerts">🔄 刷新</button>
            <button class="btn secondary" :disabled="alertSummary.unresolved === 0" @click="handleResolveAllAlerts">
              ✅ 解决全部
            </button>
            <label class="checkbox-label">
              <input type="checkbox" v-model="alertOnlyActive" />
              只看未解决
            </label>
          </div>

          <div v-if="alerts.length === 0" style="text-align:center; padding:40px; color:#aaa">
            🎉 暂无报警记录
          </div>
          <div v-else style="margin-top:12px">
            <div
              v-for="alert in alerts.slice(0, 50)"
              :key="alert.id"
              class="alert-item"
              :class="{ resolved: alert.resolved }"
            >
              <div class="alert-header">
                <span class="alert-level" :class="alert.level">
                  {{ getAlertLevelText(alert.level) }}
                </span>
                <span class="alert-time">{{ formatTime(alert.timestamp) }}</span>
                <span v-if="alert.resolved" class="alert-resolved">✅ 已解决</span>
                <button v-else class="btn-link" @click="handleResolveAlert(alert.id)">解决</button>
              </div>
              <div class="alert-message">{{ alert.message }}</div>
              <div v-if="alert.error" class="alert-error">{{ alert.error }}</div>
              <div class="alert-meta">
                <span v-if="alert.endpoint">端点: {{ alert.endpoint }}</span>
                <span v-if="alert.count > 1">重复: {{ alert.count }} 次</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 会话管理 -->
      <section v-if="activeSection === 'sessions'">
        <div class="card">
          <h2>💬 用户会话</h2>
          <div class="desc">查看所有活跃用户的对话记录</div>
          
          <div style="margin-top:12px">
            <button class="btn secondary" @click="handleRefreshSessions">🔄 刷新</button>
          </div>

          <div v-if="sessions.length === 0" style="text-align:center; padding:40px; color:#aaa">
            暂无会话记录
          </div>
          <div v-else style="margin-top:12px">
            <div class="session-item" v-for="session in sessions.slice(0, 30)" :key="session.from_user_id">
              <div class="session-user">👤 {{ session.from_user_id }}</div>
              <div class="session-info">
                <span>📨 {{ session.message_count }} 条消息</span>
                <span>🕒 {{ formatTime(session.last_message_at) }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 系统健康 -->
      <section v-if="activeSection === 'health'">
        <div class="card">
          <h2>💚 系统健康</h2>
          <div class="desc">实时系统健康状态和性能指标</div>
          
          <div class="stat-grid" style="margin-top:12px">
            <div class="stat-item" :class="healthData.kv === 'OK' ? 'success' : 'error'">
              <div class="stat-label">KV 存储</div>
              <div class="stat-value">{{ healthData.kv === 'OK' ? '✅ 正常' : '❌ 异常' }}</div>
            </div>
            <div class="stat-item" :class="healthData.loggedIn ? 'success' : 'warning'">
              <div class="stat-label">登录状态</div>
              <div class="stat-value">{{ healthData.loggedIn ? '✅ 已登录' : '⚠️ 未登录' }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">总轮询</div>
              <div class="stat-value">{{ healthData.totalPolls }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">总处理</div>
              <div class="stat-value">{{ healthData.totalHandled }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">AI 调用</div>
              <div class="stat-value">{{ healthData.totalAICalls }}</div>
            </div>
            <div class="stat-item" :class="healthData.totalAIFails > 0 ? 'warning' : ''">
              <div class="stat-label">AI 失败</div>
              <div class="stat-value">{{ healthData.totalAIFails }}</div>
            </div>
            <div class="stat-item" :class="healthData.unresolvedAlerts > 0 ? 'warning' : ''">
              <div class="stat-label">未解决报警</div>
              <div class="stat-value">{{ healthData.unresolvedAlerts }}</div>
            </div>
            <div class="stat-item" :class="healthData.criticalAlerts > 0 ? 'error' : ''">
              <div class="stat-label">严重报警</div>
              <div class="stat-value">{{ healthData.criticalAlerts }}</div>
            </div>
          </div>
          
          <div style="margin-top:12px">
            <button class="btn secondary" @click="handleRefreshHealth">🔄 刷新健康状态</button>
          </div>
          
          <div style="margin-top:16px; font-size:12px; color:#888">
            最后更新: {{ formatTime(healthData.timestamp) }}
          </div>
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
} from "../api";

const router = useRouter();

const navItems = [
  { key: "status", label: "状态监控", icon: "📊" },
  { key: "control", label: "消息控制", icon: "🎮" },
  { key: "config", label: "系统配置", icon: "⚙️" },
  { key: "chat", label: "AI 测试", icon: "🤖" },
  { key: "alerts", label: "报警中心", icon: "🚨" },
  { key: "sessions", label: "用户会话", icon: "💬" },
  { key: "health", label: "系统健康", icon: "💚" },
];

const activeSection = ref("status");
let isFirstRefresh = true;

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

const config = reactive({
  aiModel: "",
  aiSystemPrompt: "",
});

const configResult = ref("");
const chatMessages = ref<Array<{ role: string; text: string }>>([]);
const chatInput = ref("");
const pollResult = ref("");
const isPolling = ref(false);
const debugInfo = ref("");
const debugLoading = ref(false);

// 报警相关状态
const alerts = ref<any[]>([]);
const alertOnlyActive = ref(false);
const alertSummary = reactive({
  total: 0,
  byLevel: { info: 0, warning: 0, error: 0, critical: 0 },
  unresolved: 0,
});

// 会话相关状态
const sessions = ref<any[]>([]);

// 健康状态
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
  timestamp: new Date().toISOString(),
});

let refreshTimer: number | null = null;

async function handleRefreshStatus() {
  try {
    const d = await fetchStatus(isFirstRefresh);
    status.loggedIn = !!d.loggedIn;
    status.tokenHealth = d.tokenHealth || "";
    status.loginAgeText = d.loginAgeText || "";
    status.polls = d.stats?.polls || 0;
    status.handled = d.stats?.handled || 0;
    status.aiCalls = d.stats?.aiCalls || 0;
    status.aiFails = d.stats?.aiFails || 0;
    status.lastPollAt = d.stats?.lastPollAt
      ? new Date(d.stats.lastPollAt).toLocaleString()
      : "从未";
    status.lastLatencyMs =
      d.stats?.lastLatencyMs == null ? "—" : d.stats.lastLatencyMs + " ms";
    isFirstRefresh = false;
  } catch {}
}

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
    pollResult.value = "❌ 失败: " + e.message;
  } finally {
    isPolling.value = false;
  }
}

async function handleLoadConfig() {
  configResult.value = "加载中...";
  try {
    const d = await fetchConfig();
    config.aiModel = d.aiModel || "";
    config.aiSystemPrompt = d.aiSystemPrompt || "";
    configResult.value = "✅ 已加载当前配置";
  } catch (e: any) {
    configResult.value = "❌ 加载失败: " + e.message;
  }
}

async function handleSaveConfig() {
  configResult.value = "保存中...";
  try {
    const d = await saveConfig(config);
    if (d.ok) {
      configResult.value = "✅ 配置已保存！下次消息将使用新配置";
    } else {
      configResult.value = "❌ " + (d.error || "保存失败");
    }
  } catch (e: any) {
    configResult.value = "❌ 保存失败: " + e.message;
  }
}

async function handleSendChat() {
  const q = chatInput.value.trim();
  if (!q) return;
  chatMessages.value.push({ role: "u", text: q });
  chatInput.value = "";
  try {
    const d = await chat(q);
    chatMessages.value.push({
      role: "b",
      text: d.reply + (d.source === "shortcut" ? " [快捷回复]" : ""),
    });
  } catch (e: any) {
    chatMessages.value.push({ role: "b", text: "错误: " + e.message });
  }
}

async function handleLogout() {
  if (!confirm("确认退出登录？退出后需重新扫码。")) return;
  try {
    await logout();
  } catch {}
  router.push("/login");
}

async function handleDebug() {
  debugLoading.value = true;
  debugInfo.value = "诊断中...";
  try {
    const d = await debugLogin();
    debugInfo.value = JSON.stringify(d, null, 2);
  } catch (e: any) {
    debugInfo.value = "错误: " + e.message;
  } finally {
    debugLoading.value = false;
  }
}

// 报警相关函数
async function handleRefreshAlerts() {
  try {
    const params = alertOnlyActive.value ? "?active=true" : "";
    const response = await fetch("/api/admin/alerts" + params, { credentials: "include" });
    const data = await response.json();
    if (data && data.alerts) {
      alerts.value = data.alerts;
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
    console.error("刷新报警失败:", e);
  }
}

async function handleResolveAlert(id: string) {
  try {
    const response = await fetch("/api/admin/alerts/resolve?id=" + encodeURIComponent(id), {
      method: "POST",
      credentials: "include",
    });
    const data = await response.json();
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
    const response = await fetch("/api/admin/alerts/resolve-all", {
      method: "POST",
      credentials: "include",
    });
    const data = await response.json();
    if (data.success) {
      handleRefreshAlerts();
    }
  } catch (e: any) {
    console.error("解决所有报警失败:", e);
  }
}

// 会话相关函数
async function handleRefreshSessions() {
  try {
    const response = await fetch("/api/admin/sessions", { credentials: "include" });
    const data = await response.json();
    if (data && data.sessions) {
      sessions.value = data.sessions;
    }
  } catch (e: any) {
    console.error("刷新会话失败:", e);
  }
}

// 健康状态函数
async function handleRefreshHealth() {
  try {
    const response = await fetch("/api/admin/health", { credentials: "include" });
    const data = await response.json();
    if (data) {
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
    }
  } catch (e: any) {
    console.error("刷新健康状态失败:", e);
  }
}

// 工具函数
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

onMounted(async () => {
  try {
    const d = await checkLogin();
    if (!d.loggedIn) {
      router.push("/login");
      return;
    }
  } catch {
    router.push("/login");
    return;
  }
  handleRefreshStatus();
  handleLoadConfig();
  handleRefreshAlerts();
  handleRefreshSessions();
  handleRefreshHealth();
  refreshTimer = window.setInterval(handleRefreshStatus, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.alert-item {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: #fff;
}

.alert-item.resolved {
  opacity: 0.6;
  background: #f9fafb;
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

.alert-level.info {
  background: #dbeafe;
  color: #1e40af;
}

.alert-level.warning {
  background: #fef3c7;
  color: #92400e;
}

.alert-level.error {
  background: #fee2e2;
  color: #991b1b;
}

.alert-level.critical {
  background: #991b1b;
  color: #fff;
}

.alert-time {
  color: #6b7280;
  font-size: 12px;
}

.alert-resolved {
  color: #16a34a;
  font-size: 12px;
  margin-left: auto;
}

.alert-message {
  font-size: 14px;
  color: #111827;
  margin-bottom: 4px;
}

.alert-error {
  font-size: 12px;
  color: #6b7280;
  font-family: monospace;
  background: #f3f4f6;
  padding: 6px;
  border-radius: 4px;
  margin-bottom: 4px;
}

.alert-meta {
  font-size: 11px;
  color: #9ca3af;
  display: flex;
  gap: 12px;
}

.btn-link {
  background: none;
  border: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  margin-left: auto;
}

.btn-link:hover {
  text-decoration: underline;
}

.session-item {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
  background: #fff;
}

.session-user {
  font-weight: 600;
  color: #111827;
  font-size: 14px;
  margin-bottom: 4px;
  word-break: break-all;
}

.session-info {
  font-size: 12px;
  color: #6b7280;
  display: flex;
  gap: 16px;
}

.stat-item.success .stat-value {
  color: #16a34a;
}

.stat-item.warning .stat-value {
  color: #d97706;
}

.stat-item.error .stat-value {
  color: #dc2626;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #4b5563;
  cursor: pointer;
}

.checkbox-label input {
  cursor: pointer;
}
</style>
