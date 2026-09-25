import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The composer bundles the server's parser (../src/parser/explicit.ts).
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4400",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
