<template>
  <div>
    <div class="card" style="margin-bottom: 16px">
      <h2>🔗 绑定微信</h2>
      <div class="desc">扫码绑定微信账号，绑定后可接收和回复消息</div>
      <div v-if="!bound">
        <template v-if="!qrCode">
          <button class="btn" @click="$emit('getQR')" :disabled="qrLoading">
            {{ qrLoading ? "加载中..." : "📱 获取二维码" }}
          </button>
        </template>
        <template v-else>
          <div class="qr" v-if="qrImage">
            <img :src="qrImage" alt="QR Code" />
          </div>
          <div v-if="qrStatus" class="badge wait">{{ qrStatus }}</div>
          <button class="btn secondary" style="width:100%; margin-top:12px" @click="$emit('resetQR')">重新获取</button>
        </template>
      </div>
      <div v-else style="padding:12px; background:var(--alert-success-bg); border-radius:8px; color:var(--success); display:flex; justify-content:space-between; align-items:center">
        <span>✅ 微信已绑定</span>
        <button class="btn secondary small" @click="$emit('unbind')">解绑</button>
      </div>
    </div>

    <div class="card">
      <h2>🎮 消息控制</h2>
      <div class="desc">手动触发消息拉取 + 实时消息推送</div>
      <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 16px">
        <button class="btn" :disabled="isPolling" @click="$emit('triggerPoll')">
          {{ isPolling ? "轮询中..." : "🔄 立即拉取消息" }}
        </button>
        <span :style="{ color: wsConnected ? 'var(--success)' : 'var(--error)', fontSize: '13px' }">
          {{ wsConnected ? '🟢 实时连接已建立' : '🔴 未连接' }}
        </span>
      </div>
      <div v-if="pollResult" class="result-box">{{ pollResult }}</div>

      <div v-if="wsMessages.length > 0" style="margin-top: 20px">
        <h3 style="font-size: 14px; margin-bottom: 8px">📡 实时消息 ({{ wsMessages.length }})</h3>
        <div style="max-height: 400px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: 8px">
          <div
            v-for="(msg, i) in wsMessages"
            :key="i"
            style="padding: 10px 14px; border-bottom: 1px solid var(--bg-alert-error); font-size: 13px"
          >
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px">
              <span style="font-weight: 600; color: var(--link)">📩 {{ msg.data?.fromUserId || '未知' }}</span>
              <span style="color: var(--text-dim); font-size: 12px">{{ msg.data?.timestamp || '' }}</span>
            </div>
            <div style="color: var(--text-primary)">{{ msg.data?.content || msg.data }}</div>
            <div v-if="msg.data?.replyContent" style="color: var(--success); margin-top: 4px; padding: 6px 8px; background: var(--alert-success-bg); border-radius: 4px">
              💬 {{ msg.data.replyContent }}
            </div>
          </div>
        </div>
        <button class="btn secondary small" style="margin-top: 8px" @click="$emit('clearMessages')">清空消息</button>
      </div>

      <div class="notice" style="margin-top: 20px">
        💡 <strong>提示：</strong>实时消息通过 WebSocket 推送，无需手动刷新。手动轮询适合测试场景。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  bound: boolean;
  qrCode: string;
  qrImage: string;
  qrStatus: string;
  qrLoading: boolean;
  wsConnected: boolean;
  wsMessages: Array<{ type: string; data: any }>;
  isPolling: boolean;
  pollResult: string;
}>();

defineEmits(["getQR", "resetQR", "unbind", "triggerPoll", "clearMessages"]);
</script>
