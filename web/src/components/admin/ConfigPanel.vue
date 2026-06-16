<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <div class="ai-layout">
      <div class="ai-sidebar">
        <div class="sidebar-title">🤖 AI 提供商</div>
        <div class="provider-item" :class="{ active: config.aiProvider === 'cloudflare' }" @click="selectProvider('cloudflare')">
          <span class="provider-icon">☁️</span>
          <span class="provider-name">Cloudflare AI</span>
          <span v-if="config.aiProvider === 'cloudflare'" class="provider-check">✓</span>
        </div>
        <div v-for="p in config.aiCustomProviders" :key="p.id" class="provider-item" :class="{ active: config.aiProvider === p.id }" @click="selectProvider(p.id)">
          <span class="provider-icon">{{ p.icon }}</span>
          <span class="provider-name">{{ p.name }}</span>
          <span class="provider-rename" @click.stop="renameProvider(p.id, $event)">✏️</span>
          <span class="provider-delete" @click.stop="deleteProvider(p.id, $event)">🗑️</span>
          <span v-if="config.aiProvider === p.id" class="provider-check">✓</span>
        </div>
        <div class="provider-item add" @click="showAddModal = true">
          <span class="provider-icon">+</span>
          <span class="provider-name">添加提供商</span>
        </div>
      </div>

      <div class="ai-form">
        <div v-if="config.aiProvider === 'cloudflare'" class="form-section">
          <h4>☁️ Cloudflare Workers AI</h4>
          <p class="form-desc">使用 Cloudflare 绑定，无需 API 地址和密钥</p>
          <div class="field"><label>AI 模型</label><input v-model="config.aiModel" class="input" placeholder="@cf/meta/llama-3.2-3b-instruct" /></div>
        </div>
        <div v-else-if="config.aiProvider" class="form-section">
          <h4>{{ getCurrentProviderName() }}</h4>
          <p class="form-desc">OpenAI 兼容的 API 接口</p>
          <div class="field"><label>AI 模型</label><input v-model="config.aiModel" class="input" placeholder="glm-4-flash" /></div>
          <div class="field"><label>API 地址</label><input v-model="config.aiBaseUrl" class="input" placeholder="https://api.example.com" /><div class="field-hint">不要加 /v1/chat/completions 后缀</div></div>
          <div class="field"><label>API 密钥</label><input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." /></div>
        </div>
        <div v-else class="form-empty">← 从左侧选择提供商</div>
        <div v-if="config.aiProvider" class="field" style="margin-top: 12px"><label>最大 Token 数</label><input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" /></div>
      </div>
    </div>

    <div class="field" style="margin-top: 16px">
      <label>人设提示词</label>
      <textarea v-model="config.aiSystemPrompt" class="input" placeholder="你是爪爪，一个友好的 AI 助手..." rows="6"></textarea>
    </div>

    <div class="webhook-section">
      <div class="section-header">
        <span class="section-title">🔔 Webhook 通知</span>
        <label class="toggle"><input type="checkbox" v-model="config.webhookEnabled" /><span class="toggle-slider"></span></label>
      </div>
      <template v-if="config.webhookEnabled">
        <div class="field"><label>推送地址</label><input v-model="config.webhookUrl" class="input" placeholder="https://beeswarm.xxx.workers.dev/api/admin/webhook/push" /></div>
        <div class="field"><label>API 密钥</label><input v-model="config.webhookApiKey" class="input" type="password" placeholder="X-API-Key" /></div>
        <div class="field"><label>通知标题</label><input v-model="config.webhookTitle" class="input" placeholder="ClawBot AI" /></div>
        <div class="field"><label>推送渠道</label><input v-model="webhookChannelsStr" class="input" placeholder="wework,dingtalk,telegram" /></div>
      </template>
    </div>

    <div class="save-bar">
      <button class="btn secondary" @click="$emit('load')">📥 加载</button>
      <button class="btn" :disabled="saving" @click="handleSave">{{ saving ? '保存中...' : '💾 保存配置' }}</button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">{{ result }}</div>

    <Teleport to="body">
      <div v-if="showAddModal" class="modal-overlay" @click.self="showAddModal = false">
        <div class="modal">
          <div class="modal-header"><h3>添加自定义 AI 提供商</h3><button class="modal-close" @click="showAddModal = false">&times;</button></div>
          <div class="modal-body">
            <div class="field"><label>提供商名称</label><input v-model="newName" class="input" placeholder="如：智谱GLM" /></div>
            <div class="field"><label>图标</label>
              <div class="icon-grid"><span v-for="icon in availableIcons" :key="icon" class="icon-option" :class="{ active: newIcon === icon }" @click="newIcon = icon">{{ icon }}</span></div>
            </div>
          </div>
          <div class="modal-footer"><button class="btn secondary" @click="showAddModal = false">取消</button><button class="btn" @click="addProvider">添加</button></div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";

interface Preset {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
}

interface CustomProvider {
  id: string;
  name: string;
  icon: string;
}

const props = defineProps<{
  config: {
    aiProvider: string;
    aiModel: string;
    aiBaseUrl: string;
    aiApiKey: string;
    aiMaxTokens: number;
    aiSystemPrompt: string;
    webhookEnabled: boolean;
    webhookUrl: string;
    webhookTitle: string;
    webhookApiKey: string;
    webhookChannels: string[];
    aiCustomProviders: CustomProvider[];
    aiPresets?: Preset[];
  };
  result: string;
  saving: boolean;
}>();

const emit = defineEmits(["load", "save"]);

const webhookChannelsStr = computed({
  get: () => (props.config.webhookChannels || []).join(","),
  set: (val: string) => { props.config.webhookChannels = val.split(",").map(s => s.trim()).filter(Boolean); },
});

function ensurePresets(): Preset[] {
  if (!props.config.aiPresets) props.config.aiPresets = [];
  return props.config.aiPresets;
}

function upsertPreset(id: string, fields: Partial<Preset>): Preset {
  const presets = ensurePresets();
  let preset = presets.find(p => p.id === id);
  if (!preset) {
    preset = { id, model: "", baseUrl: "", apiKey: "", maxTokens: 1024 };
    presets.push(preset);
  }
  Object.assign(preset, fields);
  return preset;
}

function removePreset(id: string) {
  const presets = ensurePresets();
  const idx = presets.findIndex(p => p.id === id);
  if (idx !== -1) presets.splice(idx, 1);
}

function selectProvider(id: string) {
  const presets = ensurePresets();
  const preset = presets.find(p => p.id === id);

  // 保存当前提供商配置到预设
  const currentId = props.config.aiProvider;
  if (currentId) {
    upsertPreset(currentId, {
      model: props.config.aiModel,
      baseUrl: props.config.aiBaseUrl,
      apiKey: props.config.aiApiKey,
      maxTokens: props.config.aiMaxTokens,
    });
  }

  // 加载新提供商配置
  props.config.aiProvider = id;
  if (id === "cloudflare") {
    props.config.aiModel = preset?.model || "@cf/meta/llama-3.2-3b-instruct";
    props.config.aiBaseUrl = "";
    props.config.aiApiKey = "";
    props.config.aiMaxTokens = preset?.maxTokens || 1024;
  } else {
    props.config.aiModel = preset?.model || "";
    props.config.aiBaseUrl = preset?.baseUrl || "";
    props.config.aiApiKey = preset?.apiKey || "";
    props.config.aiMaxTokens = preset?.maxTokens || 1024;
  }
}

function deleteProvider(id: string, event: Event) {
  event.stopPropagation();
  if (!confirm("确定删除此提供商？该提供商的配置也将被删除。")) return;

  const idx = (props.config.aiCustomProviders || []).findIndex(p => p.id === id);
  if (idx !== -1) props.config.aiCustomProviders.splice(idx, 1);
  removePreset(id);

  if (props.config.aiProvider === id) {
    selectProvider("cloudflare");
  }
  emit("save");
}

function getCurrentProviderName() {
  const p = (props.config.aiCustomProviders || []).find(x => x.id === props.config.aiProvider);
  return p ? p.name : "OpenAI 兼容";
}

function renameProvider(id: string, event: Event) {
  event.stopPropagation();
  const provider = props.config.aiCustomProviders.find(p => p.id === id);
  if (!provider) return;
  const newName = prompt("修改提供商名称", provider.name);
  if (newName !== null && newName.trim()) {
    provider.name = newName.trim();
    emit("save");
  }
}

const showAddModal = ref(false);
const newName = ref("");
const newIcon = ref("🤖");
const availableIcons = ["🤖", "🧠", "⚡", "🔧", "🌟", "🎯", "🚀", "💡", "🔥", "✨"];

function addProvider() {
  if (!newName.value.trim()) return;
  const id = "custom_" + Date.now();

  if (!props.config.aiCustomProviders) props.config.aiCustomProviders = [];
  props.config.aiCustomProviders.push({ id, name: newName.value.trim(), icon: newIcon.value });
  upsertPreset(id, { model: "", baseUrl: "", apiKey: "", maxTokens: 1024 });
  selectProvider(id);

  newName.value = "";
  newIcon.value = "🤖";
  showAddModal.value = false;
}

function handleSave() {
  syncCurrentToPreset();
  emit("save");
}

function syncCurrentToPreset() {
  const id = props.config.aiProvider;
  if (!id) return;
  upsertPreset(id, {
    model: props.config.aiModel,
    baseUrl: props.config.aiBaseUrl,
    apiKey: props.config.aiApiKey,
    maxTokens: props.config.aiMaxTokens,
  });
}

// 监听编辑字段变化，实时同步到当前提供商的预设
watch(
  () => [props.config.aiModel, props.config.aiBaseUrl, props.config.aiApiKey, props.config.aiMaxTokens],
  () => { if (props.config.aiProvider) syncCurrentToPreset(); },
  { deep: true }
);
</script>

<style scoped>
.ai-layout { display: flex; gap: 16px; margin-bottom: 16px; }
.ai-sidebar { width: 180px; flex-shrink: 0; border: 1px solid var(--border-light); border-radius: 8px; overflow: hidden; }
.sidebar-title { padding: 10px 12px; font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--border-light); }
.provider-item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; transition: background 0.15s; font-size: 13px; }
.provider-item:hover { background: var(--bg-skeleton-1); }
.provider-item.active { background: var(--alert-info-bg); font-weight: 600; }
.provider-item.add { color: var(--link); justify-content: center; }
.provider-icon { font-size: 16px; }
.provider-name { flex: 1; }
.provider-check { color: var(--link); font-weight: bold; }
.provider-delete { font-size: 12px; cursor: pointer; opacity: 0.5; transition: opacity 0.15s; }
.provider-delete:hover { opacity: 1; }
.provider-rename { font-size: 12px; cursor: pointer; opacity: 0.5; transition: opacity 0.15s; }
.provider-rename:hover { opacity: 1; }
.ai-form { flex: 1; min-width: 0; }
.form-section h4 { margin: 0 0 8px; font-size: 14px; }
.form-desc { font-size: 12px; color: var(--text-secondary); margin-bottom: 12px; }
.form-empty { padding: 40px; text-align: center; color: var(--text-dim); }
.field-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
.webhook-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-title { font-weight: 600; font-size: 14px; }
.save-bar { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
.toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg-skeleton-1); border-radius: 22px; transition: 0.3s; }
.toggle-slider::before { content: ""; position: absolute; width: 18px; height: 18px; left: 2px; bottom: 2px; background: white; border-radius: 50%; transition: 0.3s; }
.toggle input:checked + .toggle-slider { background: var(--link); }
.toggle input:checked + .toggle-slider::before { transform: translateX(18px); }
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--bg-card); border-radius: 12px; width: 400px; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
.modal-header h3 { margin: 0; font-size: 16px; }
.modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-secondary); }
.modal-body { padding: 16px 20px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border-light); }
.icon-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.icon-option { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: 2px solid var(--border-light); border-radius: 6px; cursor: pointer; font-size: 18px; transition: all 0.15s; }
.icon-option:hover { border-color: var(--link); }
.icon-option.active { border-color: var(--link); background: var(--alert-info-bg); }
</style>
