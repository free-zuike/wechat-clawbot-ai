<template>
  <div class="app-layout">
    <aside class="sidebar">
      <h1>🦞 ClawBot AI</h1>
      <div class="sub">v1.5 Cloudflare Suite</div>
      <nav>
        <a
          v-for="item in navItems"
          :key="item.key"
          :href="'#'"
          @click.prevent="activeSection = item.key"
          :class="{ active: activeSection === item.key }"
        >
          {{ item.icon }} {{ item.label }}
        </a>
      </nav>
      <div class="status">
        <div class="badge" style="color: #fff">系统状态</div>
        <div style="margin-top: 8px">
          <span class="badge ok">✓ 已登录</span>
        </div>
        <div style="margin-top: 12px">
          <input
            class="input"
            v-model="password"
            placeholder="管理员密码"
            type="password"
            style="font-size: 13px"
          />
          <button class="btn danger" style="width: 100%; margin-top: 8px" @click="doLogout">
            退出登录
          </button>
        </div>
      </div>
    </aside>

    <main class="main-content">
      <div class="wrap">
        <!-- 状态监控 -->
        <section v-if="activeSection === 'status'">
          <div class="card">
            <h2>📊 实时状态</h2>
            <div class="kv" id="live-stats">
              <b>登录状态</b><span>{{ status.loggedIn ? "✅" : "❌" }}</span>
              <b>轮询次数</b><span>{{ status.polls }}</span>
              <b>累计处理</b><span>{{ status.handled }}</span>
              <b>AI 调用</b><span>{{ status.aiCalls }}</span>
              <b>AI 失败</b><span>{{ status.aiFails }}</span>
              <b>连续失败</b
              ><span
                ><span :class="status.consecutiveFails > 0 ? 'badge bad' : 'badge ok'">
                  {{ status.consecutiveFails }}
                </span></span
              >
              <b>上次轮询</b><span>{{ status.lastPollAt }}</span>
              <b>上次耗时</b><span>{{ status.lastLatencyMs }}</span>
            </div>
            <h3 style="font-size: 14px; color: #666; margin: 16px 0 8px">📈 过去 24 小时统计</h3>
            <div class="sub" style="white-space: pre-wrap">
              {{ historyText }}
            </div>
            <h3 style="font-size: 14px; color: #666; margin: 16px 0 8px">🚨 最近错误</h3>
            <div class="sub" style="white-space: pre-wrap">{{ errorsText }}</div>
            <div class="row">
              <button class="btn" @click="refreshData">🔄 刷新</button>
            </div>
          </div>
        </section>

        <!-- 控制中心 -->
        <section v-if="activeSection === 'control'">
          <div class="card">
            <h2>🎮 控制中心</h2>
            <div class="sub">手动触发消息拉取和查看历史记录</div>
            <div class="row">
              <button class="btn" @click="doTriggerPoll">🔄 手动触发轮询</button>
              <button class="btn secondary" @click="doLoadR2">📋 查看 R2 历史</button>
            </div>
            <div class="sub" style="margin-top: 12px">{{ pollResult }}</div>
            <div style="margin-top: 14px">
              <label style="font-size: 13px; color: #555">查询用户</label>
              <input
                v-model="r2User"
                class="input"
                placeholder="用户 ID（留空查询全部）"
                style="margin-top: 6px"
              />
            </div>
            <div class="sub" style="white-space: pre-wrap; margin-top: 12px; max-height: 300px; overflow-y: auto">
              {{ r2Result }}
            </div>
          </div>
        </section>

        <!-- 系统设置 -->
        <section v-if="activeSection === 'config'">
          <div class="card">
            <h2>⚙️ 系统设置</h2>
            <div class="sub">配置 AI 模型、人设提示词等参数（配置保存在 KV 中）</div>
            <div style="margin-bottom: 14px">
              <label style="font-size: 13px; color: #555">AI 模型</label>
              <input
                v-model="config.aiModel"
                class="input"
                placeholder="@cf/meta/llama-3-8b-instruct"
                style="margin-top: 6px"
              />
            </div>
            <div style="margin-bottom: 14px">
              <label style="font-size: 13px; color: #555">AI 人设提示词</label>
              <textarea
                v-model="config.aiSystemPrompt"
                class="input"
                rows="4"
                placeholder="你是爪爪，一个友好的 AI 助手..."
                style="border-radius: 12px; margin-top: 6px; resize: vertical"
              ></textarea>
            </div>
            <div class="row">
              <button class="btn" @click="doLoadConfig">加载配置</button>
              <button class="btn" @click="doSaveConfig">保存配置</button>
            </div>
            <div class="sub" style="margin-top: 12px">{{ configResult }}</div>
          </div>
        </section>

        <!-- AI 测试 -->
        <section v-if="activeSection === 'chat'">
          <div class="card">
            <h2>🤖 AI 测试聊天</h2>
            <div class="sub">直接测试 AI 回复效果</div>
            <div class="chat-box">
              <div v-for="(msg, idx) in chatMessages" :key="idx" class="msg" :class="msg.role">
                <div class="bubble">{{ msg.text }}</div>
              </div>
            </div>
            <div class="row" style="margin-top: 12px">
              <input
                v-model="chatInput"
                class="input"
                placeholder="输入消息..."
                @keyup.enter="sendChat"
              />
              <button class="btn" @click="sendChat">发送</button>
            </div>
          </div>
        </section>

        <!-- 部署命令 -->
        <section v-if="activeSection === 'deploy'">
          <div class="card">
            <h2>📦 部署命令</h2>
            <div class="sub">常用的 Cloudflare 部署命令</div>
            <pre
              class="code"
              style="
                background: #1e2230;
                color: #f5f5f5;
                padding: 14px;
                border-radius: 12px;
                overflow-x: auto;
                font-size: 12px;
                line-height: 1.6;
              "
            >
# 安装依赖
npm install

# 创建 KV Namespace（必需）
wrangler kv namespace create CLAWBOT_KV

# 创建 R2 Bucket（可选）
wrangler r2 bucket create clawbot-history

# 设置环境变量
wrangler secret put ADMIN_PASSWORD

# 部署
wrangler deploy</pre
            >
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();

const navItems = [
  { key: "status", label: "状态监控", icon: "📊" },
  { key: "control", label: "控制中心", icon: "🎮" },
  { key: "config", label: "系统设置", icon: "⚙️" },
  { key: "chat", label: "AI 测试", icon: "🤖" },
  { key: "deploy", label: "部署命令", icon: "📦" },
];

const activeSection = ref("status");
const password = ref("");

const status = ref({
  loggedIn: false,
  polls: 0,
  handled: 0,
  aiCalls: 0,
  aiFails: 0,
  consecutiveFails: 0,
  lastPollAt: "从未",
  lastLatencyMs: "—",
});

const historyText = ref("加载中...");
const errorsText = ref("暂无");
const pollResult = ref("");
const r2User = ref("");
const r2Result = ref("");
const configResult = ref("");

const config = ref({
  aiModel: "",
  aiSystemPrompt: "",
});

const chatMessages = ref([{ role: "b", text: "你好！我是爪爪 AI。" }]);
const chatInput = ref("");

let refreshTimer: number | null = null;

async function refreshData() {
  try {
    const res = await fetch(`/api/status?pwd=${encodeURIComponent(password.value)}`);
    const data = await res.json();
    const s = data.stats || {};
    status.value = {
      loggedIn: !!data.loggedIn,
      polls: s.polls ?? 0,
      handled: s.handled ?? 0,
      aiCalls: s.aiCalls ?? 0,
      aiFails: s.aiFails ?? 0,
      consecutiveFails: s.consecutiveFails ?? 0,
      lastPollAt: s.lastPollAt ? new Date(s.lastPollAt).toLocaleString() : "从未",
      lastLatencyMs: s.lastLatencyMs == null ? "—" : s.lastLatencyMs + " ms",
    };
    const errs = (s.recentErrors || []).slice(0, 10);
    errorsText.value = !errs.length
      ? "✅ 最近无错误"
      : errs.map((e: any) => new Date(e.t).toLocaleString() + " —— " + (e.msg || "(无消息)")).join("\n");

    const h24 = await fetch(`/api/history?hours=24&pwd=${encodeURIComponent(password.value)}`).catch(() => null);
    if (h24) {
      const hd = await h24.json();
      const rows = (hd.data || []).slice(0, 24);
      if (!rows.length) historyText.value = "(暂无数据, cron 运行后会累积)";
      else
        historyText.value = rows
          .map((r: any) => {
            const t = new Date(r.hour_unix * 1000).toLocaleString();
            return `${t}  轮询 ${r.polls}  回复 ${r.handled}  AI ${r.ai_calls}`;
          })
          .join("\n");
    } else historyText.value = "(暂无数据)";
  } catch {
    // ignore
  }
}

async function doTriggerPoll() {
  pollResult.value = "调用中...";
  try {
    const res = await fetch(`/api/trigger-poll?pwd=${encodeURIComponent(password.value)}`, { method: "POST" });
    const data = await res.json();
    pollResult.value = "结果: " + JSON.stringify(data, null, 2);
    refreshData();
  } catch (e: any) {
    pollResult.value = "错误: " + e.message;
  }
}

async function doLoadR2() {
  r2Result.value = "查询中...";
  try {
    const user = encodeURIComponent(r2User.value);
    const res = await fetch(
      `/api/r2-history?pwd=${encodeURIComponent(password.value)}&user=${user}&limit=30`
    );
    const data = await res.json();
    if (data.error) {
      r2Result.value = "❌ " + data.error;
      return;
    }
    const items = data.items || [];
    if (!items.length) r2Result.value = "(无数据)";
    else
      r2Result.value = items
        .slice(0, 30)
        .map((it: any) => {
          let content;
          try {
            content = JSON.parse(it.content);
          } catch {
            content = it.content;
          }
          const text = typeof content === "object" ? content.content || "" : content;
          return new Date(it.ts).toLocaleString() + "  " + String(text).slice(0, 120);
        })
        .join("\n");
  } catch (e: any) {
    r2Result.value = "错误: " + e.message;
  }
}

async function doLoadConfig() {
  configResult.value = "加载中...";
  try {
    const res = await fetch(`/api/config?pwd=${encodeURIComponent(password.value)}`);
    const data = await res.json();
    config.value.aiModel = data.aiModel || "";
    config.value.aiSystemPrompt = data.aiSystemPrompt || "";
    configResult.value = "✅ 配置加载成功";
  } catch (e: any) {
    configResult.value = "❌ 加载失败: " + e.message;
  }
}

async function doSaveConfig() {
  configResult.value = "保存中...";
  try {
    const res = await fetch(`/api/config?pwd=${encodeURIComponent(password.value)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config.value),
    });
    const data = await res.json();
    if (data.ok) {
      configResult.value = "✅ 配置保存成功";
    } else {
      configResult.value = "❌ " + (data.error || "保存失败");
    }
  } catch (e: any) {
    configResult.value = "❌ 保存失败: " + e.message;
  }
}

async function sendChat() {
  const q = chatInput.value.trim();
  if (!q) return;
  chatMessages.value.push({ role: "u", text: q });
  chatInput.value = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: q }),
    });
    const data = await res.json();
    chatMessages.value.push({
      role: "b",
      text: (data.reply || "") + (data.source === "shortcut" ? " [快捷回复]" : ""),
    });
  } catch (e: any) {
    chatMessages.value.push({ role: "b", text: "错误: " + e.message });
  }
}

async function doLogout() {
  if (!confirm("确认退出登录？")) return;
  try {
    await fetch(`/api/logout?pwd=${encodeURIComponent(password.value)}`, { method: "POST" });
  } catch {
    // ignore
  }
  router.push("/login");
}

onMounted(() => {
  refreshData();
  refreshTimer = window.setInterval(refreshData, 30000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>
