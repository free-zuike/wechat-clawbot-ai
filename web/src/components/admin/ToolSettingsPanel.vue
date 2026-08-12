<template>
  <div class="card">
    <h2>🛠️ 内置工具设置</h2>
    <div class="desc">配置内置工具（get_news、get_current_datetime 等）的参数</div>

    <div class="tool-section">
      <h3>🗞️ 中文新闻 (get_news)</h3>
      <div class="desc">默认使用 NewsNow 公共实例，如需使用自己的部署，配置地址</div>
      <div class="field"><label>NewsNow 地址</label><input v-model="config.newsnowBaseUrl" class="input" placeholder="https://newsnow.xxx.workers.dev" /><div class="field-hint">留空使用默认公共实例 newsnow.busiyi.world</div></div>
    </div>

    <div class="save-bar">
      <button class="btn" :disabled="saving" @click="handleSave">{{ saving ? '保存中...' : '💾 保存配置' }}</button>
    </div>
    <div v-if="result" :class="['result-box', result.includes('✅') ? 'success' : '']">{{ result }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { fetchConfig, saveConfig } from "../../api";

const props = defineProps<{
  config: { newsnowBaseUrl?: string };
}>();
const saving = ref(false);
const result = ref("");

async function handleSave() {
  saving.value = true;
  result.value = "保存中...";
  try {
    const d = await saveConfig({ newsnowBaseUrl: props.config.newsnowBaseUrl || "" });
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
.field-hint { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.save-bar { margin-top: 16px; }
.result-box { margin-top: 12px; padding: 10px; border-radius: 6px; border: 1px solid var(--border-light); font-size: 13px; }
.result-box.success { background: var(--alert-success-bg); color: var(--alert-success-text); border-color: var(--alert-success-text); }
</style>