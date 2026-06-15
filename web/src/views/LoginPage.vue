<template>
  <div class="login-container">
    <div class="login-card">
      <h1>🦞 ClawBot AI</h1>
      <div class="sub">微信机器人管理面板</div>

      <div v-if="error" class="notice">{{ error }}</div>

      <input
        v-model="password"
        class="input"
        type="password"
        placeholder="管理员密码"
        @keyup.enter="doLogin"
      />
      <button class="btn" :disabled="loading" @click="doLogin" style="width:100%; margin-top:12px">
        {{ loading ? "登录中..." : "🔑 登录" }}
      </button>

      <div style="margin-top:20px; font-size:12px; color:var(--text-secondary); text-align:center">
        登录后可在管理面板中绑定微信
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { checkLogin } from "../api";

const router = useRouter();
const password = ref("");
const error = ref("");
const loading = ref(false);

onMounted(() => {
  if (localStorage.getItem("theme") === "dark") {
    document.documentElement.classList.add("dark");
  }
});

async function doLogin() {
  error.value = "";
  if (!password.value) {
    error.value = "请输入管理员密码";
    return;
  }

  loading.value = true;
  try {
    const data = await checkLogin(password.value);
    if (data.loggedIn) {
      localStorage.setItem("clawbot_auth", "ok");
      router.push("/");
    } else {
      error.value = data.error || "密码不正确";
    }
  } catch (e: any) {
    error.value = "登录失败: " + (e.message || "网络错误");
  } finally {
    loading.value = false;
  }
}
</script>
