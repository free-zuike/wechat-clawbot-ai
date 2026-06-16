<template>
  <div class="card">
    <h2>🎯 操作面板</h2>
    <div class="desc">快速操作和实时状态</div>

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
</template>

<script setup lang="ts">
import { ref } from "vue";
import { chat } from "../../api";

defineProps<{
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

defineEmits(["triggerPoll", "getQR", "resetQR", "unbind", "clearMessages"]);

function handleUnbind() {
  if (!confirm("确定要解绑微信吗？")) return;
  // emit directly, no history
}

const quickMsg = ref("");
const quickSending = ref(false);
const quickReply = ref("");

async function handleQuickSend() {
  const q = quickMsg.value.trim();
  if (!q || quickSending.value) return;
  quickSending.value = true;
  quickReply.value = "";
  try {
    const d = await chat(q);
    if (d) quickReply.value = d.reply;
  } catch (e: any) {
    quickReply.value = "失败: " + (e.message || "未知错误");
  } finally {
    quickSending.value = false;
    setTimeout(() => { quickReply.value = ""; }, 5000);
  }
}
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
</style>
