import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

// Use the same TypeScript bundler as Vite; no separate test runtime required.
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");

export async function frontendModule(extra = "") {
  const result = await build({
    stdin: {
      contents: `export * from './src/state.ts'; export * from './src/types.ts'; export { createRoot, createEffect } from 'solid-js'; ${extra}`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    plugins: [{
      name: "test-invoke",
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "mock" }));
        build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
          contents: "export const invoke = (...args) => globalThis.__kufInvoke(...args);",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

export function fixtureFiles(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `file-${String(count - i).padStart(6, "0")}.txt`,
    is_dir: false, size: i * 100, modified: "2026-10-23 12:00",
    extension: "txt", is_hidden: false, is_symlink: false, permissions: "rw-rw-rw-",
  }));
}
