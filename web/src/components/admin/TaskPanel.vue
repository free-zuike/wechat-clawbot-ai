<template>
  <div class="card">
    <h2>🎯 任务面板</h2>
    <div class="desc">快速操作和任务状态总览</div>

    <div class="task-grid">
      <!-- 轮询任务 -->
      <div class="task-card" :class="pollStatus">
        <div class="task-header">
          <span class="task-icon">🔄</span>
          <span class="task-name">消息轮询</span>
          <span class="task-badge" :class="pollStatus">{{ pollStatusLabel }}</span>
        </div>
        <div class="task-meta">
          <span v-if="status.lastPollAt && status.lastPollAt !== '从未'">上次: {{ status.lastPollAt }}</span>
          <span v-else>从未轮询</span>
          <span>累计: {{ status.polls }} 次</span>
        </div>
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
          <span v-if="bound">账号: {{ accountId || '已绑定' }}</span>
          <span v-else>需要扫码绑定</span>
        </div>
        <div class="task-actions">
          <button v-if="!bound && !qrCode" class="task-btn" :disabled="qrLoading" @click="$emit('getQR')">
            {{ qrLoading ? '加载中...' : '📱 获取二维码' }}
          </button>
          <button v-if="bound" class="task-btn secondary" @click="$emit('unbind')">解绑</button>
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
          <span>消息: {{ wsMessages.length }} 条</span>
        </div>
        <button v-if="wsMessages.length > 0" class="task-btn secondary" @click="$emit('clearMessages')">清空</button>
      </div>

      <!-- AI 回复 -->
      <div class="task-card" :class="status.aiCalls > 0 ? 'task-success' : 'task-idle'">
        <div class="task-header">
          <span class="task-icon">🤖</span>
          <span class="task-name">AI 回复</span>
          <span class="task-badge" :class="status.aiFails > 0 ? 'badge-error' : 'badge-success'">
            {{ status.aiFails > 0 ? `${status.aiFails} 失败` : '正常' }}
          </span>
        </div>
        <div class="task-meta">
          <span>调用: {{ status.aiCalls }} 次</span>
          <span>处理: {{ status.handled }} 条</span>
        </div>
        <button class="task-btn secondary" @click="$emit('openChat')">测试对话</button>
      </div>

      <!-- 消息模板 -->
      <div class="task-card task-idle">
        <div class="task-header">
          <span class="task-icon">📋</span>
          <span class="task-name">消息模板</span>
          <span class="task-badge badge-idle">{{ templateCount }} 个</span>
        </div>
        <div class="task-meta">
          <span>预设回复模板</span>
        </div>
        <button class="task-btn secondary" @click="$emit('openTemplates')">管理模板</button>
      </div>

      <!-- 系统配置 -->
      <div class="task-card task-idle">
        <div class="task-header">
          <span class="task-icon">⚙️</span>
          <span class="task-name">系统配置</span>
          <span class="task-badge" :class="configured ? 'badge-success' : 'badge-idle'">{{ configured ? '已配置' : '待配置' }}</span>
        </div>
        <div class="task-meta">
          <span>AI 提供商: {{ configProvider }}</span>
        </div>
        <button class="task-btn secondary" @click="$emit('openConfig')">修改配置</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  status: { loggedIn: boolean; polls: number; handled: number; aiCalls: number; aiFails: number; lastPollAt: string; lastLatencyMs: string | number };
  bound: boolean;
  accountId: string;
  isPolling: boolean;
  wsConnected: boolean;
  wsMessages: Array<any>;
  templateCount: number;
  configProvider: string;
  qrCode: string;
  qrLoading: boolean;
}>();

defineEmits(["triggerPoll", "getQR", "unbind", "clearMessages", "openChat", "openTemplates", "openConfig"]);

const pollStatus = computed(() => {
  if (props.isPolling) return "task-running";
  if (props.status.polls > 0) return "task-success";
  return "task-idle";
});

const pollStatusLabel = computed(() => {
  if (props.isPolling) return "运行中";
  if (props.status.polls > 0) return "待命中";
  return "未启动";
});

const configured = computed(() => props.configProvider !== "cloudflare" || false);
</script>

<style scoped>
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.task-card {
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--bg-card);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.task-card:hover {
  border-color: var(--link);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}

.task-card.task-success { border-left: 3px solid var(--success); }
.task-card.task-error { border-left: 3px solid var(--error); }
.task-card.task-running { border-left: 3px solid var(--link); }
.task-card.task-idle { border-left: 3px solid var(--text-dim); }

.task-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.task-icon { font-size: 18px; }

.task-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  flex: 1;
}

.task-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.badge-success { background: var(--alert-success-bg); color: var(--success); }
.badge-error { background: var(--alert-error-bg); color: var(--error); }
.badge-idle { background: var(--bg-skeleton-1); color: var(--text-muted); }

.task-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.task-actions {
  display: flex;
  gap: 8px;
}

.task-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--link);
  background: var(--link);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.2s;
}

.task-btn:hover { opacity: 0.85; }
.task-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.task-btn.secondary {
  background: transparent;
  color: var(--link);
  border-color: var(--border-light);
}
.task-btn.secondary:hover { border-color: var(--link); }
</style>
