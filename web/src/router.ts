import { createRouter, createWebHistory } from "vue-router";
import LoginPage from "./views/LoginPage.vue";
import AdminPage from "./views/AdminPage.vue";
import { checkLogin } from "./api";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginPage },
    { path: "/", component: AdminPage },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to, _from, next) => {
  if (to.path === "/login") {
    next();
    return;
  }
  // 1. 先检查 localStorage（扫码确认后写入，秒级响应）
  if (localStorage.getItem("clawbot_auth") === "ok") {
    next();
    return;
  }
  // 2. 再检查后端
  try {
    const data = await checkLogin();
    if (data.loggedIn) {
      localStorage.setItem("clawbot_auth", "ok");
      next();
    } else {
      next("/login");
    }
  } catch {
    next("/login");
  }
});

export default router;
