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
} from "../api";

const router = useRouter();

const navItems = [
  { key: "status", label: "状态监控", icon: "📊" },
  { key: "control", label: "消息控制", icon: "🎮" },
  { key: "config", label: "系统配置", icon: "⚙️" },
  { key: "chat", label: "AI 测试", icon: "🤖" },
];

const activeSection = ref("status");

const status = reactive({
  loggedIn: false,
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

let refreshTimer: number | null = null;

async function handleRefreshStatus() {
  try {
    const d = await fetchStatus();
    status.loggedIn = !!d.loggedIn;
    status.polls = d.stats?.polls || 0;
    status.handled = d.stats?.handled || 0;
    status.aiCalls = d.stats?.aiCalls || 0;
    status.aiFails = d.stats?.aiFails || 0;
    status.lastPollAt = d.stats?.lastPollAt
      ? new Date(d.stats.lastPollAt).toLocaleString()
      : "从未";
    status.lastLatencyMs =
      d.stats?.lastLatencyMs == null ? "—" : d.stats.lastLatencyMs + " ms";
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
  refreshTimer = window.setInterval(handleRefreshStatus, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>
