<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <!-- AI 提供商选择 + 预设管理 -->
    <div class="ai-section">
      <div class="ai-header">
        <label>AI 提供商</label>
        <button class="btn-link" @click="showPresetManager = !showPresetManager">
          {{ showPresetManager ? '收起管理' : '管理预设' }}
        </button>
      </div>
      <div class="ai-selector">
        <select v-model="selectedPresetId" class="input" @change="applyPreset">
          <option value="cloudflare">Cloudflare Workers AI</option>
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }} ({{ p.model }})</option>
          <option value="__custom__">+ 自定义配置</option>
        </select>
      </div>

      <!-- 预设管理面板 -->
      <div v-if="showPresetManager" class="preset-manager">
        <div class="preset-header">已保存的预设</div>
        <div v-if="presets.length === 0" class="preset-empty">暂无保存的预设</div>
        <div v-for="p in presets" :key="p.id" class="preset-item">
          <span class="preset-name">{{ p.name }}</span>
          <span class="preset-model">{{ p.model }}</span>
          <div class="preset-actions">
            <button class="btn-link" @click="editPreset(p)">编辑</button>
            <button class="btn-link danger" @click="deletePreset(p.id)">删除</button>
          </div>
        </div>
        <button class="btn secondary small" style="width: 100%; margin-top: 8px" @click="saveCurrentAsPreset">
          + 保存当前配置为预设
        </button>
      </div>
    </div>

    <!-- AI 配置字段 -->
    <div class="ai-fields">
      <div class="field">
        <label>AI 模型</label>
        <input
          v-model="config.aiModel"
          class="input"
          :placeholder="config.aiProvider === 'openai' ? 'deepseek-chat / qwen-turbo / glm-4-flash' : '@cf/meta/llama-3-8b-instruct'"
        />
        <div class="field-hint">
          {{ config.aiProvider === 'openai' ? '填写对应平台的模型名称' : '留空使用默认模型 @cf/meta/llama-3.2-3b-instruct' }}
        </div>
      </div>

      <template v-if="config.aiProvider === 'openai'">
        <div class="field">
          <label>API 地址</label>
          <input v-model="config.aiBaseUrl" class="input" placeholder="https://api.deepseek.com" />
          <div class="field-hint">OpenAI 兼容接口地址，不要加 /v1/chat/completions 后缀</div>
        </div>

        <div class="field-row">
          <div class="field" style="flex: 1">
            <label>API 密钥</label>
            <input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." />
          </div>
          <div class="field" style="flex: 0 0 120px">
            <label>最大 Token 数</label>
            <input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" />
          </div>
        </div>
        <div class="field-hint">已有密钥时留空不修改，填写新密钥则覆盖</div>
      </template>
    </div>

    <!-- 人设提示词 -->
    <div class="field">
      <label>人设提示词 (system prompt)</label>
      <textarea v-model="config.aiSystemPrompt" class="input" placeholder="你是爪爪，一个友好的 AI 助手..." rows="6"></textarea>
      <div class="field-hint">定义机器人的性格和行为。留空使用默认人设</div>
    </div>

    <!-- Webhook 通知 -->
    <div class="webhook-section">
      <div class="webhook-header">
        <h3>🔔 Webhook 通知</h3>
        <label class="toggle">
          <input type="checkbox" v-model="config.webhookEnabled" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <template v-if="config.webhookEnabled">
        <div class="field">
          <label>推送地址</label>
          <input v-model="config.webhookUrl" class="input" placeholder="https://beeswarm.xxx.workers.dev/api/admin/webhook/push" />
          <div class="field-hint">bee-swarm 的 Webhook 推送 API 地址</div>
        </div>
        <div class="field-row">
          <div class="field" style="flex: 1">
            <label>API 密钥</label>
            <input v-model="config.webhookApiKey" class="input" type="password" placeholder="X-API-Key" />
          </div>
          <div class="field" style="flex: 0 0 180px">
            <label>通知标题</label>
            <input v-model="config.webhookTitle" class="input" placeholder="ClawBot AI" />
          </div>
        </div>
        <div class="field">
          <label>推送渠道</label>
          <input v-model="webhookChannelsStr" class="input" placeholder="wework,dingtalk,telegram" />
          <div class="field-hint">用逗号分隔，如: wework,dingtalk,feishu,telegram</div>
        </div>
      </template>
    </div>

    <!-- 保存按钮 -->
    <div class="save-bar">
      <button class="btn secondary" @click="$emit('load')">📥 加载</button>
      <button class="btn" :disabled="saving" @click="$emit('save')">
        {{ saving ? "保存中..." : "💾 保存配置" }}
      </button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">
      {{ result }}
    </div>
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

// ===== AI 提供商预设 =====
const selectedPresetId = ref("");
const showPresetManager = ref(false);
const presets = computed(() => props.config.aiPresets || []);

function applyPreset() {
  if (!selectedPresetId.value || selectedPresetId.value === "cloudflare") {
    props.config.aiProvider = "cloudflare";
    props.config.aiModel = "";
    props.config.aiBaseUrl = "";
    props.config.aiApiKey = "";
    props.config.aiMaxTokens = 1024;
    return;
  }
  if (selectedPresetId.value === "__custom__") return;

  const preset = presets.value.find(p => p.id === selectedPresetId.value);
  if (!preset) return;

  props.config.aiProvider = preset.provider;
  props.config.aiModel = preset.model;
  props.config.aiBaseUrl = preset.baseUrl;
  props.config.aiApiKey = preset.apiKey;
  props.config.aiMaxTokens = preset.maxTokens;
}

function saveCurrentAsPreset() {
  const name = prompt("输入预设名称：", props.config.aiModel || "我的AI");
  if (!name) return;

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const preset = {
    id,
    name,
    provider: props.config.aiProvider,
    model: props.config.aiModel,
    baseUrl: props.config.aiBaseUrl,
    apiKey: props.config.aiApiKey,
    maxTokens: props.config.aiMaxTokens,
  };

  if (!props.config.aiPresets) props.config.aiPresets = [];
  props.config.aiPresets.push(preset);
  selectedPresetId.value = id;
}

function editPreset(preset: { id: string; name: string }) {
  const newName = prompt("修改预设名称：", preset.name);
  if (newName === null) return;
  const p = presets.value.find(x => x.id === preset.id);
  if (p && newName) p.name = newName;
}

function deletePreset(id: string) {
  if (!confirm("确定删除此预设？")) return;
  const idx = presets.value.findIndex(p => p.id === id);
  if (idx !== -1) {
    props.config.aiPresets.splice(idx, 1);
    if (selectedPresetId.value === id) selectedPresetId.value = "";
  }
}
</script>

<style scoped>
.ai-section { margin-bottom: 16px; }
.ai-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.ai-header label { font-weight: 600; font-size: 14px; }
.ai-selector { width: 100%; }
.ai-fields { margin-bottom: 16px; }

.field-row { display: flex; gap: 12px; }

.field-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

.preset-manager {
  padding: 12px;
  background: var(--bg-skeleton-1);
  border-radius: 8px;
  margin-top: 8px;
}
.preset-header { font-size: 13px; color: var(--text-secondary); margin-bottom: 8px; }
.preset-empty { font-size: 12px; color: var(--text-dim); margin-bottom: 8px; }
.preset-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-bottom: 1px solid var(--border-light);
  font-size: 13px;
}
.preset-item:last-child { border-bottom: none; }
.preset-name { font-weight: 600; color: var(--text-primary); }
.preset-model { color: var(--text-secondary); font-size: 12px; flex: 1; }
.preset-actions { display: flex; gap: 4px; }

.btn-link {
  background: none; border: none; color: var(--link); cursor: pointer;
  font-size: 12px; padding: 2px 6px;
}
.btn-link:hover { text-decoration: underline; }
.btn-link.danger { color: var(--error); }

.webhook-section {
  margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light);
}
.webhook-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.webhook-header h3 { margin: 0; font-size: 14px; }

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

.save-bar { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
</style>
