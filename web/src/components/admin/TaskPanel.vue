<template>
  <div>
    <!-- 任务卡片 -->
    <div class="card">
      <h2>🎯 任务面板</h2>
      <div class="desc">内联操作、实时状态、任务历史</div>

      <div class="task-grid">
        <!-- 轮询任务 -->
        <div class="task-card" :class="isPolling ? 'task-running' : 'task-success'">
          <div class="task-header">
            <span class="task-icon">🔄</span>
            <span class="task-name">消息轮询</span>
            <span class="task-badge" :class="isPolling ? 'badge-running' : 'badge-success'">{{ isPolling ? '运行中' : '待命中' }}</span>
          </div>
          <div class="task-meta">
            <span>累计 {{ status.polls }} 次</span>
            <span>耗时 {{ status.lastLatencyMs }}</span>
          </div>
          <div v-if="pollResult" class="task-result" :class="pollResult.includes('✅') ? 'result-success' : 'result-error'">{{ pollResult }}</div>
          <button class="task-btn" :disabled="isPolling" @click="$emit('triggerPoll')">
            {{ isPolling ? '轮询中...' : '🔄 立即轮询' }}
          </button>
        </div>

        <!-- 微信绑定 -->
        <div class="task-card" :class="bound ? 'task-success' : 'task-idle'">
          <div class="task-header">
            <span class="task-icon">📱</span>
            <span class="task-name">微信绑定</span>
            <span class="task-badge" :class="bound ? 'badge-success' : 'badge-idle'">{{ bound ? '已绑定' : '未绑定' }}</span>
          </div>
          <div class="task-meta">
            <span v-if="bound">账号已绑定，永久生效</span>
            <span v-else>需要扫码绑定</span>
          </div>
          <!-- 二维码内联显示 -->
          <div v-if="!bound && qrImage" class="qr-inline">
            <img :src="qrImage" alt="QR" style="width: 120px; border-radius: 8px" />
            <div class="task-meta" style="margin-top: 4px">{{ qrStatus }}</div>
          </div>
          <div class="task-actions">
            <button v-if="!bound && !qrImage" class="task-btn" :disabled="qrLoading" @click="$emit('getQR')">
              {{ qrLoading ? '加载中...' : '📱 获取二维码' }}
            </button>
            <button v-if="!bound && qrImage" class="task-btn secondary" @click="$emit('resetQR')">重新获取</button>
            <button v-if="bound" class="task-btn secondary" @click="handleUnbind">解绑微信</button>
          </div>
        </div>

        <!-- WebSocket -->
        <div class="task-card" :class="wsConnected ? 'task-success' : 'task-error'">
          <div class="task-header">
            <span class="task-icon">📡</span>
            <span class="task-name">实时连接</span>
            <span class="task-badge" :class="wsConnected ? 'badge-success' : 'badge-error'">{{ wsConnected ? '已连接' : '未连接' }}</span>
          </div>
          <div class="task-meta">
            <span>{{ wsMessages.length }} 条消息</span>
          </div>
          <button v-if="wsMessages.length > 0" class="task-btn secondary" @click="$emit('clearMessages')">清空消息</button>
        </div>

        <!-- AI 快捷测试 -->
        <div class="task-card task-idle">
          <div class="task-header">
            <span class="task-icon">🤖</span>
            <span class="task-name">快捷测试</span>
          </div>
          <div class="task-actions" style="flex-direction: column; gap: 6px">
            <div style="display: flex; gap: 6px">
              <input v-model="quickMsg" class="task-input" placeholder="输入消息测试 AI..." @keyup.enter="handleQuickSend" />
              <button class="task-btn" :disabled="!quickMsg.trim() || quickSending" @click="handleQuickSend">
                {{ quickSending ? '...' : '发送' }}
              </button>
            </div>
            <div v-if="quickReply" class="task-result result-success">{{ quickReply }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务历史 -->
    <div class="card" style="margin-top: 16px">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <div>
          <h2 style="margin-bottom: 0">📜 任务历史</h2>
          <div class="desc">最近的操作记录</div>
        </div>
        <button class="task-btn secondary" style="font-size: 11px" @click="taskHistory = []">清空</button>
      </div>

      <div v-if="taskHistory.length === 0" class="empty-state">暂无操作记录</div>
      <div v-else class="history-list">
        <div v-for="(item, i) in taskHistory" :key="i" class="history-item" :class="item.status">
          <span class="history-icon">{{ item.icon }}</span>
          <span class="history-text">{{ item.text }}</span>
          <span v-if="item.detail" class="history-detail">{{ item.detail }}</span>
          <span class="history-time">{{ item.time }}</span>
          <span class="history-status">
            {{ item.status === 'success' ? '✅' : item.status === 'error' ? '❌' : '⏳' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { chat } from "../../api";

const props = defineProps<{
  status: { loggedIn: boolean; polls: number; handled: number; aiCalls: number; aiFails: number; lastPollAt: string; lastLatencyMs: string | number };
  bound: boolean;
  isPolling: boolean;
  pollResult: string;
  wsConnected: boolean;
  wsMessages: Array<any>;
  qrImage: string;
  qrStatus: string;
  qrLoading: boolean;
}>();

const emit = defineEmits(["triggerPoll", "getQR", "resetQR", "unbind", "clearMessages"]);

// ===== 任务历史 =====
export interface TaskHistoryItem {
  icon: string;
  text: string;
  detail?: string;
  time: string;
  status: "success" | "error" | "running";
}

const taskHistory = ref<TaskHistoryItem[]>([]);

function addHistory(icon: string, text: string, detail: string, status: "success" | "error" | "running" = "success") {
  const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  taskHistory.value.unshift({ icon, text, detail, time: now, status });
  if (taskHistory.value.length > 50) taskHistory.value.pop();
}

// ===== 解绑 =====
function handleUnbind() {
  if (!confirm("确定要解绑微信吗？")) return;
  addHistory("📱", "解绑微信", "请求中...", "running");
  emit("unbind");
  addHistory("📱", "解绑微信", "已发送解绑请求", "success");
}

// ===== 快捷测试 =====
const quickMsg = ref("");
const quickSending = ref(false);
const quickReply = ref("");

async function handleQuickSend() {
  const q = quickMsg.value.trim();
  if (!q || quickSending.value) return;
  quickSending.value = true;
  quickReply.value = "";
  addHistory("🤖", "AI 测试", q.slice(0, 30), "running");
  try {
    const d = await chat(q);
    if (d) {
      quickReply.value = d.reply;
      addHistory("🤖", "AI 回复", d.reply.slice(0, 40), "success");
    }
  } catch (e: any) {
    quickReply.value = "失败: " + (e.message || "未知错误");
    addHistory("🤖", "AI 测试失败", e.message, "error");
  } finally {
    quickSending.value = false;
    setTimeout(() => { quickReply.value = ""; }, 5000);
  }
}

// 监听轮询结果变化
let lastPollCount = 0;
function watchPoll() {
  if (props.status.polls > lastPollCount && lastPollCount > 0) {
    addHistory("🔄", "轮询完成", `${props.status.polls} 次`, "success");
  }
  lastPollCount = props.status.polls;
}

// 暴露给父组件调用
defineExpose({ addHistory, watchPoll });
</script>

<style scoped>
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.task-card {
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--bg-card);
  transition: border-color 0.2s;
}

.task-card:hover { border-color: var(--link); }
.task-card.task-success { border-left: 3px solid var(--success); }
.task-card.task-error { border-left: 3px solid var(--error); }
.task-card.task-running { border-left: 3px solid var(--link); }
.task-card.task-idle { border-left: 3px solid var(--text-dim); }

.task-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.task-icon { font-size: 18px; }
.task-name { font-weight: 600; font-size: 14px; color: var(--text-primary); flex: 1; }
.task-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; }
.badge-success { background: var(--alert-success-bg); color: var(--success); }
.badge-error { background: var(--alert-error-bg); color: var(--error); }
.badge-idle { background: var(--bg-skeleton-1); color: var(--text-muted); }
.badge-running { background: var(--alert-info-bg); color: var(--link); }
.task-meta { display: flex; gap: 12px; font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; }
.task-actions { display: flex; gap: 8px; }
.task-result { font-size: 12px; padding: 6px 8px; border-radius: 4px; margin-bottom: 8px; word-break: break-all; }
.result-success { background: var(--alert-success-bg); color: var(--success); }
.result-error { background: var(--alert-error-bg); color: var(--error); }

.task-btn {
  padding: 6px 14px; border-radius: 6px; border: 1px solid var(--link);
  background: var(--link); color: #fff; font-size: 12px; cursor: pointer;
  font-weight: 500; transition: opacity 0.2s;
}
.task-btn:hover { opacity: 0.85; }
.task-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.task-btn.secondary { background: transparent; color: var(--link); border-color: var(--border-light); }
.task-btn.secondary:hover { border-color: var(--link); }

.task-input {
  flex: 1; padding: 6px 10px; border: 1px solid var(--border-light); border-radius: 6px;
  font-size: 12px; background: var(--bg-card); color: var(--text-primary); outline: none;
}
.task-input:focus { border-color: var(--link); }

.qr-inline { text-align: center; margin-bottom: 10px; }

/* 历史列表 */
.history-list { margin-top: 12px; }
.history-item {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--border-light); font-size: 12px;
}
.history-item:last-child { border-bottom: none; }
.history-icon { font-size: 14px; flex-shrink: 0; }
.history-text { font-weight: 500; color: var(--text-primary); flex-shrink: 0; }
.history-detail { color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-time { color: var(--text-dim); font-size: 11px; flex-shrink: 0; }
.history-status { flex-shrink: 0; font-size: 12px; }

.empty-state { text-align: center; padding: 30px; color: var(--text-dim); font-size: 13px; }
</style>
