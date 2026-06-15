<template>
  <div>
    <div class="card">
      <h2>📈 健康仪表盘</h2>
      <div class="desc">系统运行趋势、轮询/AI调用统计</div>

      <div v-if="chartData.length === 0" class="empty-state">
        等待数据采集中... 每 30 秒记录一次
      </div>

      <template v-else>
        <!-- 轮询趋势图 -->
        <div class="chart-section">
          <h3>📊 轮询 / 处理趋势</h3>
          <div class="chart-container">
            <div class="chart-bars">
              <div v-for="(item, i) in chartData" :key="i" class="chart-col">
                <div class="chart-bar-group">
                  <div class="chart-bar polls" :style="{ height: item.pollsH + '%' }" :title="`轮询: ${item.polls}`"></div>
                  <div class="chart-bar handled" :style="{ height: item.handledH + '%' }" :title="`处理: ${item.handled}`"></div>
                </div>
                <div class="chart-label">{{ item.time }}</div>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot polls"></span>轮询 ({{ latestPolls }})</span>
              <span class="legend-item"><span class="legend-dot handled"></span>处理 ({{ latestHandled }})</span>
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
                  <div class="chart-bar ai-calls" :style="{ height: item.aiCallsH + '%' }" :title="`AI调用: ${item.aiCalls}`"></div>
                  <div class="chart-bar ai-fails" :style="{ height: item.aiFailsH + '%' }" :title="`AI失败: ${item.aiFails}`"></div>
                </div>
                <div class="chart-label">{{ item.time }}</div>
              </div>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot ai-calls"></span>AI 调用 ({{ latestAiCalls }})</span>
              <span class="legend-item"><span class="legend-dot ai-fails"></span>AI 失败 ({{ latestAiFails }})</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { fetchStatus } from "../../api";

interface DataPoint {
  ts: string;
  polls: number;
  handled: number;
  aiCalls: number;
  aiFails: number;
}

const history = ref<DataPoint[]>([]);
let refreshTimer: number | null = null;

const latestPolls = computed(() => history.value.length > 0 ? history.value[history.value.length - 1].polls : 0);
const latestHandled = computed(() => history.value.length > 0 ? history.value[history.value.length - 1].handled : 0);
const latestAiCalls = computed(() => history.value.length > 0 ? history.value[history.value.length - 1].aiCalls : 0);
const latestAiFails = computed(() => history.value.length > 0 ? history.value[history.value.length - 1].aiFails : 0);

const chartData = computed(() => {
  const data = history.value;
  if (data.length < 2) return [];

  const first = data[0];
  const points: Array<{
    time: string;
    polls: number; handled: number; aiCalls: number; aiFails: number;
    pollsH: number; handledH: number; aiCallsH: number; aiFailsH: number;
  }> = [];

  for (const d of data) {
    points.push({
      time: new Date(d.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      polls: d.polls,
      handled: d.handled,
      aiCalls: d.aiCalls,
      aiFails: d.aiFails,
      pollsH: 0, handledH: 0, aiCallsH: 0, aiFailsH: 0,
    });
  }

  const maxPolls = Math.max(...points.map(d => d.polls - first.polls), 1);
  const maxHandled = Math.max(...points.map(d => d.handled - first.handled), 1);
  const maxAiCalls = Math.max(...points.map(d => d.aiCalls - first.aiCalls), 1);
  const maxAiFails = Math.max(...points.map(d => d.aiFails - first.aiFails), 1);

  for (const d of points) {
    const pDiff = d.polls - first.polls;
    const hDiff = d.handled - first.handled;
    const aDiff = d.aiCalls - first.aiCalls;
    const fDiff = d.aiFails - first.aiFails;
    d.pollsH = Math.max((pDiff / maxPolls) * 100, d.polls > 0 ? 4 : 0);
    d.handledH = Math.max((hDiff / maxHandled) * 100, hDiff > 0 ? 4 : 0);
    d.aiCallsH = Math.max((aDiff / maxAiCalls) * 100, aDiff > 0 ? 4 : 0);
    d.aiFailsH = Math.max((fDiff / maxAiFails) * 100, fDiff > 0 ? 4 : 0);
  }

  return points.slice(-30);
});

async function pollStats() {
  try {
    const data = await fetchStatus(false);
    if (data && data.stats) {
      history.value.push({
        ts: new Date().toISOString(),
        polls: data.stats.polls || 0,
        handled: data.stats.handled || 0,
        aiCalls: data.stats.aiCalls || 0,
        aiFails: data.stats.aiFails || 0,
      });
      if (history.value.length > 60) history.value = history.value.slice(-60);
    }
  } catch {}
}

onMounted(() => {
  pollStats();
  refreshTimer = window.setInterval(pollStats, 30000);
});

onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<style scoped>
.chart-section { margin-top: 24px; }
.chart-section h3 { font-size: 14px; color: var(--text-primary); margin-bottom: 12px; }
.chart-container { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; padding: 16px; }
.chart-bars { display: flex; align-items: flex-end; gap: 4px; height: 150px; padding-bottom: 24px; }
.chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
.chart-bar-group { display: flex; gap: 2px; align-items: flex-end; width: 100%; justify-content: center; }
.chart-bar { width: 40%; max-width: 16px; min-height: 2px; border-radius: 2px 2px 0 0; transition: height 0.3s ease; }
.chart-bar.polls { background: var(--link); }
.chart-bar.handled { background: var(--success); }
.chart-bar.ai-calls { background: #8b5cf6; }
.chart-bar.ai-fails { background: var(--error); }
.chart-label { font-size: 10px; color: var(--text-dim); margin-top: 6px; text-align: center; white-space: nowrap; }
.chart-legend { display: flex; gap: 16px; margin-top: 12px; justify-content: center; }
.legend-item { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.legend-dot { width: 10px; height: 10px; border-radius: 2px; }
.legend-dot.polls { background: var(--link); }
.legend-dot.handled { background: var(--success); }
.legend-dot.ai-calls { background: #8b5cf6; }
.legend-dot.ai-fails { background: var(--error); }
.empty-state { text-align: center; padding: 40px; color: var(--text-dim); font-size: 14px; }
</style>
