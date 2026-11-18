/**
 * Builds the server into one file, `dist/index.js`, that runs with plain `node`. Packages from
 * node_modules (Fastify, the WebSocket plugin) stay external and are installed beside it; the
 * workspace package `@tetrizz/protocol` is TypeScript source and is bundled in.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(root.version) },
  ssr: { noExternal: ["@tetrizz/protocol"] },
  build: {
    ssr: "src/index.ts",
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
});
