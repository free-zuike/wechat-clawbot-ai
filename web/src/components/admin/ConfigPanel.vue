<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <div class="field">
      <label>AI 提供商</label>
      <select v-model="config.aiProvider" class="input">
        <option value="cloudflare">Cloudflare Workers AI</option>
        <option value="openai">OpenAI 兼容 API</option>
      </select>
    </div>

    <div class="field">
      <label>AI 模型</label>
      <input v-model="config.aiModel" class="input" :placeholder="config.aiProvider === 'openai' ? 'glm-4-flash / deepseek-chat' : '@cf/meta/llama-3-8b-instruct'" />
    </div>

    <template v-if="config.aiProvider === 'openai'">
      <div class="field">
        <label>API 地址</label>
        <input v-model="config.aiBaseUrl" class="input" placeholder="https://api.example.com" />
        <div class="field-hint">不要加 /v1/chat/completions 后缀</div>
      </div>
      <div class="field">
        <label>API 密钥</label>
        <input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." />
      </div>
    </template>

    <div class="field">
      <label>最大 Token 数</label>
      <input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" />
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  config: { aiProvider: string; aiModel: string; aiBaseUrl: string; aiApiKey: string; aiMaxTokens: number; aiSystemPrompt: string; webhookEnabled: boolean; webhookUrl: string; webhookTitle: string; webhookApiKey: string; webhookChannels: string[] };
  result: string;
  saving: boolean;
}>();

defineEmits(["load", "save"]);

const webhookChannelsStr = computed({
  get: () => (props.config.webhookChannels || []).join(","),
  set: (val: string) => { props.config.webhookChannels = val.split(",").map(s => s.trim()).filter(Boolean); },
});
</script>

<style scoped>
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
</style>
