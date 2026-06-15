<template>
  <div class="card">
    <h2>🚨 报警中心</h2>
    <div class="desc">系统错误报警和异常监控</div>

    <div v-if="loading" class="skeleton-grid">
      <div v-for="i in 5" :key="i" class="skeleton-item"></div>
    </div>

    <template v-else>
      <div class="stat-grid" style="margin-top:12px">
        <div class="stat-item">
          <div class="stat-label">总报警</div>
          <div class="stat-value">{{ summary.total }}</div>
        </div>
        <div class="stat-item" style="color:var(--error)">
          <div class="stat-label">严重</div>
          <div class="stat-value">{{ summary.byLevel?.critical || 0 }}</div>
        </div>
        <div class="stat-item" style="color:var(--warning)">
          <div class="stat-label">错误</div>
          <div class="stat-value">{{ summary.byLevel?.error || 0 }}</div>
        </div>
        <div class="stat-item" style="color:var(--warning)">
          <div class="stat-label">警告</div>
          <div class="stat-value">{{ summary.byLevel?.warning || 0 }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">未解决</div>
          <div class="stat-value" :style="{color: summary.unresolved > 0 ? 'var(--error)' : 'var(--success)'}">
            {{ summary.unresolved }}
          </div>
        </div>
      </div>

      <div class="filter-bar">
        <input v-model="searchText" class="input small" placeholder="🔍 搜索报警内容..." @input="$emit('refresh')" />
        <select v-model="levelFilter" class="input small" @change="$emit('refresh')">
          <option value="">所有级别</option>
          <option value="critical">严重</option>
          <option value="error">错误</option>
          <option value="warning">警告</option>
          <option value="info">信息</option>
        </select>
        <label class="checkbox-label">
          <input type="checkbox" v-model="onlyActive" @change="$emit('refresh')" />
          只看未解决
        </label>
        <button class="btn secondary small" @click="$emit('refresh')">🔄 刷新</button>
        <button class="btn secondary small" :disabled="summary.unresolved === 0" @click="$emit('resolveAll')">
          ✅ 解决全部
        </button>
      </div>

      <div v-if="items.length === 0" class="empty-state">🎉 暂无报警记录</div>
      <div v-else>
        <div v-for="alert in items" :key="alert.id" class="alert-item" :class="{ resolved: alert.resolved }">
          <div class="alert-header">
            <span class="alert-level" :class="alert.level">{{ getLevelText(alert.level) }}</span>
            <span class="alert-time">{{ formatTime(alert.timestamp) }}</span>
            <span v-if="alert.count > 1" class="alert-count">×{{ alert.count }}</span>
            <span v-if="alert.resolved" class="alert-resolved">✅ 已解决</span>
            <button v-else class="btn-link" @click="$emit('resolve', alert.id)">解决</button>
          </div>
          <div class="alert-message">{{ alert.message }}</div>
          <div v-if="alert.error" class="alert-error">{{ alert.error }}</div>
          <div class="alert-meta">
            <span v-if="alert.endpoint">端点: {{ alert.endpoint }}</span>
          </div>
        </div>
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button class="btn secondary small" :disabled="page <= 1" @click="$emit('prevPage')">← 上一页</button>
        <span>第 {{ page }} / {{ totalPages }} 页（共 {{ total }} 条）</span>
        <button class="btn secondary small" :disabled="page >= totalPages" @click="$emit('nextPage')">下一页 →</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  items: any[];
  loading: boolean;
  summary: { total: number; byLevel: Record<string, number>; unresolved: number };
  page: number;
  totalPages: number;
  total: number;
}>();

defineEmits(["refresh", "resolve", "resolveAll", "prevPage", "nextPage"]);

const searchText = defineModel<string>("searchText", { default: "" });
const levelFilter = defineModel<string>("levelFilter", { default: "" });
const onlyActive = defineModel<boolean>("onlyActive", { default: false });

function getLevelText(level: string): string {
  return { info: "ℹ️ 信息", warning: "⚠️ 警告", error: "❌ 错误", critical: "🔥 严重" }[level] || level;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
</script>
