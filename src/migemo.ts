import { createSignal } from "solid-js";
import { CompactDictionary, Migemo } from "jsmigemo";

export type MigemoStatus = "idle" | "loading" | "ready" | "error";
const [status, setStatus] = createSignal<MigemoStatus>("idle");
export const migemoStatus = status;

interface MigemoEngine {
  setDict(dict: unknown): void;
  query(term: string): string;
}

let engine: MigemoEngine | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, RegExp | null>();
const MAX_CACHE_SIZE = 128;

/** Initialize from the bundled dictionary; also permits deterministic offline tests. */
export function initializeMigemo(buffer: ArrayBuffer): void {
  const next: MigemoEngine = new Migemo();
  next.setDict(new CompactDictionary(buffer));
  engine = next;
  cache.clear();
  setStatus("ready");
}

/** Load once when filtering is first used. Failure leaves ordinary filtering available. */
export function ensureMigemo(): Promise<void> {
  if (engine) return Promise.resolve();
  if (loading) return loading;
  setStatus("loading");
  loading = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      // Vite copies this checked-in asset into the app; no external network is used.
      const response = await fetch("/migemo/migemo-compact-dict", { signal: controller.signal });
      if (!response.ok) throw new Error(`Migemo dictionary: HTTP ${response.status}`);
      initializeMigemo(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  })().catch(() => {
    // Do not reject a fire-and-forget call from a keyboard/focus event.
    if (!engine) setStatus("error");
  });
  return loading;
}

/** Expand a plain romanized term; user regular expressions are never accepted. */
export function expandMigemoTerm(term: string): RegExp | null {
  const key = term.toLowerCase();
  // Single letters fan out too widely. Limit terms before dictionary expansion.
  if (!engine || !/^[a-z][a-z']{1,63}$/.test(key)) return null;
  if (cache.has(key)) return cache.get(key)!;
  let result: RegExp | null = null;
  try {
    const pattern = engine.query(key);
    if (pattern.length <= 16_384) result = new RegExp(pattern, "iu");
  } catch {
    // A dictionary/engine error must not disable literal/fuzzy matching.
  }
  if (cache.size >= MAX_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}
