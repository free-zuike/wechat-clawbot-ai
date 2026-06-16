<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <!-- AI 提供商预设卡片 -->
    <div class="provider-section">
      <div class="section-header">
        <span class="section-title">🤖 AI 提供商</span>
        <button class="btn-link" @click="addPreset">+ 新增</button>
      </div>

      <div v-if="presets.length === 0" class="preset-grid">
        <div class="preset-card active" @click="selectCloudflare">
          <div class="preset-icon">☁️</div>
          <div class="preset-name">Cloudflare Workers AI</div>
          <div class="preset-model">默认免费模型</div>
        </div>
      </div>

      <div v-else class="preset-grid">
        <div
          class="preset-card"
          :class="{ active: selectedPresetId === 'cloudflare' }"
          @click="selectCloudflare"
        >
          <div class="preset-icon">☁️</div>
          <div class="preset-name">Cloudflare AI</div>
          <div class="preset-model">免费</div>
        </div>

        <div
          v-for="p in presets"
          :key="p.id"
          class="preset-card"
          :class="{ active: selectedPresetId === p.id }"
          @click="selectPreset(p)"
        >
          <div class="preset-actions-top">
            <button class="preset-action" @click.stop="editPreset(p)">✏️</button>
            <button class="preset-action danger" @click.stop="deletePreset(p.id)">🗑️</button>
          </div>
          <div class="preset-name">{{ p.name }}</div>
          <div class="preset-model">{{ p.model }}</div>
          <div class="preset-url">{{ getHost(p.baseUrl) }}</div>
        </div>

        <div class="preset-card add" @click="addPreset">
          <div class="preset-icon">➕</div>
          <div class="preset-name">新增配置</div>
        </div>
      </div>
    </div>

    <!-- 当前配置详情 -->
    <div class="config-detail">
      <div class="field">
        <label>AI 模型</label>
        <input
          v-model="config.aiModel"
          class="input"
          :placeholder="config.aiProvider === 'openai' ? 'deepseek-chat / qwen-turbo' : '@cf/meta/llama-3-8b-instruct'"
        />
      </div>

      <template v-if="config.aiProvider === 'openai'">
        <div class="field">
          <label>API 地址</label>
          <input v-model="config.aiBaseUrl" class="input" placeholder="https://api.deepseek.com" />
          <div class="field-hint">不要加 /v1/chat/completions 后缀</div>
        </div>
        <div class="field">
          <label>API 密钥</label>
          <input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." />
        </div>
        <div class="field">
          <label>最大 Token 数</label>
          <input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" />
        </div>
      </template>
    </div>

    <!-- 人设提示词 -->
    <div class="field">
      <label>人设提示词</label>
      <textarea v-model="config.aiSystemPrompt" class="input" placeholder="你是爪爪，一个友好的 AI 助手..." rows="6"></textarea>
    </div>

    <!-- Webhook -->
    <div class="webhook-section">
      <div class="section-header">
        <span class="section-title">🔔 Webhook 通知</span>
        <label class="toggle">
          <input type="checkbox" v-model="config.webhookEnabled" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <template v-if="config.webhookEnabled">
        <div class="field">
          <label>推送地址</label>
          <input v-model="config.webhookUrl" class="input" placeholder="https://beeswarm.xxx.workers.dev/api/admin/webhook/push" />
        </div>
        <div class="field">
          <label>API 密钥</label>
          <input v-model="config.webhookApiKey" class="input" type="password" placeholder="X-API-Key" />
        </div>
        <div class="field">
          <label>通知标题</label>
          <input v-model="config.webhookTitle" class="input" placeholder="ClawBot AI" />
        </div>
        <div class="field">
          <label>推送渠道</label>
          <input v-model="webhookChannelsStr" class="input" placeholder="wework,dingtalk,telegram" />
          <div class="field-hint">用逗号分隔</div>
        </div>
      </template>
    </div>

    <!-- 保存 -->
    <div class="save-bar">
      <button class="btn secondary" @click="$emit('load')">📥 加载</button>
      <button class="btn" :disabled="saving" @click="$emit('save')">
        {{ saving ? "保存中..." : "💾 保存配置" }}
      </button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">{{ result }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{
  config: { aiProvider: string; aiModel: string; aiBaseUrl: string; aiApiKey: string; aiMaxTokens: number; aiSystemPrompt: string; webhookEnabled: boolean; webhookUrl: string; webhookTitle: string; webhookApiKey: string; webhookChannels: string[]; aiPresets: Array<{ id: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; maxTokens: number }> };
  result: string;
  saving: boolean;
}>();

const emit = defineEmits(["load", "save"]);

const webhookChannelsStr = computed({
  get: () => (props.config.webhookChannels || []).join(","),
  set: (val: string) => { props.config.webhookChannels = val.split(",").map(s => s.trim()).filter(Boolean); },
});

const showPresetManager = ref(false);
const presets = computed(() => props.config.aiPresets || []);

// 模态框状态
const showModal = ref(false);
const modalMode = ref<"edit" | "add">("add");
const modalPreset = ref<any>(null);
const modalName = ref("");
const modalModel = ref("");
const modalBaseUrl = ref("");
const modalApiKey = ref("");
const modalMaxTokens = ref(1024);

function selectCloudflare() {
  selectedPresetId.value = "cloudflare";
  props.config.aiProvider = "cloudflare";
  props.config.aiModel = "";
  props.config.aiBaseUrl = "";
  props.config.aiApiKey = "";
  props.config.aiMaxTokens = 1024;
}

function selectPreset(preset: any) {
  selectedPresetId.value = preset.id;
  props.config.aiProvider = preset.provider;
  props.config.aiModel = preset.model;
  props.config.aiBaseUrl = preset.baseUrl;
  props.config.aiApiKey = preset.apiKey;
  props.config.aiMaxTokens = preset.maxTokens;
}

function addPreset() {
  const name = prompt("输入预设名称：", props.config.aiModel || "我的AI");
  if (!name) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (!props.config.aiPresets) props.config.aiPresets = [];
  props.config.aiPresets.push({
    id, name,
    provider: props.config.aiProvider,
    model: props.config.aiModel,
    baseUrl: props.config.aiBaseUrl,
    apiKey: props.config.aiApiKey,
    maxTokens: props.config.aiMaxTokens,
  });
  selectedPresetId.value = id;
}

function editPreset(preset: any) {
  const newName = prompt("修改预设名称：", preset.name);
  if (newName !== null && newName) preset.name = newName;
}

function deletePreset(id: string) {
  if (!confirm("确定删除此预设？")) return;
  const idx = presets.value.findIndex(p => p.id === id);
  if (idx !== -1) {
    props.config.aiPresets.splice(idx, 1);
    if (selectedPresetId.value === id) selectCloudflare();
  }
}

function getHost(url: string) {
  if (!url) return "-";
  try { return new URL(url).hostname; } catch { return url.slice(0, 25); }
}
</script>

<style scoped>
.section-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
}
.section-title { font-weight: 600; font-size: 14px; }

.preset-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px; margin-bottom: 20px;
}
.preset-card {
  position: relative;
  border: 2px solid var(--border-light); border-radius: 10px;
  padding: 12px; text-align: center; cursor: pointer;
  transition: all 0.2s; background: var(--bg-card);
}
.preset-card:hover { border-color: var(--link); }
.preset-card.active { border-color: var(--link); background: var(--link-bg, rgba(59,130,246,0.1)); }
.preset-card.add { border-style: dashed; opacity: 0.7; }
.preset-card.add:hover { opacity: 1; }
.preset-icon { font-size: 24px; margin-bottom: 6px; }
.preset-name { font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 2px; }
.preset-model { font-size: 11px; color: var(--text-secondary); }
.preset-url { font-size: 10px; color: var(--text-dim); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-actions-top {
  position: absolute; top: 6px; right: 6px;
  display: flex; gap: 2px; opacity: 0; transition: opacity 0.2s;
}
.preset-card:hover .preset-actions-top { opacity: 1; }
.preset-action {
  background: none; border: none; cursor: pointer; font-size: 12px;
  padding: 2px 4px; border-radius: 4px;
}
.preset-action:hover { background: var(--bg-skeleton-1); }
.preset-action.danger:hover { background: var(--alert-error-bg); }

.config-detail { margin-bottom: 16px; }
.field-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
.webhook-section {
  margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light);
}
.save-bar { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
.btn-link { background: none; border: none; color: var(--link); cursor: pointer; font-size: 13px; }
.btn-link:hover { text-decoration: underline; }

.toggle { position: relative; display: inline-block; width: 40px; height: 22px; cursor: pointer; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background: var(--bg-skeleton-1); border-radius: 22px; transition: 0.3s;
}
.toggle-slider::before {
  content: ""; position: absolute; width: 18px; height: 18px;
  left: 2px; bottom: 2px; background: white; border-radius: 50%; transition: 0.3s;
}
.toggle input:checked + .toggle-slider { background: var(--link); }
.toggle input:checked + .toggle-slider::before { transform: translateX(18px); }
</style>
