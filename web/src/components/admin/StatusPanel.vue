<template>
  <div>
    <div class="card">
      <h2>📊 实时状态</h2>
      <div class="desc">机器人运行状态、系统健康度、API 调用统计</div>
      <div v-if="loading" class="skeleton-grid">
        <div v-for="i in 10" :key="i" class="skeleton-item"></div>
      </div>
      <template v-else>
        <div class="stat-grid">
          <div class="stat-item" :class="health.kv === 'OK' ? 'success' : 'error'">
            <div class="stat-label">KV 存储</div>
            <div class="stat-value">{{ health.kv === 'OK' ? '✅ 正常' : '❌ 异常' }}</div>
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
          <div class="stat-item" :class="{ warning: (health.unresolvedAlerts || 0) > 0 }">
            <div class="stat-label">未解决报警</div>
            <div class="stat-value">{{ health.unresolvedAlerts || 0 }}</div>
          </div>
          <div class="stat-item" :class="{ error: (health.criticalAlerts || 0) > 0 }">
            <div class="stat-label">严重报警</div>
            <div class="stat-value">{{ health.criticalAlerts || 0 }}</div>
          </div>
        </div>
        <div style="margin-top: 16px; font-size: 13px; color: var(--text-secondary)">
          最后更新: {{ health.timestamp || status.lastPollAt || '—' }}
        </div>
        <div v-if="status.tokenHealth === 'expired'" style="margin-top:12px;padding:10px 14px;background:var(--alert-error-bg);border-radius:8px;font-size:13px;color:var(--error)">
          ⚠️ Token 已过期，需要重新扫码登录
        </div>
      </template>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>🔧 登录诊断</h2>
      <div class="desc">查看登录凭证和 getUpdates 测试结果</div>
      <button class="btn secondary" :disabled="debugLoading" @click="$emit('debug')">
        {{ debugLoading ? "诊断中..." : "🔍 运行诊断" }}
      </button>
      <div v-if="debugInfo" style="margin-top: 12px">
        <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:8px;font-size:12px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all">{{ debugInfo }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  status: {
    loggedIn: boolean;
    tokenHealth: string;
    loginAgeText: string;
    polls: number;
    handled: number;
    aiCalls: number;
    aiFails: number;
    lastPollAt: string;
    lastLatencyMs: string | number;
  };
  health: {
    kv: string;
    unresolvedAlerts: number;
    criticalAlerts: number;
    timestamp: string;
  };
  loading: boolean;
  debugInfo: string;
  debugLoading: boolean;
}>();

defineEmits(["debug"]);
</script>
