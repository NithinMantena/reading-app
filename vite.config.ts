import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "production" ? process.env.VITE_BASE_PATH ?? "/reading-app/" : "/",
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./supabase/functions/_shared", import.meta.url)),
    },
  },
  server: { port: 5173 },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
}));
