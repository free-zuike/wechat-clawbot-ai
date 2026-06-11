import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import LoginPage from "./views/LoginPage.vue";
import AdminPage from "./views/AdminPage.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: LoginPage },
    { path: "/", component: AdminPage },
  ],
});

const app = createApp(App);
app.use(router);
app.mount("#app");
