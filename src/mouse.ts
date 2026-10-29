import { baseName, joinPath, type PaneState, type Side } from "./types";

export interface DragSource {
  side: Side;
  directory: string;
  paths: string[];
  names: string[];
}

export function toggleMouseSelection(state: Pick<PaneState, "files" | "selectedIndices" | "cursorIndex">, index: number): number[] {
  const selected = [...state.selectedIndices];
  const clicked = state.files[index];
  if (!clicked || clicked.name === "..") return selected;
  const current = state.files[state.cursorIndex];
  // An unmarked cursor is the effective single selection. Preserve it when
  // Ctrl/Command-click adds a second file, just as desktop file managers do.
  if (!selected.length && state.cursorIndex !== index && current && current.name !== "..") selected.push(state.cursorIndex);
  const position = selected.indexOf(index);
  if (position >= 0) selected.splice(position, 1);
  else selected.push(index);
  return selected;
}

// Capture names and paths when the drag starts. A directory refresh must not
// substitute the file that happens to occupy an old row index later.
export function captureDragSource(state: Pick<PaneState, "path" | "files" | "selectedIndices">, side: Side, index: number): DragSource | null {
  const file = state.files[index];
  if (!file || file.name === "..") return null;
  const indices = state.selectedIndices.includes(index) ? state.selectedIndices : [index];
  const names = indices.flatMap((i) => {
    const selected = state.files[i];
    return selected && selected.name !== ".." ? [selected.name] : [];
  });
  return names.length ? { side, directory: state.path, names, paths: names.map((name) => joinPath(state.path, name)) } : null;
}

export function nativeDropPoint(position: { x: number; y: number }, isMac: boolean, devicePixelRatio: number) {
  // The bundled Wry WKWebView sends Cocoa points; WebView2 sends physical pixels.
  const scale = isMac ? 1 : (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1);
  return { x: position.x / scale, y: position.y / scale };
}

export function hasDuplicateDropNames(paths: readonly string[]): boolean {
  const names = new Set<string>();
  for (const path of paths) {
    const name = baseName(path).normalize("NFC").toLowerCase();
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

export function contextTargetIsCurrent(state: Pick<PaneState, "path" | "files" | "selectedIndices" | "cursorIndex">, snapshot: { directory: string; name: string | null; selectedNames: string[] }, requiresTarget: boolean): boolean {
  if (state.path !== snapshot.directory) return false;
  if (!requiresTarget) return true;
  if (state.files[state.cursorIndex]?.name !== snapshot.name) return false;
  const selected = state.selectedIndices.flatMap((index) => state.files[index] ? [state.files[index].name] : []);
  const captured = new Set(snapshot.selectedNames);
  return selected.length === snapshot.selectedNames.length && selected.every((name) => captured.has(name));
}

export function menuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const gap = 8;
  return {
    x: Math.max(gap, Math.min(x, viewportWidth - width - gap)),
    y: Math.max(gap, Math.min(y, viewportHeight - height - gap)),
  };
}
