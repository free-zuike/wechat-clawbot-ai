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
      <template v-else-if="!loggedIn && qrImage">
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
import QRCode from "qrcode";

const router = useRouter();

const password = ref("");
const qrCode = ref("");
const qrImage = ref("");
const qrStatus = ref("");
const error = ref("");
const loading = ref(false);
const loggedIn = ref(false);

let pollTimer: number | null = null;

onMounted(() => {
  // 应用主题
  if (localStorage.getItem("theme") === "dark") {
    document.documentElement.classList.add("dark");
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
    if (!data.qrcode || !data.qrcode_url) {
      error.value = "获取二维码失败: 返回数据无效";
      loading.value = false;
      return;
    }
    qrCode.value = data.qrcode;
    // 使用 qrcode 库从完整URL生成二维码图片
    try {
      qrImage.value = await QRCode.toDataURL(data.qrcode_url, {
        width: 200,
        margin: 2,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });
    } catch (e) {
      console.error("QR code generation error:", e);
      error.value = "生成二维码失败";
      loading.value = false;
      return;
    }
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
    const data = await getQRCodeStatus(password.value, qrCode.value);
    console.log("[pollStatus] data:", JSON.stringify(data));
    if (data.ok || data.status === "confirmed") {
      qrStatus.value = "登录成功！正在跳转...";
      loggedIn.value = true;
      localStorage.setItem("clawbot_auth", "ok");
      router.push("/");
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
  } catch (e: any) {
    console.error("[pollStatus] error:", e);
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
  // 重新发起登录
  startLogin();
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>
