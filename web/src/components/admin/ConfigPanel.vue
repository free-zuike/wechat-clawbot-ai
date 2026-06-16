<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <!-- AI 提供商预设卡片 -->
    <div class="provider-section">
      <div class="section-header">
        <span class="section-title">🤖 AI 提供商</span>
        <button class="btn secondary small" @click="openAddModal">+ 新增</button>
      </div>

      <div class="preset-grid">
        <div class="preset-card" :class="{ active: selectedPresetId === 'cloudflare' }" @click="selectCloudflare">
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
            <button class="preset-action" @click.stop="openEditModal(p)">✏️</button>
            <button class="preset-action danger" @click.stop="openDeleteModal(p)">🗑️</button>
          </div>
          <div class="preset-name">{{ p.name }}</div>
          <div class="preset-model">{{ p.model }}</div>
          <div class="preset-url">{{ getHost(p.baseUrl) }}</div>
        </div>
      </div>
    </div>

    <!-- 当前 AI 配置详情 -->
    <div class="config-detail">
      <div class="field">
        <label>AI 模型</label>
        <input v-model="config.aiModel" class="input" :placeholder="config.aiProvider === 'openai' ? 'deepseek-chat / qwen-turbo' : '@cf/meta/llama-3-8b-instruct'" />
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
        </div>
      </template>
    </div>

    <!-- 保存 -->
    <div class="save-bar">
      <button class="btn secondary" @click="$emit('load')">📥 加载</button>
      <button class="btn" :disabled="saving" @click="$emit('save')">{{ saving ? "保存中..." : "💾 保存配置" }}</button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">{{ result }}</div>

    <!-- 新增/编辑预设模态框 -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-overlay" @click.self="closeModal">
        <div class="modal">
          <div class="modal-header">
            <h3>{{ modalMode === 'add' ? '新增 AI 预设' : '编辑预设' }}</h3>
            <button class="modal-close" @click="closeModal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label>预设名称</label>
              <input v-model="modalName" class="input" placeholder="如：智谱GLM" />
            </div>
            <template v-if="modalMode === 'add'">
              <div class="field">
                <label>提供商</label>
                <select v-model="modalProvider" class="input">
                  <option value="openai">OpenAI 兼容</option>
                  <option value="cloudflare">Cloudflare</option>
                </select>
              </div>
              <div class="field"><label>模型名称</label><input v-model="modalModel" class="input" placeholder="glm-4-flash" /></div>
              <div class="field"><label>API 地址</label><input v-model="modalBaseUrl" class="input" placeholder="https://api.example.com" /></div>
              <div class="field"><label>API 密钥</label><input v-model="modalApiKey" class="input" type="password" placeholder="sk-..." /></div>
              <div class="field"><label>最大 Token 数</label><input v-model.number="modalMaxTokens" class="input" type="number" min="1" max="32000" /></div>
            </template>
            <template v-else>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:8px">点击"更新"仅修改预设名称</div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn secondary" @click="closeModal">取消</button>
            <button class="btn" @click="saveModal">{{ modalMode === 'add' ? '保存' : '更新' }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除确认模态框 -->
    <Teleport to="body">
      <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
        <div class="modal" style="width: 360px">
          <div class="modal-header">
            <h3>确认删除</h3>
            <button class="modal-close" @click="showDeleteModal = false">&times;</button>
          </div>
          <div class="modal-body">
            <p>确定要删除预设「{{ deleteTarget?.name }}」吗？此操作不可恢复。</p>
          </div>
          <div class="modal-footer">
            <button class="btn secondary" @click="showDeleteModal = false">取消</button>
            <button class="btn danger" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
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

const selectedPresetId = computed(() => props.config.aiActivePresetId || "cloudflare");

function selectCloudflare() {
  props.config.aiActivePresetId = "cloudflare";
  props.config.aiProvider = "cloudflare";
  props.config.aiModel = "";
  props.config.aiBaseUrl = "";
  props.config.aiApiKey = "";
  props.config.aiMaxTokens = 1024;
  emit("save");
}

function selectPreset(preset: any) {
  props.config.aiActivePresetId = preset.id;
  props.config.aiProvider = preset.provider;
  props.config.aiModel = preset.model;
  props.config.aiBaseUrl = preset.baseUrl;
  props.config.aiApiKey = preset.apiKey;
  props.config.aiMaxTokens = preset.maxTokens;
  emit("save");
}
const showModal = ref(false);
const modalMode = ref<"edit" | "add">("add");
const modalEditId = ref("");
const modalName = ref("");
const modalProvider = ref("openai");
const modalModel = ref("");
const modalBaseUrl = ref("");
const modalApiKey = ref("");
const modalMaxTokens = ref(1024);

function openAddModal() {
  modalMode.value = "add";
  modalEditId.value = "";
  modalName.value = "";
  modalProvider.value = "openai";
  modalModel.value = "";
  modalBaseUrl.value = "";
  modalApiKey.value = "";
  modalMaxTokens.value = 1024;
  showModal.value = true;
}

function openEditModal(preset: any) {
  modalMode.value = "edit";
  modalEditId.value = preset.id;
  modalName.value = preset.name;
  showModal.value = true;
}

function saveModal() {
  if (!modalName.value) return;
  if (modalMode.value === "add") {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!props.config.aiPresets) props.config.aiPresets = [];
    const newPreset = {
      id, name: modalName.value,
      provider: modalProvider.value, model: modalModel.value,
      baseUrl: modalBaseUrl.value, apiKey: modalApiKey.value, maxTokens: modalMaxTokens.value,
    };
    props.config.aiPresets.push(newPreset);
    props.config.aiActivePresetId = id;
    selectPreset(newPreset);
  } else {
    const p = presets.value.find(x => x.id === modalEditId.value);
    if (p) p.name = modalName.value;
  }
  closeModal();
}

// 删除模态框
const showDeleteModal = ref(false);
const deleteTarget = ref<any>(null);

function openDeleteModal(preset: any) {
  deleteTarget.value = preset;
  showDeleteModal.value = true;
}

function doDelete() {
  if (!deleteTarget.value) return;
  const idx = presets.value.findIndex(p => p.id === deleteTarget.value.id);
  if (idx !== -1) {
    props.config.aiPresets.splice(idx, 1);
    if (selectedPresetId.value === deleteTarget.value.id) selectCloudflare();
  }
  showDeleteModal.value = false;
  deleteTarget.value = null;
}

function closeModal() {
  showModal.value = false;
  modalEditId.value = "";
  modalName.value = "";
  modalModel.value = "";
  modalBaseUrl.value = "";
  modalApiKey.value = "";
  modalMaxTokens.value = 1024;
}
</script>

<style scoped>
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.section-title { font-weight: 600; font-size: 14px; }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
.preset-card {
  position: relative; border: 2px solid var(--border-light); border-radius: 10px;
  padding: 12px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--bg-card);
}
.preset-card:hover { border-color: var(--link); }
.preset-card.active { border-color: var(--link); background: rgba(59,130,246,0.1); }
.preset-icon { font-size: 24px; margin-bottom: 6px; }
.preset-name { font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 2px; }
.preset-model { font-size: 11px; color: var(--text-secondary); }
.preset-url { font-size: 10px; color: var(--text-dim); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-actions-top { position: absolute; top: 6px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity 0.2s; }
.preset-card:hover .preset-actions-top { opacity: 1; }
.preset-action { background: none; border: none; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 4px; }
.preset-action:hover { background: var(--bg-skeleton-1); }
.preset-action.danger:hover { background: var(--alert-error-bg); }
.config-detail { margin-bottom: 16px; }
.field-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
.webhook-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
.save-bar { display: flex; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-light); }
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--bg-card); border-radius: 12px; width: 400px; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
.modal-header h3 { margin: 0; font-size: 16px; }
.modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-secondary); }
.modal-body { padding: 16px 20px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border-light); }
</style>
