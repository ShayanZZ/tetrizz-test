import { defineConfig } from "vitest/config";

/** Runs only the timing scripts in tests/bench; the normal config leaves them out. */
export default defineConfig({
  test: { include: ["tests/bench/**/*.bench.ts"], fileParallelism: false },
});
