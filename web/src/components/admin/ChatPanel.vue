<template>
  <div class="card">
    <h2>🤖 AI 测试聊天</h2>
    <div class="desc">直接与 AI 对话，测试回复效果和配置</div>

    <div class="chat-box">
      <div v-if="messages.length === 0" style="text-align: center; color: var(--text-dim); padding: 40px 20px">
        👋 开始输入你的问题吧...
      </div>
      <div v-for="(msg, i) in messages" :key="i" class="msg" :class="msg.role"
        @mouseenter="hoverIdx = i" @mouseleave="hoverIdx = -1">
        <div class="bubble">
          <!-- 编辑模式 -->
          <template v-if="editingIdx === i">
            <div class="edit-area">
              <textarea
                v-model="editText"
                class="edit-input"
                rows="3"
                @keydown.enter.ctrl="submitEdit"
                @keydown.escape="cancelEdit"
              ></textarea>
              <div class="edit-actions">
                <button class="btn small" @click="submitEdit">✓ 确认</button>
                <button class="btn small secondary" @click="cancelEdit">✗ 取消</button>
              </div>
            </div>
          </template>
          <!-- 普通显示 -->
          <template v-else>
            <template v-if="msg.role === 'b'">
              <div v-html="renderMessage(msg.text).html"></div>
            </template>
            <template v-else>
              {{ renderMessage(msg.text).text }}
            </template>
          </template>
        </div>
        <!-- 消息操作按钮 -->
        <div v-if="hoverIdx === i && editingIdx !== i" class="msg-actions">
          <button v-if="msg.role === 'u'" class="action-btn" title="编辑并重新发送" @click="startEdit(i, msg.text)">✏️</button>
          <button v-if="msg.role === 'u'" class="action-btn" title="重新发送" @click="$emit('resend', msg.text)">🔄</button>
          <button class="action-btn" title="引用此消息" @click="$emit('quote', msg.text)">💬</button>
        </div>
      </div>
    </div>

    <div class="chat-input">
      <div v-if="quoteText" class="quote-bar">
        <span class="quote-icon">💬</span>
        <span class="quote-content">{{ quoteText.slice(0, 80) }}{{ quoteText.length > 80 ? '...' : '' }}</span>
        <button class="quote-close" @click="$emit('clear-quote')">✕</button>
      </div>
      <div class="input-row">
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
    </div>

    <div class="notice" style="margin-top: 16px">
      💬 <strong>提示：</strong>常见问候语使用本地快捷回复（零 Token 消耗），其他消息走 AI 模型。
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  messages: Array<{ role: string; text: string }>;
  input: string;
  loading: boolean;
  quoteText?: string;
}>();

const emit = defineEmits(["send", "update:input", "edit", "resend", "quote", "clear-quote"]);

const hoverIdx = ref(-1);
const editingIdx = ref(-1);
const editText = ref("");

function startEdit(idx: number, text: string) {
  editingIdx.value = idx;
  editText.value = text;
}

function cancelEdit() {
  editingIdx.value = -1;
  editText.value = "";
}

function submitEdit() {
  if (editText.value.trim() && editingIdx.value >= 0) {
    emit("edit", editingIdx.value, editText.value.trim());
    editingIdx.value = -1;
    editText.value = "";
  }
}

function renderMessage(text: string): { isImage: boolean; html: string; text: string } {
  // 检测 markdown 图片
  const imgMatch = text.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (imgMatch) {
    const alt = imgMatch[1] || "生成的图片";
    const src = imgMatch[2];
    const prefix = text.slice(0, text.indexOf(imgMatch[0]));
    const suffix = text.slice(text.indexOf(imgMatch[0]) + imgMatch[0].length);
    return {
      isImage: true,
      html: `${prefix ? `<div style="margin-bottom:8px;white-space:pre-wrap">${prefix}</div>` : ''}<img src="${src}" alt="${alt}" style="max-width:100%;max-height:400px;border-radius:8px;margin:4px 0;object-fit:contain" />${suffix ? `<div style="margin-top:8px;white-space:pre-wrap">${suffix}</div>` : ''}`,
      text,
    };
  }
  // 检测视频标签
  const vidMatch = text.match(/<video[^>]+src="([^"]+)"[^>]*>/);
  if (vidMatch) {
    const src = vidMatch[1];
    const prefix = text.slice(0, text.indexOf(vidMatch[0]));
    const suffix = text.slice(text.indexOf(vidMatch[0]) + vidMatch[0].length);
    return {
      isImage: true,
      html: `${prefix ? `<div style="margin-bottom:8px;white-space:pre-wrap">${prefix}</div>` : ''}<video src="${src}" controls style="max-width:100%;max-height:400px;border-radius:8px;margin:4px 0"></video>${suffix ? `<div style="margin-top:8px;white-space:pre-wrap">${suffix}</div>` : ''}`,
      text,
    };
  }
  // 包含 HTML 标签（blockquote/video/img）时直接渲染
  if (/<[a-z][\s\S]*>/i.test(text)) {
    return { isImage: false, html: text, text };
  }
  return { isImage: false, html: text, text };
}
</script>

<style scoped>
.chat-box {
  max-height: 500px;
  overflow-y: auto;
}
.msg {
  position: relative;
}
.msg-actions {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}
.msg:hover .msg-actions {
  opacity: 1;
}
.action-btn {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 4px;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 12px;
  transition: background 0.2s;
}
.action-btn:hover {
  background: var(--border-light);
}
.edit-area {
  width: 100%;
}
.edit-input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
  font-family: inherit;
}
.edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.btn.secondary {
  background: var(--bg-card);
  color: var(--text-primary);
  border: 1px solid var(--border-light);
}
.quote-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: var(--bg-secondary, rgba(255,255,255,0.06));
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
  border-left: 3px solid var(--link);
}
.quote-icon { flex-shrink: 0; }
.quote-content { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quote-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 0 4px; }
.quote-close:hover { color: var(--error); }
.input-row { display: flex; gap: 8px; align-items: center; }
.input-row .input { flex: 1; }
.bubble :deep(blockquote) {
  margin: 0 0 8px 0;
  padding: 6px 10px;
  border-left: 3px solid var(--link, #6366f1);
  background: var(--bg-secondary, rgba(255,255,255,0.06));
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
