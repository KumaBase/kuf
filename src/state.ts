import { invoke } from "@tauri-apps/api/core";
import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import type { FileInfo, PaneState, Side, AppSettings } from "./types";
import {
  joinPath,
  parentPath,
  isRemotePath,
  parseRemotePath,
} from "./types";
import { applyTheme } from "./themes";

const EMPTY_PANE: PaneState = {
  path: "",
  files: [],
  cursorIndex: 0,
  selectedIndices: [],
  history: [],
  historyIndex: -1,
};

export function createPaneState() {
  const [state, setState] = createStore<PaneState>({ ...EMPTY_PANE });

  const fetchFiles = async (path: string): Promise<FileInfo[]> => {
    if (isRemotePath(path)) {
      const parsed = parseRemotePath(path);
      if (!parsed) throw new Error("Invalid remote path");
      let files = await invoke<FileInfo[]>("ssh_read_dir", {
        host: parsed.host,
        port: parsed.port,
        path: parsed.remotePath,
      });
      if (!showHidden()) files = files.filter((f) => !f.is_hidden);
      return files;
    }
    let files = await invoke<FileInfo[]>("read_dir", { path });
    if (!showHidden()) files = files.filter((f) => !f.is_hidden);
    return files;
  };

  const navigateTo = async (path: string, addToHistory = true) => {
    const files = await fetchFiles(path);
    const prevCursor = state.cursorIndex;
    const prevPath = state.path;

    if (addToHistory && prevPath) {
      const newHistory = [...state.history];
      newHistory.splice(state.historyIndex + 1);
      newHistory.push({ path: prevPath, cursorIndex: prevCursor });
      setState({
        path,
        files,
        cursorIndex: 0,
        selectedIndices: [],
        history: newHistory,
        historyIndex: newHistory.length - 1,
      });
    } else {
      setState({
        path,
        files,
        cursorIndex: 0,
        selectedIndices: [],
      });
    }
  };

  const cursorUp = () => {
    if (state.cursorIndex > 0) setState("cursorIndex", state.cursorIndex - 1);
  };

  const cursorDown = () => {
    if (state.cursorIndex < state.files.length - 1)
      setState("cursorIndex", state.cursorIndex + 1);
  };

  const cursorTop = () => setState("cursorIndex", 0);

  const cursorBottom = () => {
    if (state.files.length > 0)
      setState("cursorIndex", state.files.length - 1);
  };

  const cursorPageUp = (visibleRows: number) => {
    setState("cursorIndex", Math.max(0, state.cursorIndex - visibleRows));
  };

  const cursorPageDown = (visibleRows: number) => {
    setState(
      "cursorIndex",
      Math.min(state.files.length - 1, state.cursorIndex + visibleRows)
    );
  };

  const toggleSelect = () => {
    const idx = state.cursorIndex;
    const selected = [...state.selectedIndices];
    const pos = selected.indexOf(idx);
    if (pos >= 0) selected.splice(pos, 1);
    else selected.push(idx);
    setState("selectedIndices", selected);
    if (state.cursorIndex < state.files.length - 1)
      setState("cursorIndex", state.cursorIndex + 1);
  };

  const selectAll = () => {
    setState("selectedIndices", state.files.map((_, i) => i));
  };

  const clearSelection = () => setState("selectedIndices", []);

  const refresh = async () => {
    if (!state.path) return;
    const files = await fetchFiles(state.path);
    setState({
      files,
      cursorIndex: Math.min(state.cursorIndex, files.length - 1),
      selectedIndices: [],
    });
  };

  const historyBack = async () => {
    if (state.historyIndex < 0) return;
    const entry = state.history[state.historyIndex];
    if (!entry) return;
    const files = await fetchFiles(entry.path);
    setState({
      path: entry.path,
      files,
      cursorIndex: Math.min(entry.cursorIndex, files.length - 1),
      selectedIndices: [],
      historyIndex: state.historyIndex - 1,
    });
  };

  const historyForward = async () => {
    if (state.historyIndex >= state.history.length - 1) return;
    const nextIndex = state.historyIndex + 2;
    const entry = state.history[nextIndex];
    if (!entry) return;
    const files = await fetchFiles(entry.path);
    setState({
      path: entry.path,
      files,
      cursorIndex: Math.min(entry.cursorIndex, files.length - 1),
      selectedIndices: [],
      historyIndex: nextIndex,
    });
  };

  const getSelectedPaths = (): string[] => {
    if (state.selectedIndices.length > 0) {
      return state.selectedIndices
        .filter((i) => i >= 0 && i < state.files.length)
        .filter((i) => state.files[i].name !== "..")
        .map((i) => joinPath(state.path, state.files[i].name));
    }
    const file = state.files[state.cursorIndex];
    if (file && file.name !== "..") return [joinPath(state.path, file.name)];
    return [];
  };

  const setCursorToFile = (name: string) => {
    const idx = state.files.findIndex((f) => f.name === name);
    if (idx >= 0) setState("cursorIndex", idx);
  };

  return {
    state,
    setState,
    navigateTo,
    cursorUp,
    cursorDown,
    cursorTop,
    cursorBottom,
    cursorPageUp,
    cursorPageDown,
    toggleSelect,
    selectAll,
    clearSelection,
    refresh,
    historyBack,
    historyForward,
    getSelectedPaths,
    setCursorToFile,
  };
}

export type PaneActions = ReturnType<typeof createPaneState>;

// Clipboard state
export type ClipOp = "copy" | "move";

let clipState: {
  sourcePath: string;
  files: string[];
  op: ClipOp;
} | null = null;

export function getClipboard() {
  return clipState;
}

export function setClipboard(sourcePath: string, files: string[], op: ClipOp) {
  clipState = { sourcePath, files, op };
}

export function clearClipboard() {
  clipState = null;
}

// Incremental search state
let searchQuery = "";
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export function getSearchQuery() {
  return searchQuery;
}

export function resetSearch() {
  searchQuery = "";
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

export function appendSearch(char: string): string {
  searchQuery += char.toLowerCase();
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = "";
  }, 2000);
  return searchQuery;
}

// Keybind map (dynamic, loaded from config)
export const DEFAULT_KEYBINDS: Record<string, string> = {
  ArrowUp: "cursor_up",
  ArrowDown: "cursor_down",
  Home: "cursor_top",
  End: "cursor_bottom",
  Enter: "preview",
  Backspace: "parent_dir",
  Tab: "switch_pane",
  " ": "toggle_select",
  Insert: "toggle_select",
  Delete: "delete",
  F2: "rename",
  F5: "copy",
  F6: "move",
  F7: "new_folder",
  F8: "delete",
  c: "copy",
  m: "move",
  d: "delete",
  r: "rename",
  k: "new_folder",
  f: "bookmark_list",
  "Ctrl+a": "select_all",
  "Ctrl+r": "refresh",
  "Ctrl+d": "bookmark_add",
  "Alt+ArrowLeft": "history_back",
  "Alt+ArrowRight": "history_forward",
  "Alt+1": "left_pane",
  "Alt+2": "right_pane",
  o: "sync_to_other",
  "Shift+O": "sync_from_other",
  "\\": "copy_to_other",
  "Ctrl+\\": "move_to_other",
  "Ctrl+t": "tab_new",
  "Ctrl+w": "tab_close",
  "Ctrl+Tab": "tab_next",
  "Ctrl+Shift+Tab": "tab_prev",
  e: "open_in_editor",
  F3: "preview",
  x: "open_file",
  Escape: "clear_selection",
  "Ctrl+s": "ssh_connect",
};

const [keybinds, setKeybinds] = createSignal<Record<string, string>>({
  ...DEFAULT_KEYBINDS,
});

export { keybinds, setKeybinds };

// Settings signal
const [settings, setSettings] = createSignal<AppSettings | null>(null);

export { settings, setSettings };

export async function loadSettings() {
  try {
    const s = await invoke<AppSettings>("settings_load");
    setSettings(s);

    // Load keybinds
    const kbResult = await invoke<{ keybind: Record<string, string> }>("keybinds_load");
    if (kbResult && kbResult.keybind) {
      setKeybinds(kbResult.keybind);
    }

    return s;
  } catch (e) {
    console.error("Failed to load settings:", e);
    return null;
  }
}

export async function saveSettings(s: AppSettings) {
  try {
    await invoke("settings_save", { settings: s });
    setSettings(s);
    applySettingsToDOM(s);
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

export async function saveKeybinds(kb: Record<string, string>) {
  try {
    await invoke("keybinds_save", { keybinds: { keybind: kb } });
    setKeybinds(kb);
  } catch (e) {
    console.error("Failed to save keybinds:", e);
  }
}

export function applySettingsToDOM(s: AppSettings) {
  const root = document.documentElement;
  root.style.setProperty("--font-size", `${s.display.font_size}px`);
  root.style.setProperty("--row-height", `${s.display.row_height}px`);
  applyTheme(s.display.theme);
}

// Reactive row height for virtual scrolling
export function rowHeight(): number {
  return settings()?.display.row_height ?? 22;
}

// Show hidden files toggle
export function showHidden(): boolean {
  return settings()?.display.show_hidden ?? true;
}
