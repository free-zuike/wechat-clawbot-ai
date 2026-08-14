<template>
  <div class="card">
    <h2>🛠️ 内置工具设置</h2>
    <div class="desc">配置内置工具的参数</div>

    <div class="tool-section">
      <h3>🗞️ 中文新闻 (get_news)</h3>
      <div class="desc">默认使用 NewsNow 公共实例，无需配置即可用；公共实例可能不稳，可自建：<a href="https://github.com/ourongxing/newsnow" target="_blank" rel="noopener">ourongxing/newsnow</a>（Cloudflare Pages 构建：<code>pnpm run build</code>，输出 <code>dist/output/public</code>）</div>
      <div class="field"><label>NewsNow 地址</label><input v-model="config.newsnowBaseUrl" class="input" placeholder="https://newsnow.xxx.workers.dev" /><div class="field-hint">留空使用默认公共实例 newsnow.busiyi.world</div></div>
    </div>

    <div class="tool-section">
      <h3>🔍 网页搜索 (web_search)</h3>
      <div class="desc">依赖自建项目 <a href="https://github.com/Yrobot/cloudflare-search" target="_blank" rel="noopener">Yrobot/cloudflare-search</a>（聚合 Google/Brave/DuckDuckGo/Bing）。<strong>未部署时该工具不可用</strong>，AI 会提示"搜索服务未配置"。部署：<code>git clone ... && npx wrangler deploy</code> 后填入 Worker 地址</div>
      <div class="field"><label>搜索服务地址</label><input v-model="config.searchBaseUrl" class="input" placeholder="https://your-search.workers.dev" /><div class="field-hint">cloudflare-search 的 Worker 地址</div></div>
      <div class="field"><label>Token（可选）</label><input v-model="config.searchToken" class="input" type="password" placeholder="如配置了 TOKEN 则必填" /><div class="field-hint">cloudflare-search 的鉴权 Token</div></div>
      <div class="field">
        <label>🔎 搜索测试</label>
        <div class="search-test-row">
          <select v-model="searchType" class="input type-select">
            <option value="web">🌐 网页搜索</option>
            <option value="image">🖼️ 图片搜索</option>
          </select>
          <input v-model="searchQuery" class="input" placeholder="输入搜索关键词测试" @keyup.enter="testSearch" />
          <button class="btn tiny" :disabled="searching" @click="testSearch">{{ searching ? '搜索中...' : '搜索测试' }}</button>
        </div>
        <div v-if="searchResult" :class="['search-result-box', searchResult.isError ? 'error' : '']">
          <div v-if="searchResult.isError" class="search-error">{{ searchResult.error }}</div>
          <div v-else-if="searchResult.type === 'image'" class="image-grid">
            <template v-if="(searchResult.items || []).length > 0">
              <a v-for="(item, i) in searchResult.items" :key="item.url" :href="item.url" target="_blank" rel="noopener" class="image-item" :title="item.title">
                <img :src="item.thumb || item.url" :alt="item.title || '图片'" loading="lazy" @error="removeImage(searchResult, item)" />
              </a>
              <div class="search-result-header">共 {{ searchResult.items.length }} 张图片（点击查看原图，已自动过滤无法加载的）</div>
            </template>
            <div v-else class="search-empty">所有图片都无法加载</div>
          </div>
          <div v-else class="search-items">
            <div class="search-result-header">共 {{ searchResult.items.length }} 条结果</div>
            <div v-for="(item, i) in searchResult.items" :key="i" class="search-item">
              <a :href="item.url" target="_blank" rel="noopener" class="search-item-title">{{ item.title }}</a>
              <a :href="item.url" target="_blank" rel="noopener" class="search-item-url">{{ item.url }}</a>
              <div v-if="item.description" class="search-item-desc">{{ item.description }}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="field">
        <label>🌐 搜索优先级</label>
        <select v-model="config.searchEngine" class="input">
          <option value="">自动（cloudflare-search → 浏览器）</option>
          <option value="browser">优先使用浏览器（浏览器 → cloudflare-search）</option>
        </select>
        <div class="field-hint">选择搜索源的优先顺序。浏览器搜索每天免费 10 分钟，不会被限流</div>
      </div>
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
  config: { newsnowBaseUrl?: string; searchBaseUrl?: string; searchToken?: string; searchEngine?: string; allowlist?: string };
}>();
const saving = ref(false);
const result = ref("");
const searchQuery = ref("");
const searchType = ref("web");
const searching = ref(false);
const searchResult = ref<{ isError: boolean; type?: string; items?: any[]; error?: string } | null>(null);

// 图片加载失败时从结果中移除（自动过滤无法访问的图片）
function removeImage(result: any, item: any) {
  if (!result || !Array.isArray(result.items)) return;
  const idx = result.items.findIndex((x: any) => x.url === item.url || x.thumb === item.thumb);
  if (idx !== -1) result.items.splice(idx, 1);
}

async function handleSave() {
  saving.value = true;
  result.value = "保存中...";
  try {
    const d = await saveConfig({
      newsnowBaseUrl: props.config.newsnowBaseUrl || "",
      searchBaseUrl: props.config.searchBaseUrl || "",
      searchToken: props.config.searchToken || "",
      searchEngine: props.config.searchEngine || "",
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

async function testSearch() {
  const q = searchQuery.value.trim();
  if (!q) return;
  const baseUrl = props.config.searchBaseUrl?.trim();
  const token = props.config.searchToken?.trim();
  const isImage = searchType.value === "image";

  searching.value = true;
  searchResult.value = null;
  try {
    // 图片搜索始终走后端 API（浏览器搜索）
    if (!isImage && baseUrl) {
      const url = token
        ? `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}`
        : `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        searchResult.value = { isError: true, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` };
        return;
      }
      const data = await resp.json() as any;
      const items = data?.results || data?.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        const errors = data?.errors || [];
        const diag = errors.length > 0
          ? errors.map((e: any) => `${e.engine}: ${e.error}`).join("；")
          : (data?.unresponsive_engines?.length
            ? `（以下引擎无响应: ${data.unresponsive_engines.join(", ")}）`
            : "（引擎无返回结果）");
        searchResult.value = { isError: true, error: `搜索结果为空\n${diag}` };
        return;
      }
      searchResult.value = { isError: false, type: "web", items: items.slice(0, 8) };
      return;
    }

    // 浏览器搜索（网页或图片）
    const authToken = localStorage.getItem("clawbot_auth") || "";
    const resp = await fetch(`/api/search-test?q=${encodeURIComponent(q)}&type=${isImage ? "image" : "web"}`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json() as any;
    if (!data.ok) {
      searchResult.value = { isError: true, error: data.error || "搜索失败" };
      return;
    }
    searchResult.value = {
      isError: false,
      type: data.type || (isImage ? "image" : "web"),
      items: (data.items || []).slice(0, isImage ? 12 : 8),
    };
  } catch (e: any) {
    searchResult.value = { isError: true, error: `请求失败: ${e?.message || "未知错误"}` };
  } finally {
    searching.value = false;
  }
}
</script>

<style scoped>
.tool-section { margin-top: 16px; padding: 12px; border: 1px solid var(--border-light); border-radius: 8px; }
.tool-section h3 { margin: 0 0 4px; font-size: 15px; }
.desc { font-size: 12px; color: var(--text-dim); margin-bottom: 8px; line-height: 1.6; }
.desc a { color: var(--link); }
.desc code { background: var(--bg-skeleton-1); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.textarea { min-height: 96px; resize: vertical; font-family: monospace; font-size: 12px; }
.field-hint { font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.search-test-row { display: flex; gap: 6px; align-items: center; }
.search-test-row .input { flex: 1; }
.type-select { width: 120px; flex-shrink: 0; }
.search-result-box { margin-top: 8px; padding: 10px; border-radius: 6px; border: 1px solid var(--border-light); font-size: 12px; max-height: 300px; overflow-y: auto; }
.search-result-box.error { background: var(--alert-error-bg); color: var(--alert-error-text); white-space: pre-wrap; }
.search-error { color: var(--alert-error-text); }
.search-result-header { font-size: 11px; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; }
.search-items { display: flex; flex-direction: column; gap: 8px; }
.search-item { padding: 6px 8px; border-radius: 4px; background: var(--bg-skeleton-1); }
.search-item-title { font-weight: 600; color: var(--link); text-decoration: none; display: block; }
.search-item-title:hover { text-decoration: underline; }
.search-item-url { font-size: 11px; color: var(--text-muted); word-break: break-all; margin: 2px 0; display: block; text-decoration: none; }
.search-item-url:hover { text-decoration: underline; }
.search-item-desc { font-size: 11px; color: var(--text-secondary); }
.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.image-item { display: block; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-light); background: var(--bg-skeleton-1); aspect-ratio: 1; }
.image-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.search-empty { text-align: center; color: var(--text-dim); padding: 12px; }
.save-bar { margin-top: 16px; }
.result-box { margin-top: 12px; padding: 10px; border-radius: 6px; border: 1px solid var(--border-light); font-size: 13px; }
.result-box.success { background: var(--alert-success-bg); color: var(--alert-success-text); border-color: var(--alert-success-text); }
</style>