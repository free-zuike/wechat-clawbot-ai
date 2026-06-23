<template>
  <div class="card">
    <h2>🎬 视频任务管理</h2>
    <div class="desc">查看和管理视频生成任务状态</div>

    <div class="stat-grid" style="margin-top:12px">
      <div class="stat-item">
        <div class="stat-label">排队中</div>
        <div class="stat-value" :style="{ color: stats.queued > 0 ? 'var(--warning)' : 'var(--text-muted)' }">{{ stats.queued }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">已完成</div>
        <div class="stat-value" style="color:var(--success)">{{ stats.completed }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">失败</div>
        <div class="stat-value" :style="{ color: stats.failed > 0 ? 'var(--error)' : 'var(--text-muted)' }">{{ stats.failed }}</div>
      </div>
      <div class="stat-item">
        <div class="stat-label">总计</div>
        <div class="stat-value">{{ stats.total }}</div>
      </div>
    </div>

    <div class="filter-bar">
      <select v-model="statusFilter" class="input small" @change="load">
        <option value="">全部状态</option>
        <option value="queued">排队中</option>
        <option value="completed">已完成</option>
        <option value="failed">失败</option>
      </select>
      <button class="btn secondary small" @click="load">🔄 刷新</button>
      <button class="btn secondary small danger" :disabled="stats.failed === 0" @click="clearFailed">
        🗑️ 清除全部失败
      </button>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="tasks.length === 0" class="empty-state">🎉 暂无任务</div>
    <div v-else>
      <div v-for="task in tasks" :key="task.task_id" class="task-item" :class="task.status">
        <div class="task-header">
          <span class="task-status" :class="task.status">{{ statusText(task.status) }}</span>
          <span class="task-time">{{ formatTime(task.created_at) }}</span>
        </div>
        <div class="task-body">
          <div class="task-prompt">{{ task.prompt || '(无描述)' }}</div>
          <div class="task-meta">
            <span>🤖 {{ resolveProviderName(task.provider) }} · {{ task.model }}</span>
            <span v-if="task.source"> · 📱 {{ task.source }}</span>
          </div>
          <div v-if="task.error_message" class="task-error">❌ {{ task.error_message }}</div>
          <div v-if="task.retry_count > 0" class="task-retry">🔄 已重试 {{ task.retry_count }} 次</div>
          <div v-if="task.video_url" class="task-url">
            <video :src="task.video_url" controls style="max-width:300px;max-height:180px;border-radius:6px"></video>
          </div>
        </div>
        <button class="btn tiny danger" @click="del(task.task_id)">删除</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { fetchPendingVideos, deletePendingVideo, deleteAllFailedPendingVideos, type PendingVideo } from "../../api";

const props = defineProps<{
  customProviders?: Array<{ id: string; name: string }>;
}>();

const tasks = ref<PendingVideo[]>([]);
const loading = ref(false);
const statusFilter = ref("");
const stats = reactive({ queued: 0, completed: 0, failed: 0, total: 0 });

async function load() {
  loading.value = true;
  try {
    const data = await fetchPendingVideos(statusFilter.value || undefined);
    tasks.value = data.tasks || [];
    stats.total = data.total || 0;
    if (!statusFilter.value) {
      const all = await fetchPendingVideos();
      const allTasks = all.tasks || [];
      stats.queued = allTasks.filter((t: PendingVideo) => t.status === "queued").length;
      stats.completed = allTasks.filter((t: PendingVideo) => t.status === "completed").length;
      stats.failed = allTasks.filter((t: PendingVideo) => t.status === "failed").length;
    }
  } catch (e) {
    console.error("Failed to load pending videos", e);
  } finally {
    loading.value = false;
  }
}

async function del(taskId: string) {
  try {
    await deletePendingVideo(taskId);
    await load();
  } catch (e) {
    console.error("Failed to delete", e);
  }
}

async function clearFailed() {
  if (!confirm("确定清除所有失败任务？")) return;
  try {
    await deleteAllFailedPendingVideos();
    await load();
  } catch (e) {
    console.error("Failed to clear", e);
  }
}

function statusText(s: string) {
  return { queued: "⏳ 排队中", completed: "✅ 已完成", failed: "❌ 失败" }[s] || s;
}

function resolveProviderName(id: string) {
  if (!id) return "未知";
  if (id === "cloudflare") return "Cloudflare AI";
  const p = (props.customProviders || []).find(x => x.id === id);
  return p ? p.name : id;
}

function formatTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

onMounted(load);
</script>

<style scoped>
.stat-grid { display: flex; gap: 12px; flex-wrap: wrap; }
.stat-item { flex: 1; min-width: 80px; background: var(--bg-secondary); padding: 12px; border-radius: 8px; text-align: center; }
.stat-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.stat-value { font-size: 20px; font-weight: 700; }
.filter-bar { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }
.task-item { background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 8px; border-left: 3px solid var(--border); }
.task-item.failed { border-left-color: var(--error); }
.task-item.completed { border-left-color: var(--success); }
.task-item.queued { border-left-color: var(--warning); }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.task-status { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
.task-status.failed { background: rgba(239,68,68,0.15); color: var(--error); }
.task-status.completed { background: rgba(34,197,94,0.15); color: var(--success); }
.task-status.queued { background: rgba(251,191,36,0.15); color: var(--warning); }
.task-time { font-size: 12px; color: var(--text-muted); }
.task-body { font-size: 13px; }
.task-prompt { font-weight: 500; margin-bottom: 4px; word-break: break-all; }
.task-meta { color: var(--text-muted); font-size: 12px; margin-bottom: 4px; }
.task-error { color: var(--error); font-size: 12px; margin-top: 4px; background: rgba(239,68,68,0.08); padding: 4px 8px; border-radius: 4px; }
.task-retry { color: var(--warning); font-size: 12px; margin-top: 2px; }
.task-url a { color: var(--primary); text-decoration: none; font-size: 12px; }
.btn.tiny { padding: 4px 8px; font-size: 11px; margin-top: 6px; }
.danger { color: var(--error) !important; border-color: var(--error) !important; }
</style>
