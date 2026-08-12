<template>
  <div class="card">
    <h2>🛠️ 内置工具设置</h2>
    <div class="desc">配置内置工具的参数</div>

    <div class="tool-section">
      <h3>🗞️ 中文新闻 (get_news)</h3>
      <div class="desc">默认使用 NewsNow 公共实例，配置地址可使用自己的部署</div>
      <div class="field"><label>NewsNow 地址</label><input v-model="config.newsnowBaseUrl" class="input" placeholder="https://newsnow.xxx.workers.dev" /><div class="field-hint">留空使用默认公共实例 newsnow.busiyi.world</div></div>
    </div>

    <div class="tool-section">
      <h3>🔍 网页搜索 (web_search)</h3>
      <div class="desc">部署 cloudflare-search 后配置地址，用于通用网页搜索（Google/Brave/DuckDuckGo）</div>
      <div class="field"><label>搜索服务地址</label><input v-model="config.searchBaseUrl" class="input" placeholder="https://your-search.workers.dev" /><div class="field-hint">cloudflare-search 的 Worker 地址</div></div>
      <div class="field"><label>Token（可选）</label><input v-model="config.searchToken" class="input" type="password" placeholder="如配置了 TOKEN 则必填" /><div class="field-hint">cloudflare-search 的鉴权 Token</div></div>
    </div>

    <div class="tool-section">
      <h3>🔒 白名单 / 访问控制</h3>
      <div class="desc">限制哪些微信用户可以使用 AI 对话。留空则允许所有用户</div>
      <div class="field"><label>允许的微信用户 ID</label><textarea v-model="config.allowlist" class="input textarea" placeholder="每行一个用户 ID，如&#10;o9cq80yyVD-TQD9y6IhjwKzg1cgA@im.wechat&#10;o9cq81xxVD-TQD9y6IhjwKzg2dhA@im.wechat" rows="4"></textarea><div class="field-hint">用户发消息时，日志会显示 from_user_id，复制过来即可</div></div>
    </div>

    <div class="save-bar">
      <button class="btn" :disabled="saving" @click="handleSave">{{ saving ? '保存中...' : '💾 保存配置' }}</button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">{{ result }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { saveConfig } from "../../api";

const props = defineProps<{
  config: { newsnowBaseUrl?: string; searchBaseUrl?: string; searchToken?: string; allowlist?: string };
}>();
const saving = ref(false);
const result = ref("");

async function handleSave() {
  saving.value = true;
  result.value = "保存中...";
  try {
    const d = await saveConfig({
      newsnowBaseUrl: props.config.newsnowBaseUrl || "",
      searchBaseUrl: props.config.searchBaseUrl || "",
      searchToken: props.config.searchToken || "",
      allowlist: props.config.allowlist || "",
    });
    if (d.ok) result.value = "✅ 工具配置已保存";
    else result.value = "❌ " + (d.error || "保存失败");
  } catch (e: any) {
    result.value = "❌ 保存失败: " + (e.message || "未知错误");
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.tool-section { margin-top: 16px; padding: 12px; border: 1px solid var(--border-light); border-radius: 8px; }
.tool-section h3 { margin: 0 0 4px; font-size: 15px; }
.desc { font-size: 12px; color: var(--text-dim); margin-bottom: 8px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.textarea { min-height: 96px; resize: vertical; font-family: monospace; font-size: 12px; }
.field-hint { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.save-bar { margin-top: 16px; }
.result-box { margin-top: 12px; padding: 10px; border-radius: 6px; border: 1px solid var(--border-light); font-size: 13px; }
.result-box.success { background: var(--alert-success-bg); color: var(--alert-success-text); border-color: var(--alert-success-text); }
</style>