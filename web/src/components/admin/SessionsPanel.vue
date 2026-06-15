<template>
  <div class="card">
    <h2>💬 用户会话</h2>
    <div class="desc">查看所有活跃用户的对话记录</div>

    <div v-if="loading" class="skeleton-grid">
      <div v-for="i in 5" :key="i" class="skeleton-item" style="grid-column: 1 / -1"></div>
    </div>

    <template v-else>
      <div class="filter-bar">
        <input
          :value="search"
          class="input small"
          placeholder="🔍 搜索用户ID..."
          @input="$emit('update:search', ($event.target as HTMLInputElement).value); $emit('refresh')"
        />
        <button class="btn secondary small" @click="$emit('refresh')">🔄 刷新</button>
      </div>

      <div v-if="items.length === 0" class="empty-state">暂无会话记录</div>
      <div v-else>
        <div class="session-item" v-for="session in items" :key="session.from_user_id">
          <div class="session-user">👤 {{ session.from_user_id }}</div>
          <div class="session-info">
            <span>📨 {{ session.message_count }} 条消息</span>
            <span>🕒 {{ formatTime(session.last_message_at) }}</span>
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
defineProps<{
  items: any[];
  loading: boolean;
  search: string;
  page: number;
  totalPages: number;
  total: number;
}>();

defineEmits(["refresh", "prevPage", "nextPage", "update:search"]);

function formatTime(iso: string): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
</script>
