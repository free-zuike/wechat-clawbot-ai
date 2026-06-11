<template>
  <div class="login-container">
    <div class="login-card">
      <h1>🦞 ClawBot AI</h1>
      <div class="sub">微信机器人管理面板</div>

      <!-- 错误提示 -->
      <div v-if="error" class="notice">{{ error }}</div>

      <!-- 登录表单 -->
      <template v-if="!qrCode">
        <input
          v-model="password"
          class="input"
          type="password"
          placeholder="管理员密码"
          @keyup.enter="startLogin"
        />
        <button class="btn" :disabled="loading" @click="startLogin">
          {{ loading ? "加载中..." : "获取二维码" }}
        </button>
      </template>

      <!-- 二维码 -->
      <template v-else-if="!loggedIn">
        <div class="qr">
          <img :src="qrImage" alt="QR Code" />
        </div>
        <div v-if="qrStatus" class="badge wait">{{ qrStatus }}</div>
        <button
          class="btn secondary"
          style="width: 100%; margin-top: 20px"
          @click="reset"
        >
          重新获取
        </button>
      </template>

      <!-- 登录成功 -->
      <template v-else>
        <div class="badge ok">✅ 登录成功！正在跳转...</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted, onMounted } from "vue";
import { useRouter } from "vue-router";
import { getQRCode, getQRCodeStatus, checkLogin } from "../api";

const router = useRouter();

const password = ref("");
const qrCode = ref("");
const qrImage = ref("");
const qrStatus = ref("");
const error = ref("");
const loading = ref(false);
const loggedIn = ref(false);

let pollTimer: number | null = null;

onMounted(async () => {
  try {
    const data = await checkLogin();
    if (data.loggedIn) {
      router.push("/");
    }
  } catch {
    // 忽略错误，继续显示登录页面
  }
});

async function startLogin() {
  error.value = "";
  if (!password.value) {
    error.value = "请输入管理员密码";
    return;
  }

  loading.value = true;
  try {
    const data = await getQRCode(password.value);
    if (data.error) {
      error.value = data.error;
      loading.value = false;
      return;
    }
    if (!data.qrcode || !data.qrcode_img_content) {
      error.value = "获取二维码失败: 返回数据无效";
      loading.value = false;
      return;
    }
    qrCode.value = data.qrcode;
    qrImage.value = data.qrcode_img_content.trim().replace(/^`+|`+$/g, "").trim();
    qrStatus.value = "等待扫码...";
    pollStatus();
  } catch (e: any) {
    error.value = "获取二维码失败: " + e.message;
  } finally {
    loading.value = false;
  }
}

async function pollStatus() {
  try {
    const data = await getQRCodeStatus(password.value);
    if (data.ok || data.status === "confirmed") {
      qrStatus.value = "登录成功！";
      loggedIn.value = true;
      setTimeout(() => router.push("/"), 1500);
      return;
    }
    if (data.status === "scaned") {
      qrStatus.value = "已扫码，请在手机上确认";
    } else if (data.status === "expired") {
      qrStatus.value = "二维码已过期，请刷新重试";
      return;
    } else {
      qrStatus.value = "等待扫码...";
    }
    pollTimer = window.setTimeout(pollStatus, 2000);
  } catch {
    pollTimer = window.setTimeout(pollStatus, 3000);
  }
}

function reset() {
  if (pollTimer) clearTimeout(pollTimer);
  qrCode.value = "";
  qrImage.value = "";
  qrStatus.value = "";
  error.value = "";
  loggedIn.value = false;
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>
