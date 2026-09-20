import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = process.env.DASHBOARD_PORT ?? "8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/auth": `http://localhost:${serverPort}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
