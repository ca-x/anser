import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/assets/anser/" : "/",
  build: { target: "es2022" },
  server: {
    proxy: {
      "/v1": process.env.ANSER_DEV_API || "http://127.0.0.1:8080",
    },
  },
}));
