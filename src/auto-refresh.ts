import type { PaneActions } from "./state";

function watchPathKey(path: string): string {
  // Rust shares watches for Windows aliases and emits the first spelling.
  // Keep Unix paths case-sensitive, including names containing backslashes.
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : path;
}

// Coalesce invalidations and never let a background refresh cancel navigation.
export function createAutoRefresh(
  getPanes: () => PaneActions[],
  blocked: () => boolean,
  onError: (path: string, error: unknown) => void,
  delay = 150,
) {
  const dirty = new Set<string>();
  const warned = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false, disposed = false;
  const schedule = () => {
    if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  };
  async function flush() {
    if (disposed || running) return;
    const panes = getPanes();
    const visible = new Set(panes.map((pane) => pane.state.path));
    for (const path of dirty) if (!visible.has(path)) dirty.delete(path);
    if (!dirty.size) return;
    if (blocked()) { schedule(); return; }
    const ready = panes.filter((pane) => dirty.has(pane.state.path) && !pane.loading());
    const paths = new Set(ready.map((pane) => pane.state.path));
    for (const path of paths) if (!panes.some((pane) => pane.state.path === path && pane.loading())) dirty.delete(path);
    if (!ready.length) { schedule(); return; }
    running = true;
    await Promise.all(ready.map(async (pane) => {
      const path = pane.state.path;
      try { await pane.refresh(); warned.delete(path); }
      catch (error) {
        if (!disposed && pane.state.path === path && !warned.has(path)) { warned.add(path); onError(path, error); }
      }
    }));
    running = false;
    if (dirty.size) schedule();
  }
  return {
    request(paths: string[]) {
      if (disposed) return;
      const keys = new Set(paths.map(watchPathKey));
      for (const path of paths) dirty.add(path);
      for (const pane of getPanes()) {
        if (keys.has(watchPathKey(pane.state.path))) dirty.add(pane.state.path);
      }
      schedule();
    },
    dispose() { disposed = true; clearTimeout(timer); dirty.clear(); },
  };
}
