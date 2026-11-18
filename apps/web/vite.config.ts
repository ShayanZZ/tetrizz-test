/**
 * Vite configuration for the browser app.
 *
 * Two build flavours share one source tree:
 * - default: a multi-file site in `dist/` (page, service worker, manifest, icons);
 * - `--mode single`: one self-contained `dist-single/TetriZZ.html` for quick testing on a
 *   phone, with no service worker, manifest or icons.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import {
  connectSources,
  neverCacheHosts,
  networkConfigFromEnv,
  type NetworkConfig,
} from "./src/core/network-config";

const SINGLE_FILE_NAME = "TetriZZ.html";

/** Renames the emitted page so the single-file build keeps the name players already know. */
function renameSingleFileOutput(outDir: string): Plugin {
  let out = resolve(outDir);
  return {
    name: "tetrizz:rename-single-file",
    apply: "build",
    enforce: "post",
    // `--outDir` on the command line changes where Vite writes; follow it.
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      renameSync(resolve(out, "index.html"), resolve(out, SINGLE_FILE_NAME));
    },
  };
}

/**
 * Removes the `crossorigin` attribute Vite adds to the emitted stylesheet link. The CSS is
 * served from the same origin, and with the attribute Chromium refuses to load it when the
 * page is opened from disk (`file://`), which would leave the page unstyled.
 */
function stripStylesheetCrossorigin(): Plugin {
  return {
    name: "tetrizz:strip-stylesheet-crossorigin",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/(<link rel="stylesheet") crossorigin /g, "$1 "),
    },
  };
}

/** A short fingerprint of the shipped files, so each build gets its own cache. */
const buildId = (files: string[]): string =>
  createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 8);

/**
 * Adds the hashed script and stylesheet files to the service worker's pre-cached shell. Without
 * this the first offline visit has a page but no code, because the assets are only cached when a
 * later page load fetches them through the worker.
 */
function precacheBuiltAssets(outDir: string, network: NetworkConfig): Plugin {
  let out = resolve(outDir);
  return {
    name: "tetrizz:precache-built-assets",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const swPath = resolve(out, "sw.js");
      const assets = readdirSync(resolve(out, "assets")).sort();
      const shell = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
      const list = [...shell, ...assets.map((name) => `./assets/${name}`)];
      const source = readFileSync(swPath, "utf8");
      const next = source
        .replace(/const APP_SHELL = \[[^\]]*\];/, `const APP_SHELL = ${JSON.stringify(list)};`)
        .replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}-${buildId(list)}";`)
        .replace(
          /const NEVER_CACHE = \[[^\]]*\];/,
          `const NEVER_CACHE = ${JSON.stringify(neverCacheHosts(network))};`,
        );
      if (
        !next.includes(JSON.stringify(list)) ||
        !next.includes(buildId(list)) ||
        !next.includes(JSON.stringify(neverCacheHosts(network)))
      ) {
        throw new Error("sw.js: APP_SHELL, VERSION or NEVER_CACHE declaration not found");
      }
      writeFileSync(swPath, next);
    },
  };
}

/**
 * Writes the hosts the page may connect to into the Content Security Policy. The policy lives in
 * `index.html` as the token `__CONNECT_SRC__`, so no project address has to be kept in the source.
 */
function networkContentSecurityPolicy(network: NetworkConfig): Plugin {
  return {
    name: "tetrizz:network-csp",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace("__CONNECT_SRC__", connectSources(network).join(" ")),
    },
  };
}

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const single = mode === "single";
  const outDir = single ? "dist-single" : "dist";
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const network = networkConfigFromEnv(loadEnv(mode, repoRoot, "TETRIZZ_"));
  return {
    envDir: repoRoot,
    // Relative URLs let one build run from any path (GitHub Pages sub-paths, file://).
    base: "./",
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __NETWORK_CONFIG__: JSON.stringify(network),
    },
    publicDir: single ? false : "public",
    // Workers are built as classic scripts and inlined into the page: a module worker cannot start
    // from `file://`, which is how the single-file build is opened.
    worker: { format: "iife" },
    build: {
      outDir,
      emptyOutDir: true,
      // CSS is kept byte-for-byte until screenshot-gated cleanup replaces this.
      cssMinify: false,
    },
    plugins: single
      ? [networkContentSecurityPolicy(network), viteSingleFile(), renameSingleFileOutput(outDir)]
      : [
          networkContentSecurityPolicy(network),
          stripStylesheetCrossorigin(),
          precacheBuiltAssets(outDir, network),
        ],
  };
});
