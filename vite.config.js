import { cp, mkdir } from "node:fs/promises";
import { defineConfig } from "vite";

function copyModelData() {
  return {
    name: "copy-model-data",
    async closeBundle() {
      await mkdir("dist/data", { recursive: true });
      await cp("web/data", "dist/data", { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  root: "web",
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [copyModelData()],
  test: { environment: "jsdom", include: ["tests-js/**/*.test.js"] },
});
