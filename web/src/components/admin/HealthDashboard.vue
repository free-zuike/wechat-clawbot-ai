<template>
  <div>
    <div class="card">
      <h2>📈 健康仪表盘</h2>
      <div class="desc">系统运行趋势、响应时间、消息量统计</div>

      <div v-if="loading" class="skeleton-grid">
        <div v-for="i in 3" :key="i" class="skeleton-item" style="grid-column: 1 / -1; height: 200px"></div>
      </div>

      <template v-else>
        <!-- 轮询趋势图 -->
        <div class="chart-section">
          <h3>📊 轮询 / 处理趋势</h3>
          <div class="chart-container">
            <div class="chart-bars">
              <div v-for="(item, i) in chartData" :key="i" class="chart-col">
                <div class="chart-bar-group">
                  <div
                    class="chart-bar polls"
                    :style="{ height: item.pollsH + '%' }"
                    :title="`轮询: ${item.polls}`"
                  ></div>
                  <div
                    class="chart-bar handled"
                    :style="{ height: item.handledH + '%' }"
                    :title="`处理: ${item.handled}`"
                  ></div>
                </div>
                <div class="chart-label">{{ item.time }}</div>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot polls"></span>轮询</span>
              <span class="legend-item"><span class="legend-dot handled"></span>处理</span>
            </div>
          </div>
        </div>

        <!-- AI 调用趋势图 -->
        <div class="chart-section">
          <h3>🤖 AI 调用趋势</h3>
          <div class="chart-container">
            <div class="chart-bars">
              <div v-for="(item, i) in chartData" :key="i" class="chart-col">
                <div class="chart-bar-group">
                  <div
                    class="chart-bar ai-calls"
                    :style="{ height: item.aiCallsH + '%' }"
                    :title="`AI 调用: ${item.aiCalls}`"
                  ></div>
                  <div
                    class="chart-bar ai-fails"
                    :style="{ height: item.aiFailsH + '%' }"
                    :title="`AI 失败: ${item.aiFails}`"
                  ></div>
                </div>
                <div class="chart-label">{{ item.time }}</div>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot ai-calls"></span>AI 调用</span>
              <span class="legend-item"><span class="legend-dot ai-fails"></span>AI 失败</span>
            </div>
          </div>
        </div>

        <div v-if="history.length === 0" class="empty-state">
          暂无历史数据，轮询运行后会自动记录趋势
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { fetchStatsHistory, type StatsSnapshot } from "../../api";

const loading = ref(false);
const history = ref<StatsSnapshot[]>([]);

const chartData = computed(() => {
  const data = history.value;
  if (data.length === 0) return [];

  // 计算deltas（每个数据点相对于前一个的deltas）
  const deltas: Array<{
    time: string;
    polls: number; handled: number; aiCalls: number; aiFails: number;
    pollsH: number; handledH: number; aiCallsH: number; aiFailsH: number;
  }> = [];

  for (let i = 1; i < data.length; i++) {
    const d = data[i];
    const prev = data[i - 1];
    deltas.push({
      time: new Date(d.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      polls: d.polls - prev.polls,
      handled: d.handled - prev.handled,
      aiCalls: d.aiCalls - prev.aiCalls,
      aiFails: d.aiFails - prev.aiFails,
      pollsH: 0, handledH: 0, aiCallsH: 0, aiFailsH: 0,
    });
  }

  // 计算高度百分比
  const maxPolls = Math.max(...deltas.map(d => d.polls), 1);
  const maxHandled = Math.max(...deltas.map(d => d.handled), 1);
  const maxAiCalls = Math.max(...deltas.map(d => d.aiCalls), 1);
  const maxAiFails = Math.max(...deltas.map(d => d.aiFails), 1);

  for (const d of deltas) {
    d.pollsH = Math.max((d.polls / maxPolls) * 100, d.polls > 0 ? 4 : 0);
    d.handledH = Math.max((d.handled / maxHandled) * 100, d.handled > 0 ? 4 : 0);
    d.aiCallsH = Math.max((d.aiCalls / maxAiCalls) * 100, d.aiCalls > 0 ? 4 : 0);
    d.aiFailsH = Math.max((d.aiFails / maxAiFails) * 100, d.aiFails > 0 ? 4 : 0);
  }

  // 最多显示 24 个数据点
  return deltas.slice(-24);
});

onMounted(async () => {
  loading.value = true;
  try {
    const d = await fetchStatsHistory();
    history.value = d.history || [];
  } catch {} finally { loading.value = false; }
  refreshTimer = window.setInterval(async () => {
    try {
      const d = await fetchStatsHistory();
      history.value = d.history || [];
    } catch {}
  }, 30000);
});

let refreshTimer: number | null = null;
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<style scoped>
.chart-section {
  margin-top: 24px;
}
.chart-section h3 {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 12px;
}
.chart-container {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  padding: 16px;
}
.chart-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 150px;
  padding-bottom: 24px;
  position: relative;
}
.chart-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
}
.chart-bar-group {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  width: 100%;
  justify-content: center;
}
.chart-bar {
  width: 40%;
  max-width: 16px;
  min-height: 2px;
  border-radius: 2px 2px 0 0;
  transition: height 0.3s ease;
}
.chart-bar.polls { background: var(--link); }
.chart-bar.handled { background: var(--success); }
.chart-bar.ai-calls { background: #8b5cf6; }
.chart-bar.ai-fails { background: var(--error); }
.chart-label {
  font-size: 10px;
  color: var(--text-dim);
  margin-top: 6px;
  text-align: center;
  white-space: nowrap;
}
.chart-legend {
  display: flex;
  gap: 16px;
  margin-top: 12px;
  justify-content: center;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.legend-dot.polls { background: var(--link); }
.legend-dot.handled { background: var(--success); }
.legend-dot.ai-calls { background: #8b5cf6; }
.legend-dot.ai-fails { background: var(--error); }
.empty-state { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }
.skeleton-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
.skeleton-item { height: 60px; background: linear-gradient(90deg, var(--bg-skeleton-1) 25%, var(--bg-skeleton-2) 50%, var(--bg-skeleton-1) 75%); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: 8px; }
@keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
</style>
