<template>
  <div class="card">
    <h2>🤖 AI 测试聊天</h2>
    <div class="desc">直接与 AI 对话，测试回复效果和配置</div>

    <div class="chat-box">
      <div v-if="messages.length === 0" style="text-align: center; color: var(--text-dim); padding: 40px 20px">
        👋 开始输入你的问题吧...
      </div>
      <div v-for="(msg, i) in messages" :key="i" class="msg" :class="msg.role">
        <div class="bubble">{{ msg.text }}</div>
      </div>
    </div>

    <div class="chat-input">
      <input
        v-model="input"
        class="input"
        placeholder="输入消息..."
        :disabled="loading"
        @keyup.enter="$emit('send')"
      />
      <button class="btn" :disabled="loading || !input.trim()" @click="$emit('send')">
        {{ loading ? "发送中..." : "发送" }}
      </button>
    </div>

    <div class="notice" style="margin-top: 16px">
      💬 <strong>提示：</strong>常见问候语使用本地快捷回复（零 Token 消耗），其他消息走 AI 模型。
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  messages: Array<{ role: string; text: string }>;
  input: string;
  loading: boolean;
}>();

defineEmits(["send"]);
</script>
