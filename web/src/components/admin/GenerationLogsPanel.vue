<template>
  <div class="card">
    <h2>📝 生成记录</h2>
    <div class="desc">文字、图片、视频的生成历史</div>

    <div class="stat-grid" style="margin-top:12px">
      <div class="stat-item" @click="typeFilter = ''">
        <div class="stat-label">全部</div>
        <div class="stat-value">{{ stats.total }}</div>
      </div>
      <div class="stat-item" @click="typeFilter = 'text'">
        <div class="stat-label">💬 文字</div>
        <div class="stat-value">{{ stats.text }}</div>
      </div>
      <div class="stat-item" @click="typeFilter = 'image'">
        <div class="stat-label">🖼️ 图片</div>
        <div class="stat-value">{{ stats.image }}</div>
      </div>
      <div class="stat-item" @click="typeFilter = 'video'">
        <div class="stat-label">🎬 视频</div>
        <div class="stat-value">{{ stats.video }}</div>
      </div>
    </div>

    <div class="filter-bar">
      <select v-model="typeFilter" class="input small" @change="load">
        <option value="">全部类型</option>
        <option value="text">💬 文字</option>
        <option value="image">🖼️ 图片</option>
        <option value="video">🎬 视频</option>
      </select>
      <button class="btn secondary small" @click="load">🔄 刷新</button>
      <button class="btn secondary small danger" :disabled="logs.length === 0" @click="clearAll">🗑️ 清空全部</button>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="logs.length === 0" class="empty-state">暂无生成记录</div>
    <div v-else class="log-list">
      <div v-for="log in logs" :key="log.id" class="log-item" :class="log.status">
        <div class="log-header">
          <span class="log-type" :class="log.type">{{ typeIcon(log.type) }} {{ typeName(log.type) }}</span>
          <span class="log-status" :class="log.status">{{ log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⏳' }}</span>
          <span class="log-time">{{ formatTime(log.created_at) }}</span>
        </div>
        <div class="log-prompt">{{ log.prompt }}</div>
        <div class="log-meta">
          <span>🤖 {{ log.provider_name || log.provider }} · {{ log.model }}</span>
          <span v-if="log.key_index > 0" class="log-key">🔑 密钥{{ log.key_index + 1 }}</span>
          <span v-if="log.from_user"> · 👤 {{ log.from_user.slice(0, 15) }}</span>
          <span class="log-source" :class="log.source">{{ sourceLabel(log.source) }}</span>
        </div>
        <div v-if="log.error" class="log-error">❌ {{ log.error }}</div>
        <div v-if="log.result && log.type === 'image' && (log.result.startsWith('http') || log.result.startsWith('data:'))" class="log-preview">
          <a v-if="log.result.startsWith('http')" :href="log.result" target="_blank"><img :src="log.result" loading="lazy" /></a>
          <img v-else :src="log.result" loading="lazy" />
        </div>
        <div v-else-if="log.result && log.type === 'video' && log.result.startsWith('http')" class="log-preview">
          <video :src="log.result" controls style="max-width:400px;max-height:250px;border-radius:8px"></video>
        </div>
        <div v-else-if="log.result" class="log-result">{{ log.result.slice(0, 200) }}{{ log.result.length > 200 ? '...' : '' }}</div>
        <button class="btn tiny danger" @click="del(log.id)">删除</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { fetchGenerationLogs, deleteGenerationLog, clearAllGenerationLogs, type GenerationLog } from "../../api";

const logs = ref<GenerationLog[]>([]);
const loading = ref(false);
const typeFilter = ref("");
const stats = reactive({ total: 0, text: 0, image: 0, video: 0 });

async function load() {
  loading.value = true;
  try {
    const data = await fetchGenerationLogs(typeFilter.value || undefined, 100);
    logs.value = data.logs || [];
  } catch (e) {
    console.error("Failed to load generation logs", e);
  } finally {
    loading.value = false;
  }
  try {
    const all = await fetchGenerationLogs(undefined, 1000);
    const allLogs = all.logs || [];
    stats.total = allLogs.length;
    stats.text = allLogs.filter(l => l.type === "text").length;
    stats.image = allLogs.filter(l => l.type === "image").length;
    stats.video = allLogs.filter(l => l.type === "video").length;
  } catch {}
}

async function del(id: number) {
  await deleteGenerationLog(id);
  await load();
}

async function clearAll() {
  if (!confirm("确定清空所有生成记录？")) return;
  await clearAllGenerationLogs();
  await load();
}

function typeIcon(t: string) {
  return { text: "💬", image: "🖼️", video: "🎬" }[t] || "📄";
}

function typeName(t: string) {
  return { text: "文字", image: "图片", video: "视频" }[t] || t;
}

function sourceLabel(s: string | null) {
  return { chat: "🤖 AI测试", wechat: "💬 微信" }[s || ""] || (s ? `📱 ${s}` : "❓ 未知");
}

function formatTime(ts: number) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

onMounted(load);
</script>

<style scoped>
.stat-grid { display: flex; gap: 12px; flex-wrap: wrap; }
.stat-item { flex: 1; min-width: 80px; background: var(--bg-secondary); padding: 12px; border-radius: 8px; text-align: center; cursor: pointer; transition: background 0.2s; }
.stat-item:hover { background: var(--bg-tertiary, rgba(255,255,255,0.12)); }
.stat-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
.stat-value { font-size: 20px; font-weight: 700; }
.filter-bar { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }
.log-list { max-height: 600px; overflow-y: auto; }
.log-item { background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 8px; border-left: 3px solid var(--border); }
.log-item.success { border-left-color: var(--success); }
.log-item.failed { border-left-color: var(--error); }
.log-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.log-type { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: var(--bg-tertiary, rgba(255,255,255,0.08)); }
.log-status { font-size: 14px; }
.log-time { font-size: 12px; color: var(--text-muted); margin-left: auto; }
.log-prompt { font-size: 13px; font-weight: 500; word-break: break-all; margin-bottom: 4px; }
.log-meta { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.log-key { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; background: rgba(251,191,36,0.15); color: #f59e0b; }
.log-source { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px; }
.log-source.chat { background: rgba(99,102,241,0.15); color: #6366f1; }
.log-source.wechat { background: rgba(34,197,94,0.15); color: #22c55e; }
.log-error { color: var(--error); font-size: 12px; background: rgba(239,68,68,0.08); padding: 4px 8px; border-radius: 4px; margin-top: 4px; }
.log-result { font-size: 12px; color: var(--text-muted); background: var(--bg-tertiary, rgba(0,0,0,0.05)); padding: 4px 8px; border-radius: 4px; margin-top: 4px; white-space: pre-wrap; word-break: break-all; }
.log-preview { margin-top: 6px; }
.log-preview img { max-width: 200px; max-height: 150px; border-radius: 6px; object-fit: cover; }
.btn.tiny { padding: 4px 8px; font-size: 11px; margin-top: 6px; }
.danger { color: var(--error) !important; border-color: var(--error) !important; }
</style>
