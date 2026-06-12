<template>
  <div id="app">
    <router-view />
    <ToastNotification
      :visible="ui.state.toast.visible"
      :type="ui.state.toast.type"
      :title="ui.state.toast.title"
      :message="ui.state.toast.message"
      :duration="ui.state.toast.duration"
      @close="ui.hideToast"
    />
    <LoadingOverlay :loading="ui.state.loading.loading" :text="ui.state.loading.text" />
  </div>
</template>

<script setup lang="ts">
import ToastNotification from "./components/ToastNotification.vue";
import LoadingOverlay from "./components/LoadingOverlay.vue";
import { useUI } from "./composables/useUI";

const ui = useUI();
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
  background: #f5f7fa;
  min-height: 100vh;
}

#app {
  min-height: 100vh;
}
</style>
