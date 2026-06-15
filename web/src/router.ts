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
  // 1. localStorage 已登录
  if (localStorage.getItem("clawbot_auth") === "ok") {
    next();
    return;
  }
  // 2. 后端 session 验证
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
