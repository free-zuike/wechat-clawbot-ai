import { createRouter, createWebHistory } from "vue-router";
import LoginPage from "./views/LoginPage.vue";
import AdminPage from "./views/AdminPage.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginPage },
    { path: "/", component: AdminPage },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

export default router;
