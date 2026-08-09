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
          <button class="action-btn" title="删除此消息" @click="$emit('delete-msg', i)">🗑️</button>
        </div>
      </div>
    </div>

    <div class="chat-input">
      <div v-if="quoteText" class="quote-bar">
        <span class="quote-icon">💬</span>
        <span class="quote-content">{{ quoteText.slice(0, 80) }}{{ quoteText.length > 80 ? '...' : '' }}</span>
        <button class="quote-close" @click="$emit('clear-quote')">✕</button>
      </div>
      <div v-if="searchImageUrl" class="ref-bar">
        <span class="ref-icon">🖼️</span>
        <span class="ref-content">参考图片已设置</span>
        <button class="quote-close" @click="searchImageUrl = ''">✕</button>
      </div>
      <div class="input-row">
        <input
          :value="input"
          @input="$emit('update:input', ($event.target as HTMLInputElement).value)"
          class="input"
          placeholder="输入消息，支持 /图片 描述 生成图片..."
          :disabled="loading"
          @keyup.enter="$emit('send')"
        />
        <button class="btn" :disabled="loading || !input.trim()" @click="$emit('send')">
          {{ loading ? "发送中..." : "发送" }}
        </button>
      </div>
    </div>

    <div class="chat-toolbar">
      <button class="btn secondary tiny" @click="$emit('clear-chat')">🗑️ 清空聊天</button>
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

const emit = defineEmits(["send", "update:input", "edit", "resend", "quote", "clear-quote", "clear-chat", "delete-msg", "search"]);

const hoverIdx = ref(-1);
const editingIdx = ref(-1);
const editText = ref("");
const searchImageUrl = ref("");

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
  // 检测 markdown 图片并全部转换为 <img> 标签
  if (/!\[([^\]]*)\]\(([^)]+)\)/.test(text)) {
    const html = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
      return `<img src="${src}" alt="${alt || '图片'}" style="max-width:100%;max-height:400px;border-radius:8px;margin:4px 0;object-fit:contain" />`;
    }).replace(/\n/g, "<br>");
    return { isImage: true, html, text };
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
  // 普通文本：渲染 Markdown 格式
  return { isImage: false, html: renderMarkdown(text), text };
}

// 简单的 Markdown 渲染器
function renderMarkdown(text: string): string {
  let html = text
    // 转义 HTML 特殊字符
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // 代码块 ```lang\n...\n```
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`)
    // 行内代码 `code`
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // 删除线 ~~text~~
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // 粗体 **text**
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // 斜体 *text*
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // 链接 [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    // 水平分割线
    .replace(/^---$/gm, "<hr>")
    // 标题 # ~ ######
    .replace(/^###### (.+)$/gm, '<h6 style="margin:8px 0 4px;font-size:13px">$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5 style="margin:8px 0 4px;font-size:14px">$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:15px">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 style="margin:8px 0 4px;font-size:16px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="margin:8px 0 4px;font-size:17px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="margin:8px 0 4px;font-size:18px">$1</h1>')
    // 引用块 > text
    .replace(/^&gt; (.+)$/gm, '<blockquote style="margin:4px 0;padding:4px 10px;border-left:3px solid var(--link);background:var(--bg-skeleton-1);border-radius:0 4px 4px 0;color:var(--text-muted);font-size:13px">$1</blockquote>')
    // 无序列表 - item 或 * item（多行连续）
    .replace(/((?:^[*-] .+(?:\n|$))+)/gm, (m) => {
      const items = m.trim().split("\n").map(l => l.replace(/^[*-] /, "")).filter(Boolean);
      return '<ul style="margin:4px 0;padding-left:20px">' + items.map(i => `<li style="font-size:13px">${i}</li>`).join("") + '</ul>\n';
    })
    // 有序列表 1. item（多行连续）
    .replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (m) => {
      const items = m.trim().split("\n").map(l => l.replace(/^\d+\. /, "")).filter(Boolean);
      return '<ol style="margin:4px 0;padding-left:20px">' + items.map(i => `<li style="font-size:13px">${i}</li>`).join("") + '</ol>\n';
    })
    // 表格：| col1 | col2 |\n| --- | --- |\n| val1 | val2 |
    .replace(/\n?\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g, (_m, header, body) => {
      const headers = header.split("|").map(h => h.trim()).filter(Boolean);
      const rows = body.trim().split("\n").map(line =>
        line.split("|").map(c => c.trim()).filter(Boolean)
      );
      let table = '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px">';
      table += '<thead><tr>' + headers.map(h => `<th style="border:1px solid var(--border-light);padding:6px 8px;text-align:left;background:var(--bg-skeleton-1)">${h}</th>`).join("") + '</tr></thead>';
      table += '<tbody>' + rows.map(row => '<tr>' + row.map(c => `<td style="border:1px solid var(--border-light);padding:6px 8px">${c}</td>`).join("") + '</tr>').join("") + '</tbody>';
      table += '</table>';
      return table;
    })
    // 换行转为 <br>
    .replace(/\n/g, "<br>");
  return html;
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
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: absolute;
  top: 4px;
  right: 4px;
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
.ref-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  background: rgba(34,197,94,0.1);
  border-radius: 6px;
  font-size: 12px;
  color: var(--success);
  border-left: 3px solid var(--success);
}
.ref-icon, .quote-icon { flex-shrink: 0; }
.ref-content, .quote-content { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quote-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 0 4px; }
.quote-close:hover { color: var(--error); }
.input-row { display: flex; gap: 8px; align-items: center; }
.input-row .input { flex: 1; }
.chat-toolbar { display: flex; justify-content: flex-end; margin-top: 8px; }
.chat-toolbar .btn { font-size: 12px; padding: 4px 10px; }
.bubble :deep(blockquote) {
  margin: 0 0 8px 0;
  padding: 6px 10px;
  border-left: 3px solid var(--link, #6366f1);
  background: var(--bg-secondary, rgba(255,255,255,0.06));
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--text-muted);
}
.bubble :deep(code) {
  background: var(--bg-skeleton-1, rgba(255,255,255,0.08));
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 12px;
}
.bubble :deep(pre) {
  background: var(--bg-skeleton-1, rgba(255,255,255,0.08));
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 6px 0;
}
.bubble :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 12px;
}
.bubble :deep(a) {
  color: var(--link, #6366f1);
  text-decoration: underline;
}
.bubble :deep(strong) {
  font-weight: 600;
}
.bubble :deep(em) {
  font-style: italic;
}
.bubble :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-light);
  margin: 8px 0;
}
</style>
