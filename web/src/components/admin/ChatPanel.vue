<template>
  <div class="card">
    <h2>🤖 AI 测试聊天</h2>
    <div class="desc">直接与 AI 对话，测试回复效果和配置</div>

    <div class="chat-box">
      <div v-if="messages.length === 0" style="text-align: center; color: var(--text-dim); padding: 40px 20px">
        👋 开始输入你的问题吧...
      </div>
      <div v-for="(msg, i) in messages" :key="i" class="msg" :class="msg.role">
        <div class="bubble">
          <template v-if="renderMessage(msg.text).isImage">
            <div v-html="renderMessage(msg.text).html"></div>
          </template>
          <template v-else>
            {{ renderMessage(msg.text).text }}
          </template>
        </div>
      </div>
    </div>

    <div class="chat-input">
      <input
        :value="input"
        @input="$emit('update:input', ($event.target as HTMLInputElement).value)"
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

defineEmits(["send", "update:input"]);

function renderMessage(text: string): { isImage: boolean; html: string; text: string } {
  // 检测 markdown 图片：![alt](url) — 支持 data: URL 和普通 http URL
  const imgMatch = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (imgMatch) {
    const alt = imgMatch[1] || "生成的图片";
    const src = imgMatch[2];
    const prefix = text.slice(0, text.indexOf(imgMatch[0]));
    const suffix = text.slice(text.indexOf(imgMatch[0]) + imgMatch[0].length);
    return {
      isImage: true,
      html: `${prefix ? `<div style="margin-bottom:8px">${prefix}</div>` : ''}<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:8px;margin:4px 0" />${suffix ? `<div style="margin-top:8px">${suffix}</div>` : ''}`,
      text,
    };
  }
  return { isImage: false, html: "", text };
}
</script>
