import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "web/index.html"),
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "web/src"),
    },
  },
});
