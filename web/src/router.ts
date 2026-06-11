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
  try {
    const data = await checkLogin();
    if (data.loggedIn) {
      next();
    } else {
      next("/login");
    }
  } catch {
    next("/login");
  }
});

export default router;
