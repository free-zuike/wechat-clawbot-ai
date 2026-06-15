<template>
  <div class="card">
    <h2>⚙️ 系统配置</h2>
    <div class="desc">配置 AI 提供商、模型和人设提示词</div>

    <div class="field">
      <label>AI 提供商</label>
      <select v-model="config.aiProvider" class="input">
        <option value="cloudflare">Cloudflare Workers AI</option>
        <option value="openai">OpenAI 兼容 API（DeepSeek/通义千问/Moonshot/智谱GLM 等）</option>
      </select>
    </div>

    <div class="field">
      <label>AI 模型</label>
      <input
        v-model="config.aiModel"
        class="input"
        :placeholder="config.aiProvider === 'openai' ? 'deepseek-chat / qwen-turbo / glm-4-flash' : '@cf/meta/llama-3-8b-instruct'"
      />
      <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
        {{ config.aiProvider === 'openai' ? '填写对应平台的模型名称' : '留空使用默认模型 @cf/meta/llama-3.2-3b-instruct' }}
      </div>
    </div>

    <template v-if="config.aiProvider === 'openai'">
      <div class="field">
        <label>API 地址</label>
        <input v-model="config.aiBaseUrl" class="input" placeholder="https://api.deepseek.com" />
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
          OpenAI 兼容接口地址，不要加 /v1/chat/completions 后缀
        </div>
      </div>

      <div class="field">
        <label>API 密钥</label>
        <input v-model="config.aiApiKey" class="input" type="password" placeholder="sk-..." />
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
          已有密钥时留空不修改，填写新密钥则覆盖
        </div>
      </div>

      <div class="field">
        <label>最大 Token 数</label>
        <input v-model.number="config.aiMaxTokens" class="input" type="number" min="1" max="32000" placeholder="1024" />
      </div>
    </template>

    <div class="field">
      <label>人设提示词 (system prompt)</label>
      <textarea v-model="config.aiSystemPrompt" class="input" placeholder="你是爪爪，一个友好的 AI 助手..." rows="8"></textarea>
      <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
        定义机器人的性格和行为。留空使用默认人设
      </div>
    </div>

    <!-- Webhook 通知 -->
    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-light)">
      <h3 style="margin-bottom: 12px; font-size: 14px">🔔 Webhook 通知</h3>
      <div class="field">
        <label>
          <input type="checkbox" v-model="config.webhookEnabled" style="margin-right: 6px" />
          启用消息推送通知
        </label>
      </div>
      <template v-if="config.webhookEnabled">
        <div class="field">
          <label>推送地址</label>
          <input v-model="config.webhookUrl" class="input" placeholder="https://beeswarm.xxx.workers.dev/api/admin/webhook/push" />
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
            bee-swarm 的 Webhook 推送 API 地址
          </div>
        </div>
        <div class="field">
          <label>API 密钥</label>
          <input v-model="config.webhookApiKey" class="input" type="password" placeholder="Bearer 认证的 API Key" />
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
            已有密钥时留空不修改
          </div>
        </div>
        <div class="field">
          <label>通知标题</label>
          <input v-model="config.webhookTitle" class="input" placeholder="🦞 ClawBot AI 消息" />
        </div>
        <div class="field">
          <label>推送渠道</label>
          <input v-model="webhookChannelsStr" class="input" placeholder="wework,dingtalk,telegram" />
          <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px">
            用逗号分隔，如: wework,dingtalk,feishu,telegram
          </div>
        </div>
      </template>
    </div>

    <div style="display: flex; gap: 10px; margin-top: 16px">
      <button class="btn secondary" @click="$emit('load')">📥 加载当前配置</button>
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
