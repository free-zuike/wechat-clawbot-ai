<template>
  <div class="card">
    <div class="section-header">
      <h2>🔌 MCP Server 管理</h2>
      <div class="header-actions">
        <button class="btn secondary" :disabled="loading" @click="loadServers">🔄 刷新</button>
        <button class="btn" @click="showForm(null)">+ 添加 MCP Server</button>
      </div>
    </div>
    <div class="desc">配置 MCP (Model Context Protocol) 服务器，AI 可在对话中调用其提供的工具</div>

    <!-- 服务器列表 -->
    <div v-if="servers.length === 0 && !loading" class="empty-state">
      暂无 MCP 服务器配置
    </div>
    <div v-for="s in servers" :key="s.id" class="mcp-server-item">
      <div class="server-header">
        <span class="server-name">{{ s.name }}</span>
        <span :class="['server-status', s.enabled ? 'enabled' : 'disabled']">
          {{ s.enabled ? '已启用' : '已禁用' }}
        </span>
        <div class="server-actions">
          <button class="btn tiny secondary" title="获取工具" @click="refreshTools(s.id)">🔄</button>
          <button class="btn tiny secondary" @click="editServer(s)">✏️</button>
          <button class="btn tiny danger" @click="deleteServer(s.id)">🗑️</button>
        </div>
      </div>
      <div class="server-url">{{ s.url }}</div>
      <div class="server-tools">
        <span class="tool-count">{{ (s.tools || []).length }} 个工具</span>
      </div>
      <div v-if="s.tools && s.tools.length > 0" class="tool-list">
        <div v-for="t in s.tools" :key="t.name" class="tool-item">
          <span class="tool-name">{{ t.name }}</span>
          <span class="tool-desc">{{ t.description || '无描述' }}</span>
        </div>
      </div>
    </div>

    <!-- 编辑/新增表单弹窗 -->
    <Teleport to="body">
      <div v-if="toast.show" :class="['toast', toast.type]">{{ toast.message }}</div>
      <div v-if="formVisible" class="modal-overlay" @click.self="formVisible = false">
        <div class="modal">
          <div class="modal-header">
            <h3>{{ editingId ? '编辑 MCP Server' : '添加 MCP Server' }}</h3>
            <button class="modal-close" @click="formVisible = false">&times;</button>
          </div>
          <div class="modal-body">
            <div class="field"><label>名称 *</label><input v-model="form.name" class="input" placeholder="如：天气查询服务" /></div>
            <div class="field"><label>URL *</label><input v-model="form.url" class="input" placeholder="https://example.com/mcp" /><div class="field-hint">MCP Server 端点地址（如 https://example.com/mcp），支持标准 Streamable HTTP 传输</div></div>
            <div class="field"><label>API Key（可选）</label><input v-model="form.apiKey" class="input" type="password" placeholder="可选" /></div>
            <div class="field"><label class="checkbox-label"><input type="checkbox" v-model="form.enabled" /> 启用</label></div>
            <div class="field"><label>工具前缀</label><input v-model="form.toolPrefix" class="input" placeholder="默认：mcp_服务ID" /><div class="field-hint">工具名称前缀，避免名称冲突。留空自动生成</div></div>
            <div class="field"><label>OAuth Client ID（可选）</label><input v-model="form.oauthClientId" class="input" placeholder="可选" /><div class="field-hint">MCP 服务器指定 OAuth 认证时填写</div></div>
            <div class="field"><label>OAuth Client Secret（可选）</label><input v-model="form.oauthClientSecret" class="input" type="password" placeholder="可选" /></div>
            <div v-if="editingId && (form.oauthAuthorizer || form.oauthToken)" class="oauth-section">
              <div class="field"><label>OAuth Authorization URL</label><input v-model="form.oauthAuthorizer" class="input" placeholder="自动发现" /><div class="field-hint">服务器自动发现或手动输入的授权端点</div></div>
              <div class="field"><label>手动 Access Token（可选）</label><input v-model="form.oauthToken" class="input" type="password" placeholder="已自动获取的或手动输入的 Token" /><div class="field-hint">从授权服务器获取到的 token，或自动获取的 token</div></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn secondary" @click="formVisible = false">取消</button>
            <button class="btn" :disabled="saving" @click="saveServer">{{ saving ? '保存中...' : '保存' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { fetchMCPServers, saveMCPServer, deleteMCPServer, refreshMCPTools, type MCPServer } from "../../api";

const servers = ref<MCPServer[]>([]);
const loading = ref(false);
const saving = ref(false);
const formVisible = ref(false);
const editingId = ref<string | null>(null);
const toast = ref({ show: false, message: "", type: "success" });
let toastTimer: any = null;

function showToast(message: string, type = "success") {
  toast.value = { show: true, message, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3000);
}
const form = ref({ name: "", url: "", apiKey: "", enabled: true, toolPrefix: "", oauthClientId: "", oauthClientSecret: "", oauthToken: "", oauthAuthorizer: "" });

async function loadServers() {
  loading.value = true;
  try {
    const data = await fetchMCPServers();
    if (data && data.servers) servers.value = data.servers;
  } catch (e: any) {
    showToast("❌ 加载失败: " + (e.message || "未知错误"), "error");
  } finally {
    loading.value = false;
  }
}

function showForm(server: MCPServer | null) {
  if (server) {
    editingId.value = server.id;
    form.value = {
      name: server.name,
      url: server.url,
      apiKey: server.apiKey || "",
      enabled: server.enabled,
      toolPrefix: server.toolPrefix || "",
      oauthClientId: (server as any).oauthClientId || "",
      oauthClientSecret: (server as any).oauthClientSecret || "",
      oauthToken: (server as any).oauthToken || "",
      oauthAuthorizer: (server as any).oauthAuthorizer || "",
    };
  } else {
    editingId.value = null;
    form.value = { name: "", url: "", apiKey: "", enabled: true, toolPrefix: "", oauthClientId: "", oauthClientSecret: "", oauthToken: "", oauthAuthorizer: "" };
  }
  formVisible.value = true;
}

function editServer(server: MCPServer) {
  showForm(server);
}

async function saveServer() {
  if (!form.value.name.trim() || !form.value.url.trim()) {
    showToast("⚠️ 名称和 URL 为必填", "error");
    return;
  }
  saving.value = true;
  try {
    const data = await saveMCPServer({
      id: editingId.value || undefined,
      name: form.value.name.trim(),
      url: form.value.url.trim(),
      apiKey: form.value.apiKey || undefined,
      enabled: form.value.enabled,
      toolPrefix: form.value.toolPrefix.trim() || undefined,
      oauthClientId: form.value.oauthClientId.trim() || undefined,
      oauthClientSecret: form.value.oauthClientSecret.trim() || undefined,
      oauthToken: form.value.oauthToken.trim() || undefined,
      oauthAuthorizer: form.value.oauthAuthorizer.trim() || undefined,
    });
    if (data.ok) {
      showToast("✅ 保存成功");
      formVisible.value = false;
      await loadServers();
    }
  } catch (e: any) {
    showToast("❌ 保存失败: " + (e.message || "未知错误"), "error");
  } finally {
    saving.value = false;
  }
}

async function deleteServer(id: string) {
  if (!confirm("确定删除此 MCP Server？")) return;
  try {
    const data = await deleteMCPServer(id);
    if (data.ok) {
      showToast("✅ 已删除");
      await loadServers();
    }
  } catch (e: any) {
    showToast("❌ 删除失败: " + (e.message || "未知错误"), "error");
  }
}

async function refreshTools(id: string) {
  try {
    const data = await refreshMCPTools(id);
    if (data.ok) {
      showToast(`✅ 已获取 ${data.tools.length} 个工具`);
      await loadServers();
    } else {
      showToast(`❌ ${data.error || "获取失败"}`, "error");
    }
  } catch (e: any) {
    showToast("❌ " + (e.message || "未知错误"), "error");
  }
}

onMounted(() => {
  loadServers();
});
</script>

<style scoped>
.section-header { display: flex; justify-content: space-between; align-items: center; }
.section-header .header-actions { display: flex; gap: 8px; }
.section-header h2 { margin: 0; }
.mcp-server-item { border: 1px solid var(--border-light); border-radius: 8px; padding: 12px; margin-top: 10px; background: var(--bg-card); }
.server-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.server-name { font-weight: 600; font-size: 14px; flex: 1; }
.server-status { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
.server-status.enabled { background: var(--alert-success-bg); color: var(--alert-success-text); }
.server-status.disabled { background: var(--bg-skeleton-1); color: var(--text-muted); }
.server-actions { display: flex; gap: 4px; }
.server-url { font-size: 12px; color: var(--text-muted); font-family: monospace; margin-bottom: 6px; word-break: break-all; }
.server-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.tool-count { font-size: 12px; color: var(--text-secondary); }
.tool-list { margin-top: 6px; border-top: 1px solid var(--border-light); padding-top: 6px; max-height: 200px; overflow-y: auto; }
.tool-item { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 4px; font-size: 12px; }
.tool-item:hover { background: var(--bg-skeleton-1); }
.tool-name { font-weight: 600; color: var(--link); font-family: monospace; }
.tool-desc { color: var(--text-muted); font-size: 11px; }
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--bg-card); border-radius: 12px; width: 480px; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-light); }
.modal-header h3 { margin: 0; font-size: 16px; }
.modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: var(--text-secondary); }
.modal-body { padding: 16px 20px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--border-light); }
.btn.tiny { padding: 4px 10px; font-size: 12px; }
.btn.danger { color: var(--error); border-color: var(--error); }
.empty-state { text-align: center; padding: 40px; color: var(--text-dim); }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.field-hint { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
.oauth-section { margin-top: 8px; padding: 8px; border: 1px dashed var(--border-light); border-radius: 6px; }
.toast { position: fixed; top: 20px; right: 20px; z-index: 2000; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; box-shadow: 0 4px 16px rgba(0,0,0,0.2); animation: fadeIn 0.3s; }
.toast.success { background: var(--alert-success-bg); color: var(--alert-success-text); border: 1px solid var(--alert-success-text); }
.toast.error { background: var(--alert-error-bg, #fef2f2); color: var(--alert-error-text, #dc2626); border: 1px solid var(--alert-error-text, #dc2626); }
@keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
</style>