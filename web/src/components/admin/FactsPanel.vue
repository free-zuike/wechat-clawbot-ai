<template>
  <div class="card">
    <h2>🧠 用户事实</h2>
    <div class="desc">AI 通过 <code>remember_fact</code> 工具自动保存用户告知的长期事实（姓名、偏好、职业等），并在对话前注入提示词。这里可人工查看、补充、删除（人工治理优先于算法）</div>

    <div class="form-row">
      <input v-model="newUserId" class="input grow" placeholder="用户 ID（微信用户标识）" />
      <input v-model="newFact" class="input grow" placeholder="事实，如：用户叫张然，做后端开发" />
      <button class="btn primary small" :disabled="!newUserId || !newFact" @click="add">＋ 添加</button>
    </div>

    <div class="filter-bar">
      <button class="btn secondary small" @click="load">🔄 刷新</button>
      <span class="count">共 {{ facts.length }} 条</span>
    </div>

    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="facts.length === 0" class="empty-state">暂无已记忆的事实</div>
    <div v-else class="fact-list">
      <div v-for="f in facts" :key="f.userId + '|' + f.fact" class="fact-item">
        <div class="fact-main">
          <span class="fact-user">👤 {{ f.userId }}</span>
          <span class="fact-text">{{ f.fact }}</span>
        </div>
        <span class="fact-time">{{ formatTime(f.updatedAt) }}</span>
        <button class="btn tiny danger" @click="del(f.userId, f.fact)">删除</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { fetchFacts, addFact, removeFact, type UserFact } from "../../api";

const facts = ref<UserFact[]>([]);
const loading = ref(false);
const newUserId = ref("");
const newFact = ref("");

async function load() {
  loading.value = true;
  try {
    const data = await fetchFacts();
    facts.value = data.facts || [];
  } catch (e) {
    console.error("Failed to load facts", e);
  } finally {
    loading.value = false;
  }
}

async function add() {
  await addFact(newUserId.value.trim(), newFact.value.trim());
  newUserId.value = "";
  newFact.value = "";
  await load();
}

async function del(userId: string, fact: string) {
  if (!confirm("确定删除这条事实？")) return;
  await removeFact(userId, fact);
  await load();
}

function formatTime(ts: number) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit" });
}

onMounted(load);
</script>

<style scoped>
.desc { font-size: 13px; color: var(--text-dim); margin-bottom: 8px; }
.desc code { background: var(--bg-tertiary, rgba(0,0,0,0.06)); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.form-row { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }
.input.grow { flex: 1; min-width: 200px; }
.filter-bar { display: flex; gap: 12px; margin: 12px 0; align-items: center; }
.count { font-size: 12px; color: var(--text-dim); }
.fact-list { max-height: 500px; overflow-y: auto; }
.fact-item { display: flex; align-items: center; gap: 10px; background: var(--bg-secondary); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.fact-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fact-user { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: var(--bg-tertiary, rgba(0,0,0,0.08)); color: var(--text-muted); font-family: monospace; }
.fact-text { font-size: 13px; word-break: break-all; }
.fact-time { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.btn.tiny { padding: 4px 8px; font-size: 11px; }
.danger { color: var(--error) !important; border-color: var(--error) !important; }
.empty-state { text-align: center; padding: 30px; color: var(--text-dim); font-size: 14px; }
</style>
