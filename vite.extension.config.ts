import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  publicDir: resolve(process.cwd(), "src/extension/public"),
  build: {
    outDir: "dist/extension",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "service-worker": resolve(
          process.cwd(),
          "src/extension/service-worker.ts",
        ),
        "content-script": resolve(
          process.cwd(),
          "src/extension/content-script.ts",
        ),
        popup: resolve(process.cwd(), "src/extension/popup.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
