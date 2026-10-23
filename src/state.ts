import { invoke } from "@tauri-apps/api/core";
import { createStore } from "solid-js/store";
import { batch, createSignal } from "solid-js";
import type { FileInfo, PaneState, Side, AppSettings, WorkspaceSnapshot } from "./types";
import {
  joinPath,
  parentPath,
  isRemotePath,
  parseRemotePath,
  sortFiles,
} from "./types";
import { applyTheme } from "./themes";
import { compileFileFilter, prepareFileName, type FilterMode, type PreparedName } from "./filter";
import { ensureMigemo, expandMigemoTerm } from "./migemo";

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
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [filterQuery, setFilterQuery] = createSignal("");
  const [filterOpen, changeFilterOpen] = createSignal(false);
  const [filterMode, changeFilterMode] = createSignal<FilterMode>("smart");
  const [filterHighlights, setFilterHighlights] = createSignal<ReadonlyMap<string, readonly number[]>>(new Map());
  const [totalCount, setTotalCount] = createSignal(0);
  let listing: FileInfo[] = [];
  let preparedListing: { file: FileInfo; name: PreparedName; index: number }[] | null = null;
  let navGen = 0;

  const setListing = (files: FileInfo[]) => { listing = files; preparedListing = null; };
  const setFilterOpen = (open: boolean) => {
    changeFilterOpen(open);
    if (open) void ensureMigemo();
  };
  const showListing = (preserveCursor = true) => {
    const query = filterQuery();
    let files = listing;
    const highlights = new Map<string, readonly number[]>();
    if (query.trim()) {
      const match = compileFileFilter(query, { mode: filterMode(), expandTerm: expandMigemoTerm });
      preparedListing ??= listing.map((file, index) => ({ file, name: prepareFileName(file.name), index }));
      const hits = preparedListing.flatMap((item) => {
        if (item.file.name === "..") return [];
        const result = match(item.name);
        if (!result) return [];
        highlights.set(item.file.name, result.positions);
        return [{ ...item, score: result.score }];
      });
      if (filterMode() === "smart") hits.sort((a, b) => b.score - a.score || a.index - b.index);
      files = [...listing.filter((file) => file.name === ".."), ...hits.map((item) => item.file)];
    }
    const cursorName = state.files[state.cursorIndex]?.name;
    const selectedNames = new Set(state.selectedIndices.map((i) => state.files[i]?.name));
    const cursor = !preserveCursor || query && cursorName === ".." ? -1 : files.findIndex((file) => file.name === cursorName);
    const first = files.findIndex((file) => file.name !== "..");
    batch(() => {
      setFilterHighlights(highlights);
      setState({
        files,
        cursorIndex: cursor >= 0 ? cursor : Math.max(0, first),
        selectedIndices: files.flatMap((file, i) => file.name !== ".." && selectedNames.has(file.name) ? [i] : []),
      });
    });
  };
  const setFilter = (query: string) => {
    const changed = query !== filterQuery();
    if (query.trim()) void ensureMigemo();
    batch(() => { setFilterQuery(query); showListing(!changed || !query.trim()); });
  };
  const setFilterMode = (mode: FilterMode) => {
    if (mode === filterMode()) return;
    batch(() => { changeFilterMode(mode); showListing(!filterQuery().trim()); });
    if (mode === "smart") void ensureMigemo();
  };
  const closeFilter = () => { setFilter(""); setFilterOpen(false); };

  const applyListing = (files: FileInfo[]): FileInfo[] => {
    const sort = settings()?.sort;
    let listed = files;
    if (!showHidden()) listed = listed.filter((f) => !f.is_hidden);
    return sortFiles(listed, sort?.dirs_first ?? true, sort?.case_sensitive ?? false);
  };

  const fetchFiles = async (path: string): Promise<FileInfo[]> => {
    if (isRemotePath(path)) {
      const parsed = parseRemotePath(path);
      if (!parsed) throw new Error("Invalid remote path");
      const files = await invoke<FileInfo[]>("ssh_read_dir", {
        host: parsed.host,
        port: parsed.port,
        path: parsed.remotePath,
      });
      return applyListing(files);
    }
    const files = await invoke<FileInfo[]>("read_dir", { path });
    return applyListing(files);
  };

  const requestFiles = async (path: string): Promise<FileInfo[] | null> => {
    const gen = ++navGen;
    setLoading(true);
    setLoadError("");
    try {
      const files = await fetchFiles(path);
      return gen === navGen ? files : null;
    } catch (error) {
      if (gen !== navGen) return null;
      setLoadError(`${path}: ${error}`);
      throw error;
    } finally {
      if (gen === navGen) setLoading(false);
    }
  };

  const navigateTo = async (path: string, addToHistory = true) => {
    const files = await requestFiles(path);
    if (!files) return;
    setListing(files);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    setFilterQuery("");
    setFilterHighlights(new Map());
    setFilterOpen(false);

    if (addToHistory) {
      const newHistory = state.history.slice(0, Math.max(state.historyIndex, 0) + 1);
      if (state.path && state.historyIndex >= 0) {
        newHistory[state.historyIndex] = {
          path: state.path,
          cursorIndex: state.cursorIndex,
        };
      }
      const last = newHistory[newHistory.length - 1];
      if (!last || last.path !== path) {
        newHistory.push({ path, cursorIndex: 0 });
      }
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
        history: [{ path, cursorIndex: 0 }],
        historyIndex: 0,
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
      Math.max(0, Math.min(state.files.length - 1, state.cursorIndex + visibleRows))
    );
  };

  const toggleSelect = () => {
    const idx = state.cursorIndex;
    if (!state.files[idx] || state.files[idx].name === "..") {
      cursorDown();
      return;
    }
    const selected = [...state.selectedIndices];
    const pos = selected.indexOf(idx);
    if (pos >= 0) selected.splice(pos, 1);
    else selected.push(idx);
    setState("selectedIndices", selected);
    if (state.cursorIndex < state.files.length - 1)
      setState("cursorIndex", state.cursorIndex + 1);
  };

  const selectAll = () => {
    setState("selectedIndices", state.files.flatMap((file, i) => file.name === ".." ? [] : [i]));
  };

  const clearSelection = () => setState("selectedIndices", []);

  const refresh = async () => {
    if (!state.path) return;
    const files = await requestFiles(state.path);
    if (!files) return;
    setListing(files);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    showListing();
  };

  const historyBack = async () => {
    if (state.historyIndex <= 0) return;
    const newHistory = [...state.history];
    newHistory[state.historyIndex] = {
      path: state.path,
      cursorIndex: state.cursorIndex,
    };
    const nextIndex = state.historyIndex - 1;
    const entry = newHistory[nextIndex];
    if (!entry) return;
    const files = await requestFiles(entry.path);
    if (!files) return;
    setListing(files);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    setFilterQuery("");
    setFilterHighlights(new Map());
    setFilterOpen(false);
    setState({
      path: entry.path,
      files,
      cursorIndex: Math.max(0, Math.min(entry.cursorIndex, files.length - 1)),
      selectedIndices: [],
      history: newHistory,
      historyIndex: nextIndex,
    });
  };

  const historyForward = async () => {
    if (state.historyIndex >= state.history.length - 1) return;
    const newHistory = [...state.history];
    newHistory[state.historyIndex] = {
      path: state.path,
      cursorIndex: state.cursorIndex,
    };
    const nextIndex = state.historyIndex + 1;
    const entry = newHistory[nextIndex];
    if (!entry) return;
    const files = await requestFiles(entry.path);
    if (!files) return;
    setListing(files);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    setFilterQuery("");
    setFilterHighlights(new Map());
    setFilterOpen(false);
    setState({
      path: entry.path,
      files,
      cursorIndex: Math.max(0, Math.min(entry.cursorIndex, files.length - 1)),
      selectedIndices: [],
      history: newHistory,
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

  const invertSelection = () => {
    const selected = new Set(state.selectedIndices);
    const inverted = state.files
      .map((file, i) => (file.name !== ".." && !selected.has(i) ? i : -1))
      .filter((i) => i >= 0);
    setState("selectedIndices", inverted);
  };

  const selectByExtension = (ext: string) => {
    const indices = state.files
      .map((file, i) => (!file.is_dir && file.extension === ext ? i : -1))
      .filter((i) => i >= 0);
    setState("selectedIndices", indices);
  };

  return {
    state,
    loading,
    loadError,
    filterQuery,
    filterOpen,
    filterMode,
    filterHighlights,
    setFilterMode,
    reapplyFilter: showListing,
    setFilterOpen,
    setFilter,
    closeFilter,
    totalCount,
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
    invertSelection,
    selectByExtension,
    refresh,
    historyBack,
    historyForward,
    getSelectedPaths,
    setCursorToFile,
  };
}

export type PaneActions = ReturnType<typeof createPaneState>;

// Each tab owns its panes, including pending navigation. Switching tabs only
// changes the active reference; large listings are never serialized or copied.
export function createTabState() {
  function createTab() {
    const [panes, setPanes] = createSignal({ left: createPaneState(), right: createPaneState() });
    const [activeSide, setActiveSide] = createSignal<Side>("left");
    return {
      id: crypto.randomUUID(),
      get left() { return panes().left; },
      get right() { return panes().right; },
      activeSide,
      setActiveSide,
      swap() { setPanes(({ left, right }) => ({ left: right, right: left })); },
    };
  }
  const [tabs, setTabs] = createSignal([createTab()]);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const current = () => tabs()[activeIndex()];
  const switchTo = (index: number) => {
    if (index >= 0 && index < tabs().length) setActiveIndex(index);
  };
  const add = () => {
    const tab = createTab();
    batch(() => {
      setTabs((prev) => [...prev, tab]);
      setActiveIndex(tabs().length - 1);
    });
    return tab;
  };
  const close = (index: number) => {
    if (tabs().length <= 1 || index < 0 || index >= tabs().length) return;
    const active = activeIndex();
    batch(() => {
      setTabs((prev) => prev.filter((_, i) => i !== index));
      setActiveIndex(index < active ? active - 1 : Math.min(active, tabs().length - 1));
    });
  };
  const snapshot = (): WorkspaceSnapshot | null => {
    const saved = tabs().map((tab) => ({ left_path: tab.left.state.path, right_path: tab.right.state.path, active_side: tab.activeSide() }));
    if (saved.some((tab) => !tab.left_path || !tab.right_path)) return null;
    return { tabs: saved, active_index: activeIndex() };
  };
  const restore = (snapshot: WorkspaceSnapshot) => {
    const restored = snapshot.tabs.map((saved) => {
      const tab = createTab();
      tab.left.setState({ path: saved.left_path, history: [{ path: saved.left_path, cursorIndex: 0 }], historyIndex: 0 });
      tab.right.setState({ path: saved.right_path, history: [{ path: saved.right_path, cursorIndex: 0 }], historyIndex: 0 });
      tab.setActiveSide(saved.active_side);
      return tab;
    });
    if (!restored.length) return;
    batch(() => {
      setTabs(restored);
      setActiveIndex(Math.max(0, Math.min(snapshot.active_index, restored.length - 1)));
    });
  };
  return { tabs, activeIndex, current, switchTo, add, close, snapshot, restore };
}

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
export const KEYMAP_PRESET = "afxw-2";

export const DEFAULT_KEYBINDS: Record<string, string> = {
  ArrowUp: "cursor_up",
  ArrowDown: "cursor_down",
  Home: "cursor_top",
  End: "cursor_bottom",
  PageUp: "cursor_page_up",
  PageDown: "cursor_page_down",
  Enter: "enter",
  "Shift+Enter": "preview",
  Backspace: "parent_dir",
  Tab: "switch_pane",
  " ": "toggle_select",
  Insert: "toggle_select",
  Delete: "delete",
  F2: "rename",
  F3: "preview",
  F5: "copy_to_other",
  F6: "move_to_other",
  "Shift+F5": "copy_as",
  "Shift+F6": "move_as",
  F7: "new_folder",
  "Shift+F7": "new_file",
  F8: "delete",
  a: "select_all",
  c: "copy_to_other",
  m: "move_to_other",
  d: "delete",
  r: "rename",
  k: "new_folder",
  e: "open_in_editor",
  v: "preview",
  x: "open_file",
  j: "bookmark_list",
  "Shift+j": "goto_path",
  l: "drive_list",
  ";": "bookmark_list",
  o: "sync_to_other",
  "Shift+o": "sync_from_other",
  "\\": "go_root",
  "Ctrl+a": "select_all",
  "Ctrl+c": "copy",
  "Ctrl+x": "move",
  "Ctrl+r": "refresh",
  "Ctrl+d": "bookmark_add",
  "Ctrl+g": "goto_path",
  "Ctrl+l": "goto_path",
  "Ctrl+i": "invert_selection",
  "Ctrl+u": "swap_panes",
  "Ctrl+e": "select_same_ext",
  "Ctrl+Shift+c": "copy_path",
  "Ctrl+Shift+n": "copy_name",
  "Ctrl+Shift+Enter": "open_terminal",
  "Alt+Home": "go_home",
  "Alt+ArrowLeft": "history_back",
  "Alt+ArrowRight": "history_forward",
  ArrowLeft: "left_pane",
  ArrowRight: "right_pane",
  "Alt+1": "left_pane",
  "Alt+2": "right_pane",
  "Alt+d": "drive_list",
  "Ctrl+t": "tab_new",
  "Ctrl+w": "tab_close",
  "Ctrl+Tab": "tab_next",
  "Ctrl+Shift+Tab": "tab_prev",
  Escape: "clear_selection",
  "Ctrl+s": "ssh_connect",
  "/": "filter",
  "Ctrl+f": "filter",
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
      setKeybinds({ ...DEFAULT_KEYBINDS, ...kbResult.keybind });
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
    await invoke("keybinds_save", {
      keybinds: { preset: KEYMAP_PRESET, keybind: kb },
    });
    setKeybinds(kb);
  } catch (e) {
    console.error("Failed to save keybinds:", e);
  }
}

export function applySettingsToDOM(s: AppSettings) {
  const root = document.documentElement;
  root.style.setProperty("--font-size", `${s.display.font_size}px`);
  root.style.setProperty("--row-height", `${s.display.row_height}px`);
  root.style.setProperty("--chrome-size", `${Math.max(s.display.font_size, 16)}px`);
  applyTheme(s.display.theme);
}

// Reactive row height for virtual scrolling
export function rowHeight(): number {
  return settings()?.display.row_height ?? 29;
}

// Show hidden files toggle
export function showHidden(): boolean {
  return settings()?.display.show_hidden ?? true;
}
