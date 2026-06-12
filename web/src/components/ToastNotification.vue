<template>
  <Transition name="fade">
    <div v-if="visible" class="toast-container" :class="type">
      <div class="toast-icon">
        <span v-if="type === 'success'">✅</span>
        <span v-else-if="type === 'error'">❌</span>
        <span v-else-if="type === 'warning'">⚠️</span>
        <span v-else>ℹ️</span>
      </div>
      <div class="toast-content">
        <div class="toast-title">{{ title }}</div>
        <div class="toast-message">{{ message }}</div>
      </div>
      <button class="toast-close" @click="close">✕</button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  visible: boolean;
  type?: 'success' | 'error' | 'warning' | 'info';
  title?: string;
  message: string;
  duration?: number;
}>();

const emit = defineEmits<{
  close: [];
}>();

const timer = ref<number | null>(null);

watch(() => props.visible, (val) => {
  if (val && props.duration && props.duration > 0) {
    if (timer.value) clearTimeout(timer.value);
    timer.value = window.setTimeout(() => {
      emit('close');
    }, props.duration);
  }
});

function close() {
  if (timer.value) clearTimeout(timer.value);
  emit('close');
}
</script>

<style scoped>
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  min-width: 300px;
  max-width: 400px;
  z-index: 9999;
  border-left: 4px solid;
}

.toast-container.success {
  border-color: #52c41a;
}

.toast-container.error {
  border-color: #ff4d4f;
}

.toast-container.warning {
  border-color: #faad14;
}

.toast-container.info {
  border-color: #1890ff;
}

.toast-icon {
  font-size: 20px;
  flex-shrink: 0;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-weight: 600;
  font-size: 14px;
  color: #333;
  margin-bottom: 4px;
}

.toast-message {
  font-size: 13px;
  color: #666;
  word-break: break-word;
}

.toast-close {
  background: none;
  border: none;
  font-size: 16px;
  color: #999;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
}

.toast-close:hover {
  color: #666;
}

.fade-enter-active,
.fade-leave-active {
  transition: all 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>