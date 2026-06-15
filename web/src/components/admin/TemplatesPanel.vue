<template>
  <div class="card">
    <h2>📋 消息模板</h2>
    <div class="desc">管理预设回复模板，快速发送常用消息</div>

    <div style="display: flex; gap: 10px; margin-top: 16px; margin-bottom: 16px">
      <button class="btn" @click="showForm = !showForm">{{ showForm ? '收起' : '➕ 新建模板' }}</button>
    </div>

    <div v-if="showForm" style="margin-bottom: 20px; padding: 16px; background: var(--bg-skeleton-1); border-radius: 8px">
      <div class="field">
        <label>模板名称</label>
        <input v-model="form.name" class="input" placeholder="如：感谢回复" />
      </div>
      <div class="field">
        <label>模板内容</label>
        <textarea v-model="form.content" class="input" rows="3" placeholder="输入模板内容..."></textarea>
      </div>
      <div class="field">
        <label>分类（可选）</label>
        <input v-model="form.category" class="input" placeholder="如：问候、通知、常用" />
      </div>
      <div style="display: flex; gap: 10px">
        <button class="btn" :disabled="!form.name || !form.content || saving" @click="handleSave">
          {{ saving ? "保存中..." : editingId ? "更新" : "保存" }}
        </button>
        <button class="btn secondary" @click="resetForm">取消</button>
      </div>
    </div>

    <div v-if="loading" class="skeleton-grid">
      <div v-for="i in 3" :key="i" class="skeleton-item"></div>
    </div>

    <div v-else-if="templates.length === 0" class="empty-state">暂无模板，点击上方按钮创建</div>

    <div v-else>
      <div v-for="tpl in templates" :key="tpl.id" class="template-item">
        <div style="display: flex; justify-content: space-between; align-items: start">
          <div style="flex: 1">
            <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px">
              {{ tpl.name }}
              <span v-if="tpl.category" style="font-size: 11px; padding: 2px 6px; background: var(--alert-info-bg); color: var(--alert-info-text); border-radius: 4px; margin-left: 6px">{{ tpl.category }}</span>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all">{{ tpl.content }}</div>
          </div>
          <div style="display: flex; gap: 6px; flex-shrink: 0; margin-left: 12px">
            <button class="btn-link" @click="$emit('send', tpl.content)">发送</button>
            <button class="btn-link" @click="startEdit(tpl)">编辑</button>
            <button class="btn-link" style="color: var(--error)" @click="handleDelete(tpl.id)">删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { fetchTemplates, createTemplate, updateTemplate, deleteTemplate, type Template } from "../../api";

defineEmits(["send"]);

const templates = ref<Template[]>([]);
const loading = ref(false);
const saving = ref(false);
const showForm = ref(false);
const editingId = ref("");
const form = ref({ name: "", content: "", category: "" });

async function load() {
  loading.value = true;
  try {
    const d = await fetchTemplates();
    templates.value = d.templates || [];
  } catch {} finally { loading.value = false; }
}

async function handleSave() {
  saving.value = true;
  try {
    if (editingId.value) {
      await updateTemplate({ id: editingId.value, ...form.value });
    } else {
      await createTemplate(form.value);
    }
    resetForm();
    await load();
  } catch {} finally { saving.value = false; }
}

async function handleDelete(id: string) {
  if (!confirm("确定删除此模板？")) return;
  try { await deleteTemplate(id); await load(); } catch {}
}

function startEdit(tpl: Template) {
  editingId.value = tpl.id;
  form.value = { name: tpl.name, content: tpl.content, category: tpl.category || "" };
  showForm.value = true;
}

function resetForm() {
  editingId.value = "";
  form.value = { name: "", content: "", category: "" };
  showForm.value = false;
}

onMounted(load);
</script>

<style scoped>
.template-item {
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: var(--bg-card);
  transition: background 0.3s;
}
.template-item:hover { background: var(--bg-hover); }
.btn-link {
  background: none; border: none; color: var(--link); cursor: pointer;
  font-size: 12px; padding: 2px 6px;
}
.btn-link:hover { text-decoration: underline; }
.empty-state { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
.skeleton-item { height: 60px; background: linear-gradient(90deg, var(--bg-skeleton-1) 25%, var(--bg-skeleton-2) 50%, var(--bg-skeleton-1) 75%); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: 8px; }
@keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
