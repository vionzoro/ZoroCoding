import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    include: [
      "tests/main/**/*.test.ts",
      "tests/renderer/**/*.test.ts",
      "tests/renderer/**/*.test.tsx",
      "tests/shared/**/*.test.ts",
    ],
  },
});
