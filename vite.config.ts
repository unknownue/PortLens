import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    // 固定端口 + 严格模式：tauri.conf.json 的 devUrl 指向它。
    // 15273 避开了 Windows 动态端口段（1024-15000）与 dsh web 的 15080。
    port: 15273,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? { protocol: "ws", host, port: 15274 }
      : { protocol: "ws", host: "127.0.0.1", port: 15274 },
    watch: {
      ignored: ["**/src-tauri/**", "**/.*.tmpdir/**", "**/*.tmp", "**/*.swp", "**/*.swx", "**/~$*"],
    },
  },
  build: {
    // WebView2 随 Edge 常青更新，以 Chrome 107 为转译下限即可。
    target: "chrome107",
    minify: "esbuild",
    sourcemap: false,
  },
}));
