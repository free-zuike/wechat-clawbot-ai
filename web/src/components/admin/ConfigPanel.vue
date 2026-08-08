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
          <div class="field"><label>AI 模型</label><div class="model-input-row"><input v-model="config.aiModel" class="input" placeholder="@cf/meta/llama-3.2-3b-instruct" /><button class="btn tiny secondary" @click="fetchModels('text')">获取模型</button></div></div>
          <div class="field"><label>图片生成模型</label><div class="model-input-row"><input v-model="config.aiImageModel" class="input" placeholder="@cf/black-forest-labs/flux-1-schnell" /><button class="btn tiny secondary" @click="fetchModels('image')">获取模型</button></div><div class="field-hint">用于"画一只猫"等图片生成指令</div></div>
          <div class="field"><label>视频生成模型</label><div class="model-input-row"><input v-model="config.aiVideoModel" class="input" placeholder="bytedance/seedance-2.0-fast" /><button class="btn tiny secondary" @click="fetchModels('video')">获取模型</button></div><div class="field-hint">用于"生成视频"等视频生成指令</div></div>
          <div v-if="modelList.length > 0" class="model-list">
            <div class="model-list-header">
              <span>可用模型 ({{ modelListType }})</span>
              <button class="btn tiny secondary" @click="modelList = []">关闭</button>
            </div>
            <div v-for="m in modelList" :key="m.id" class="model-item" @click="selectModel(m)">
              <span class="model-name">{{ m.name }}</span>
              <span class="model-id">{{ m.id }}</span>
              <span :class="['model-tier', m.tier]">{{ m.tier === 'free' ? '免费' : '付费' }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="config.aiProvider" class="form-section">
          <h4>{{ getCurrentProviderName() }}</h4>
          <p class="form-desc">OpenAI 兼容的 API 接口</p>
          <div class="field"><label>AI 模型</label><input v-model="config.aiModel" class="input" placeholder="glm-4-flash" /></div>
          <div class="field"><label>图片生成模型</label><input v-model="config.aiImageModel" class="input" placeholder="如不支持可留空" /><div class="field-hint">用于"画一只猫"等图片生成指令</div></div>
          <div class="field"><label>视频生成模型</label><input v-model="config.aiVideoModel" class="input" placeholder="如不支持可留空" /><div class="field-hint">用于"生成视频"等视频生成指令</div></div>
          <details class="config-details">
            <summary style="cursor:pointer;color:#888;font-size:13px">⚙️ 响应格式配置（高级，默认自动适配）</summary>
            <div style="margin-top:8px">
              <div class="field-hint" style="margin-bottom:8px">配置 API 响应中的 JSON 路径，让系统自动提取图片/视频。标准 OpenAI 格式无需配置。</div>
              <div class="field"><label>图片 URL 路径</label><input v-model="responseConfig.imageUrlPath" class="input" placeholder="data[0].url" /><div class="field-hint">从响应 JSON 提取图片 URL 的路径</div></div>
              <div class="field"><label>图片 Base64 路径</label><input v-model="responseConfig.imageBase64Path" class="input" placeholder="data[0].b64_json" /></div>
              <div class="field"><label>参考图参数名</label><input v-model="responseConfig.imageRefParam" class="input" placeholder="image" /></div>
              <div class="field"><label>参考图参数位置</label>
                <select v-model="responseConfig.imageRefLocation" class="input">
                  <option value="extra_body">extra_body（默认）</option>
                  <option value="top_level">顶层</option>
                </select>
              </div>
              <div class="field"><label>视频任务 ID 路径</label><input v-model="responseConfig.videoSubmitIdPath" class="input" placeholder="task_id" /></div>
              <div class="field"><label>视频提交路径</label><input v-model="responseConfig.videoSubmitPath" class="input" placeholder="/videos/generations" /></div>
              <div class="field"><label>视频状态查询路径</label><input v-model="responseConfig.videoCheckPath" class="input" placeholder="/agnesapi?video_id={taskId}" /><div class="field-hint">用 {taskId} 占位符</div></div>
              <div class="field"><label>视频 URL 路径</label><input v-model="responseConfig.videoCheckUrlPath" class="input" placeholder="data[0].url" /></div>
              <div class="field"><label>视频状态路径</label><input v-model="responseConfig.videoCheckStatusPath" class="input" placeholder="status" /></div>
              <div class="field"><label>完成状态值</label><input v-model="responseConfig.videoCheckCompleted" class="input" placeholder="SUCCESS" /></div>
              <div class="field"><label>失败状态值</label><input v-model="responseConfig.videoCheckFailed" class="input" placeholder="FAIL" /></div>
            </div>
          </details>
          <div class="field"><label>API 地址</label><input v-model="config.aiBaseUrl" class="input" placeholder="https://api.example.com" /><div class="field-hint">不要加 /v1/chat/completions 后缀</div></div>
          <div class="field"><label>API 密钥</label><input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." /></div>
          <div class="field">
            <label>备用密钥（密钥序号：主密钥=1，备用依次=2, 3...）</label>
            <div class="backup-keys">
              <div v-for="(key, idx) in backupKeys" :key="idx" class="backup-key-row">
                <span class="key-num">密钥{{ idx + 2 }}</span>
                <input :value="key" class="input" type="password" placeholder="sk-..." @input="updateBackupKey(idx, $event)" />
                <button class="btn tiny danger" @click="removeBackupKey(idx)">✕</button>
              </div>
              <button class="btn secondary tiny" @click="addBackupKey">+ 添加密钥</button>
            </div>
          </div>
          <div class="field"><label>重试次数</label><input v-model.number="config.aiMaxRetries" class="input" type="number" min="0" max="10" placeholder="2" /><div class="field-hint">使用备用密钥重试的最大次数（0=不重试）</div></div>
        </div>
        <div v-else class="form-empty">← 从左侧选择提供商</div>
        <div v-if="config.aiProvider" class="field" style="margin-top: 12px"><label>最大 Token 数</label><input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" /></div>
        <div v-if="config.aiProvider" class="field"><label>上下文窗口（字符数）</label><input v-model.number="config.aiMaxContextChars" class="input" type="number" min="1000" max="4000000" placeholder="12000" /><div class="field-hint">模型支持的最大上下文长度，根据模型自动填充。太小会丢失对话历史，太大会浪费 Token</div></div>
        <div v-if="config.aiProvider" class="field">
          <label class="checkbox-label">
            <input type="checkbox" v-model="config.aiThinking" />
            🧠 开启 Thinking 模式（深度思考）
          </label>
          <div class="field-hint">开启后模型会先推理再回答，对复杂问题效果更好，但会增加响应时间和 Token 消耗</div>
        </div>
      </div>
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
      <div v-if="showRenameModal" class="modal-overlay" @click.self="showRenameModal = false">
        <div class="modal">
          <div class="modal-header"><h3>修改提供商名称</h3><button class="modal-close" @click="showRenameModal = false">&times;</button></div>
          <div class="modal-body">
            <div class="field"><label>名称</label><input v-model="renameInput" class="input" placeholder="提供商名称" @keyup.enter="confirmRename" /></div>
          </div>
          <div class="modal-footer"><button class="btn secondary" @click="showRenameModal = false">取消</button><button class="btn" @click="confirmRename">确认</button></div>
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
  imageModel: string;
  videoModel: string;
  baseUrl: string;
  apiKey: string;
  apiKeys?: string[];
  maxTokens: number;
  maxContextChars?: number;
  thinking?: boolean;
  responseConfig?: Record<string, string>;
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
    aiImageModel: string;
    aiVideoModel: string;
    aiBaseUrl: string;
    aiApiKey: string;
    aiMaxTokens: number;
    aiMaxContextChars?: number;
    aiSystemPrompt: string;
    webhookEnabled: boolean;
    webhookUrl: string;
    webhookTitle: string;
    webhookApiKey: string;
    webhookChannels: string[];
    aiCustomProviders: CustomProvider[];
    aiPresets?: Preset[];
    aiMaxRetries?: number;
    aiThinking?: boolean;
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
    preset = { id, model: "", imageModel: "", videoModel: "", baseUrl: "", apiKey: "", apiKeys: [], maxTokens: 1024, maxContextChars: 12000 };
    presets.push(preset);
  }
  // 模型名变化时自动填充上下文长度
  if (fields.model && fields.model !== preset.model) {
    fields.maxContextChars = guessModelContextChars(fields.model);
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
      imageModel: props.config.aiImageModel || "",
      videoModel: props.config.aiVideoModel || "",
      baseUrl: props.config.aiBaseUrl,
      apiKey: props.config.aiApiKey,
      apiKeys: [...backupKeys.value],
      maxTokens: props.config.aiMaxTokens,
    });
  }

  // 加载新提供商配置
  props.config.aiProvider = id;
  if (id === "cloudflare") {
    props.config.aiModel = preset?.model || "@cf/meta/llama-3.2-3b-instruct";
    props.config.aiImageModel = preset?.imageModel || "@cf/black-forest-labs/flux-1-schnell";
    props.config.aiVideoModel = preset?.videoModel || "";
    props.config.aiBaseUrl = "";
    props.config.aiApiKey = "";
    backupKeys.value = [];
    props.config.aiMaxTokens = preset?.maxTokens || 1024;
    props.config.aiMaxContextChars = preset?.maxContextChars || 12000;
  } else {
    props.config.aiModel = preset?.model || "";
    props.config.aiImageModel = preset?.imageModel || "";
    props.config.aiVideoModel = preset?.videoModel || "";
    props.config.aiBaseUrl = preset?.baseUrl || "";
    props.config.aiApiKey = preset?.apiKey || "";
    backupKeys.value = [...(preset?.apiKeys || [])];
    props.config.aiMaxTokens = preset?.maxTokens || 1024;
    props.config.aiMaxContextChars = preset?.maxContextChars || 12000;
    responseConfig.value = { ...(preset?.responseConfig || {}) };
  }
}

const backupKeys = ref<string[]>([]);
const responseConfig = ref<Record<string, string>>({});

function addBackupKey() { backupKeys.value.push(""); }
function removeBackupKey(idx: number) { backupKeys.value.splice(idx, 1); }
function updateBackupKey(idx: number, event: Event) {
  const val = (event.target as HTMLInputElement).value;
  backupKeys.value[idx] = val;
}

function deleteProvider(id: string, event: Event) {
  event.stopPropagation();
  if (!confirm("确定删除此提供商？该提供商的配置也将被删除。")) return;

  const idx = (props.config.aiCustomProviders || []).findIndex(p => p.id === id);
  if (idx !== -1) props.config.aiCustomProviders.splice(idx, 1);
  removePreset(id);

  if (props.config.aiProvider === id) {
    // 自动填入 Agnes AI 默认配置
    const agnesPreset = ensurePresets().find(p => p.id === "agnes");
    if (agnesPreset) {
      selectProvider("agnes");
    } else {
      selectProvider("cloudflare");
    }
  }
  emit("save");
}

function getCurrentProviderName() {
  const p = (props.config.aiCustomProviders || []).find(x => x.id === props.config.aiProvider);
  return p ? p.name : "OpenAI 兼容";
}

// 常见模型上下文窗口（字符数），根据模型名自动匹配
const MODEL_CONTEXT: Record<string, number> = {
  "deepseek": 128000, "deepseek-v3": 128000, "deepseek-r1": 128000,
  "gpt-4o": 128000, "gpt-4": 128000, "gpt-4-turbo": 128000, "gpt-4o-mini": 128000,
  "claude": 200000, "claude-3": 200000, "claude-sonnet": 200000, "claude-haiku": 200000,
  "gemini": 1000000, "gemini-pro": 1000000, "gemini-flash": 1000000,
  "qwen": 128000, "qwen2": 128000, "qwen-turbo": 128000, "qwen-plus": 128000,
  "glm": 128000, "glm-4": 128000, "glm-4-flash": 128000,
  "yi": 200000, "yi-lightning": 200000,
  "moonshot": 128000, "kimi": 128000,
  "mistral": 128000, "mixtral": 128000,
  "llama": 128000, "llama-3": 128000,
  "doubao": 128000, "volc": 128000,
  "ernie": 128000, "文心": 128000,
  "hunyuan": 128000, "混元": 128000,
  "spark": 128000, "讯飞": 128000, "星火": 128000,
  "baichuan": 128000, "百川": 128000,
  "minimax": 1000000,
  "step": 128000, "阶跃": 128000,
};

function guessModelContextChars(model: string): number {
  if (!model) return 12000;
  const lower = model.toLowerCase();
  for (const [key, val] of Object.entries(MODEL_CONTEXT)) {
    if (lower.includes(key)) return val;
  }
  return 12000;
}

const showAddModal = ref(false);
const showRenameModal = ref(false);
const renameTarget = ref<{ id: string; name: string } | null>(null);
const renameInput = ref("");
const newName = ref("");
const newIcon = ref("🤖");
const availableIcons = ["🤖", "🧠", "⚡", "🔧", "🌟", "🎯", "🚀", "💡", "🔥", "✨"];

function renameProvider(id: string, event: Event) {
  event.stopPropagation();
  const provider = props.config.aiCustomProviders.find(p => p.id === id);
  if (!provider) return;
  renameTarget.value = { id, name: provider.name };
  renameInput.value = provider.name;
  showRenameModal.value = true;
}

function confirmRename() {
  if (!renameTarget.value || !renameInput.value.trim()) return;
  const provider = props.config.aiCustomProviders.find(p => p.id === renameTarget.value!.id);
  if (provider) {
    provider.name = renameInput.value.trim();
    emit("save");
  }
  showRenameModal.value = false;
  renameTarget.value = null;
}

function handleSave() {
  syncCurrentToPreset();
  emit("save");
}

function syncCurrentToPreset() {
  const id = props.config.aiProvider;
  if (!id) return;
  // 过滤空值
  const rc: Record<string, string> = {};
  for (const [k, v] of Object.entries(responseConfig.value)) {
    if (v && v.trim()) rc[k] = v.trim();
  }
  upsertPreset(id, {
    model: props.config.aiModel,
    imageModel: props.config.aiImageModel || "",
    videoModel: props.config.aiVideoModel || "",
    baseUrl: props.config.aiBaseUrl,
    apiKey: props.config.aiApiKey,
    apiKeys: [...backupKeys.value],
    maxTokens: props.config.aiMaxTokens,
    maxContextChars: props.config.aiMaxContextChars || 12000,
    thinking: props.config.aiThinking || false,
    responseConfig: Object.keys(rc).length > 0 ? rc : undefined,
  });
}

// ===== 模型获取 =====
const modelList = ref<Array<{ id: string; name: string; type: string; tier: string; provider: string }>>([]);
const modelListType = ref("");
const modelListTarget = ref<"aiModel" | "aiImageModel" | "aiVideoModel">("aiModel");

async function fetchModels(type: string) {
  modelListType.value = type;
  if (type === "text") modelListTarget.value = "aiModel";
  else if (type === "image") modelListTarget.value = "aiImageModel";
  else modelListTarget.value = "aiVideoModel";

  try {
    const resp = await fetch("/api/ai-models", {
      headers: { Authorization: `Bearer ${localStorage.getItem("clawbot_auth") || ""}` },
    });
    const data = await resp.json();
    if (data.models) {
      modelList.value = data.models.filter((m: any) => m.type === type);
    }
  } catch (e: any) {
    modelList.value = [];
  }
}

function selectModel(m: any) {
  props.config[modelListTarget.value] = m.id;
  modelList.value = [];
}

// 监听编辑字段变化，实时同步到当前提供商的预设
watch(
  () => [props.config.aiModel, props.config.aiImageModel, props.config.aiVideoModel, props.config.aiBaseUrl, props.config.aiApiKey, props.config.aiMaxTokens],
  () => { if (props.config.aiProvider) syncCurrentToPreset(); },
  { deep: true }
);

// 页面加载时，从当前提供商的 preset 中恢复 backupKeys
watch(
  () => props.config.aiPresets,
  (presets) => {
    if (!presets || !props.config.aiProvider) return;
    const preset = presets.find(p => p.id === props.config.aiProvider);
    if (preset && backupKeys.value.length === 0) {
      backupKeys.value = [...(preset.apiKeys || [])];
    }
  },
  { immediate: true }
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
.model-input-row { display: flex; gap: 6px; align-items: center; }
.model-input-row .input { flex: 1; }
.model-list { margin-top: 8px; border: 1px solid var(--border-light); border-radius: 8px; max-height: 200px; overflow-y: auto; }
.model-list-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border-light); }
.model-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; transition: background 0.15s; font-size: 12px; }
.model-item:hover { background: var(--bg-skeleton-1); }
.model-name { font-weight: 500; flex: 1; }
.model-id { color: var(--text-muted); font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-tier { padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
.model-tier.free { background: var(--alert-success-bg); color: var(--alert-success-text); }
.model-tier.paid { background: var(--alert-warn-bg); color: var(--alert-warn-text); }
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
.backup-keys { display: flex; flex-direction: column; gap: 6px; }
.backup-key-row { display: flex; gap: 6px; align-items: center; }
.key-num { font-size: 12px; font-weight: 600; color: var(--text-muted); min-width: 40px; }
.backup-key-row .input { flex: 1; }
.btn.tiny { padding: 4px 10px; font-size: 12px; }
.btn.danger { color: var(--error); border-color: var(--error); }
</style>
