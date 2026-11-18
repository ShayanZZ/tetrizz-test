import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Builds a rule that forbids importing the listed module patterns. */
const forbid = (group, message) => ({
  "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
});

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-single/**",
      "legacy/**",
      "tests/golden/**",
      "tests/fixtures/**",
      "tests/harness/**",
      "apps/web/index.html",
      "apps/web/public/sw.js",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },

  // Dependency direction: core and protocol import no workspace package; bot imports only core;
  // apps import packages but never each other.
  {
    files: ["packages/core/**/*.ts", "packages/protocol/**/*.ts"],
    rules: forbid(
      ["@tetrizz/*", "node:*"],
      "core and protocol must not import other workspace packages or Node modules.",
    ),
  },
  {
    files: ["packages/bot/**/*.ts"],
    rules: forbid(
      ["@tetrizz/protocol", "@tetrizz/web", "@tetrizz/server", "node:*"],
      "bot may import only @tetrizz/core.",
    ),
  },
  {
    files: ["apps/web/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
    rules: forbid(["@tetrizz/server"], "apps must not import each other."),
  },
  {
    files: ["apps/server/**/*.ts"],
    rules: forbid(["@tetrizz/web"], "apps must not import each other."),
  },

  // Modules extracted from the original single-file script keep a `@ts-nocheck` header and relaxed
  // rules until each one is converted to checked TypeScript. The new core modules are strict.
  {
    files: ["apps/web/src/**/*.ts", "packages/bot/src/{bitboard,ten-wide,four-wide,planner}.ts"],
    ignores: [
      "apps/web/src/core/{escape,events,logger,storage,version}.ts",
      "apps/web/src/vite-env.d.ts",
    ],
    rules: {
      "@typescript-eslint/ban-ts-comment": ["error", { "ts-nocheck": false }],
      "@typescript-eslint/no-unused-vars": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "no-empty": "warn",
      "prefer-const": "warn",
      "prefer-rest-params": "warn",
      "prefer-spread": "warn",
      "no-dupe-else-if": "warn",
      "preserve-caught-error": "warn",
    },
  },

  prettier,
);
