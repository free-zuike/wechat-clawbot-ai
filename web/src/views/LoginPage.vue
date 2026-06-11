<template>
  <div class="login-container">
    <div class="login-card">
      <h1>🦞 ClawBot AI</h1>
      <div class="sub">微信机器人管理面板</div>

      <div v-if="errorMsg" class="notice" style="text-align: center">
        {{ errorMsg }}
      </div>

      <div v-if="!qrCode">
        <input
          class="input"
          v-model="password"
          placeholder="管理员密码"
          type="password"
          @keyup.enter="startLogin"
          style="margin-top: 12px"
        />
        <button class="btn" style="width: 100%; margin-top: 16px" @click="startLogin">
          获取二维码
        </button>
      </div>

      <div v-else-if="!loggedIn">
        <div class="qr">
          <img :src="qrImage" alt="QR Code" />
        </div>
        <div v-if="qrStatus" class="badge wait">{{ qrStatus }}</div>
        <div style="margin-top: 16px">
          <button class="btn secondary" @click="reset">重新获取</button>
        </div>
      </div>

      <div v-else>
        <span class="badge ok">登录成功！</span>
        <button class="btn" style="width: 100%; margin-top: 16px" @click="goAdmin">
          进入管理面板
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const password = ref("");
const qrCode = ref("");
const qrImage = ref("");
const qrStatus = ref("");
const loggedIn = ref(false);
const errorMsg = ref("");

let pollTimer: number | null = null;

async function startLogin() {
  errorMsg.value = "";
  if (!password.value) {
    errorMsg.value = "请输入管理员密码";
    return;
  }
  try {
    const res = await fetch(`/api/qrcode?pwd=${encodeURIComponent(password.value)}`);
    const data = await res.json();
    if (data.error) {
      errorMsg.value = data.error;
      return;
    }
    qrCode.value = data.qrcode;
    qrImage.value = "data:image/png;base64," + data.qrcode_img_content;
    qrStatus.value = "等待扫码...";
    pollStatus();
  } catch (e: any) {
    errorMsg.value = "获取二维码失败: " + e.message;
  }
}

async function pollStatus() {
  try {
    const res = await fetch(
      `/api/qrcode-status?pwd=${encodeURIComponent(password.value)}`
    );
    const data = await res.json();
    if (data.ok || data.status === "confirmed") {
      qrStatus.value = "扫码确认成功";
      loggedIn.value = true;
      if (pollTimer) clearTimeout(pollTimer);
      return;
    }
    if (data.status === "scaned") {
      qrStatus.value = "已扫码，请在手机上确认";
    } else if (data.status === "expired") {
      qrStatus.value = "二维码已过期，请刷新重试";
      return;
    }
    pollTimer = window.setTimeout(pollStatus, 2000);
  } catch {
    pollTimer = window.setTimeout(pollStatus, 2000);
  }
}

function reset() {
  if (pollTimer) clearTimeout(pollTimer);
  qrCode.value = "";
  qrImage.value = "";
  qrStatus.value = "";
  loggedIn.value = false;
  errorMsg.value = "";
}

function goAdmin() {
  router.push("/");
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>
