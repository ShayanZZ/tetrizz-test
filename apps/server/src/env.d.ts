/** Set by the build from the root package.json. */
declare const __APP_VERSION__: string;

/** The part of Vite's `import.meta.glob` that the migrations use. */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
