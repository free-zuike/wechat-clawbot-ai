<template>
  <div class="card">
    <h2>⏰ 定时消息</h2>
    <div class="desc">微信侧可用 <code>/提醒 30分钟后 该喝水了</code>、<code>/提醒 每天早上8点 新闻</code>、<code>/提醒列表</code>、<code>/提醒取消 编号</code> 管理；这里可手动增删</div>

    <div class="filter-bar">
      <button class="btn secondary small" @click="load">🔄 刷新</button>
      <button class="btn secondary small danger" :disabled="tasks.length === 0" @click="clearAll">🗑️ 清空全部</button>
    </div>

    <div class="form-row">
      <input v-model="newContent" class="input grow" placeholder="提醒内容，如：该喝水了" />
      <input v-model="newTime" class="input time" placeholder="触发时间：今天 20:00 / 明天 08:00" />
      <input v-model="newRepeat" class="input repeat" placeholder="重复间隔小时(0=一次)" type="number" min="0" />
      <button class="btn primary small" :disabled="!newContent || !newTime" @click="add">＋ 添加</button>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="tasks.length === 0" class="empty-state">暂无待执行提醒</div>
    <div v-else class="task-list">
      <div v-for="t in tasks" :key="t.id" class="task-item">
        <div class="task-main">
          <span class="task-time">⏰ {{ formatRunAt(t.run_at) }}</span>
          <span v-if="t.repeat_interval > 0" class="task-repeat">🔁 {{ formatRepeat(t.repeat_interval) }}</span>
          <span class="task-content">{{ t.content }}</span>
        </div>
        <div class="task-meta">
          <span v-if="t.to_user_id">👤 {{ t.to_user_id.slice(0, 15) }}</span>
          <span class="task-id">#{{ t.id.slice(3, 9) }}</span>
        </div>
        <button class="btn tiny danger" @click="del(t.id)">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { fetchScheduledMessages, createScheduledMessage, deleteScheduledMessage, clearAllScheduledMessages, type ScheduledMessage } from "../../api";

const tasks = ref<ScheduledMessage[]>([]);
const loading = ref(false);
const newContent = ref("");
const newTime = ref("");
const newRepeat = ref("0");

async function load() {
  loading.value = true;
  try {
    const data = await fetchScheduledMessages();
    tasks.value = data.tasks || [];
  } catch (e) {
    console.error("Failed to load scheduled messages", e);
  } finally {
    loading.value = false;
  }
}

async function add() {
  const runAt = parseTime(newTime.value);
  if (!runAt) {
    alert("时间格式不正确，示例：今天 20:00 / 明天 08:30 / 2025-12-31 23:59");
    return;
  }
  const repeatInterval = Math.max(0, parseInt(newRepeat.value || "0", 10) || 0) * 3600000;
  await createScheduledMessage({ content: newContent.value.trim(), runAt, repeatInterval });
  newContent.value = "";
  newTime.value = "";
  await load();
}

function parseTime(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const now = new Date();
  let target: Date | null = null;
  const full = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2})[：:](\d{1,2})$/);
  if (full) {
    target = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]));
  } else {
    const hm = s.match(/^(今天|明天|后天)?\s*(\d{1,2})[：:](\d{1,2})$/);
    if (hm) {
      let dayOffset = 0;
      if (hm[1] === "明天") dayOffset = 1;
      else if (hm[1] === "后天") dayOffset = 2;
      target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, Number(hm[2]), Number(hm[3]));
    }
  }
  if (!target || Number.isNaN(target.getTime())) return null;
  if (target.getTime() <= Date.now()) target.setTime(target.getTime() + 24 * 3600000);
  return target.getTime();
}

async function del(id: string) {
  if (!confirm("确定取消这条提醒？")) return;
  await deleteScheduledMessage(id);
  await load();
}

async function clearAll() {
  if (!confirm("确定清空所有待执行提醒？")) return;
  await clearAllScheduledMessages();
  await load();
}

function formatRunAt(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatRepeat(interval: number) {
  const h = interval / 3600000;
  if (h % 24 === 0) return `每 ${h / 24} 天`;
  if (h >= 1) return `每 ${h} 小时`;
  return `每 ${interval / 60000} 分钟`;
}

onMounted(load);
</script>

<style scoped>
.desc { font-size: 13px; color: var(--text-dim); margin-bottom: 8px; }
.desc code { background: var(--bg-tertiary, rgba(0,0,0,0.06)); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.filter-bar { display: flex; gap: 8px; margin: 12px 0; align-items: center; }
.form-row { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }
.input.grow { flex: 1; min-width: 200px; }
.input.time { width: 170px; }
.input.repeat { width: 90px; }
.task-list { max-height: 500px; overflow-y: auto; }
.task-item { display: flex; align-items: center; gap: 10px; background: var(--bg-secondary); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.task-main { flex: 1; min-width: 0; }
.task-time { font-weight: 600; font-size: 13px; }
.task-repeat { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; background: rgba(251,191,36,0.15); color: #f59e0b; margin-left: 6px; }
.task-content { font-size: 13px; margin-left: 8px; word-break: break-all; }
.task-meta { font-size: 11px; color: var(--text-dim); display: flex; gap: 8px; align-items: center; }
.task-id { font-family: monospace; }
.btn.tiny { padding: 4px 8px; font-size: 11px; }
.danger { color: var(--error) !important; border-color: var(--error) !important; }
.empty-state { text-align: center; padding: 30px; color: var(--text-dim); font-size: 14px; }
</style>
