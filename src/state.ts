import { invoke } from "@tauri-apps/api/core";
import { createStore } from "solid-js/store";
import { batch, createSignal } from "solid-js";
import type { FileInfo, PaneState, Side, AppSettings, WorkspaceSnapshot, SortSpec } from "./types";
import {
  joinPath,
  parentPath,
  isRemotePath,
  parseRemotePath,
  sortFiles,
  baseName,
} from "./types";
import { applyTheme } from "./themes";
import { compileFileFilter, prepareFileName, type FilterMode, type PreparedName } from "./filter";
import { ensureMigemo, expandMigemoTerm } from "./migemo";
import { applyPatternSelection, rangeSelection, selectByKind, type PatternSelectionMode } from "./filer-selection";

const EMPTY_PANE: PaneState = {
  path: "",
  files: [],
  cursorIndex: 0,
  selectedIndices: [],
  history: [],
  historyIndex: -1,
};

export function createPaneState(initialSort: SortSpec = { key: "name", order: "asc" }) {
  const [state, setState] = createStore<PaneState>({ ...EMPTY_PANE });
  const [sort, changeSort] = createSignal<SortSpec>({ ...initialSort });
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
  let rangeAnchor: number | null = null;
  const resetRangeSelection = () => { rangeAnchor = null; };

  const setListing = (files: FileInfo[]) => {
    resetRangeSelection();
    const preferences = settings()?.sort;
    listing = sortFiles(files, preferences?.dirs_first ?? true, preferences?.case_sensitive ?? false, sort());
    preparedListing = null;
    return listing;
  };
  const setFilterOpen = (open: boolean) => {
    changeFilterOpen(open);
    if (open) void ensureMigemo();
  };
  const showListing = (preserveCursor = true) => {
    resetRangeSelection();
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

  const resort = () => {
    setListing(listing);
    showListing();
  };

  const setSort = (next: SortSpec) => {
    if (next.key === sort().key && next.order === sort().order) return;
    batch(() => {
      changeSort({ ...next });
      resort();
    });
  };

  const applyListing = (files: FileInfo[]): FileInfo[] => {
    let listed = files;
    if (!showHidden()) listed = listed.filter((f) => !f.is_hidden);
    return listed;
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
    const requested = await requestFiles(path);
    if (!requested) return;
    const files = setListing(requested);
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
          cursorName: state.files[state.cursorIndex]?.name,
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
    resetRangeSelection();
    if (state.cursorIndex > 0) setState("cursorIndex", state.cursorIndex - 1);
  };

  const cursorDown = () => {
    resetRangeSelection();
    if (state.cursorIndex < state.files.length - 1)
      setState("cursorIndex", state.cursorIndex + 1);
  };

  const cursorTop = () => { resetRangeSelection(); setState("cursorIndex", 0); };

  const cursorBottom = () => {
    resetRangeSelection();
    if (state.files.length > 0)
      setState("cursorIndex", state.files.length - 1);
  };

  const cursorPageUp = (visibleRows: number) => {
    resetRangeSelection();
    setState("cursorIndex", Math.max(0, state.cursorIndex - visibleRows));
  };

  const cursorPageDown = (visibleRows: number) => {
    resetRangeSelection();
    setState(
      "cursorIndex",
      Math.max(0, Math.min(state.files.length - 1, state.cursorIndex + visibleRows))
    );
  };

  const toggleSelect = () => {
    resetRangeSelection();
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
    resetRangeSelection();
    setState("selectedIndices", state.files.flatMap((file, i) => file.name === ".." ? [] : [i]));
  };

  const toggleSelectUp = () => {
    resetRangeSelection();
    const index = state.cursorIndex;
    if (state.files[index]?.name !== ".." && state.files[index]) {
      const selected = new Set(state.selectedIndices);
      if (selected.has(index)) selected.delete(index); else selected.add(index);
      setState("selectedIndices", [...selected]);
    }
    if (index > 0) setState("cursorIndex", index - 1);
  };

  const clearSelection = () => { resetRangeSelection(); setState("selectedIndices", []); };

  const selectRangeTo = (index: number) => {
    if (!state.files.length || !Number.isFinite(index)) return;
    const target = Math.max(0, Math.min(state.files.length - 1, Math.trunc(index)));
    rangeAnchor ??= state.cursorIndex;
    batch(() => {
      setState("selectedIndices", rangeSelection(state.files, rangeAnchor!, target));
      setState("cursorIndex", target);
    });
  };

  const selectFiles = () => { resetRangeSelection(); setState("selectedIndices", selectByKind(state.files, "files")); };
  const selectDirectories = () => { resetRangeSelection(); setState("selectedIndices", selectByKind(state.files, "directories")); };
  const selectPattern = (pattern: string, mode: PatternSelectionMode = "replace") => {
    const indices = applyPatternSelection(state.files, state.selectedIndices, pattern, mode, settings()?.sort.case_sensitive ?? false);
    resetRangeSelection();
    setState("selectedIndices", indices);
  };

  const refresh = async () => {
    if (!state.path) return;
    const requested = await requestFiles(state.path);
    if (!requested) return;
    const files = setListing(requested);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    showListing();
  };

  const jumpHistory = async (nextIndex: number) => {
    if (nextIndex === state.historyIndex || !Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= state.history.length) return;
    const newHistory = [...state.history];
    newHistory[state.historyIndex] = {
      path: state.path,
      cursorIndex: state.cursorIndex,
      cursorName: state.files[state.cursorIndex]?.name,
    };
    const entry = newHistory[nextIndex];
    if (!entry) return;
    const requested = await requestFiles(entry.path);
    if (!requested) return;
    const files = setListing(requested);
    setTotalCount(files.filter((file) => file.name !== "..").length);
    setFilterQuery("");
    setFilterHighlights(new Map());
    setFilterOpen(false);
    const namedCursor = entry.cursorName === undefined ? -1 : files.findIndex((file) => file.name === entry.cursorName);
    setState({
      path: entry.path,
      files,
      cursorIndex: namedCursor >= 0 ? namedCursor : Math.max(0, Math.min(entry.cursorIndex, files.length - 1)),
      selectedIndices: [],
      history: newHistory,
      historyIndex: nextIndex,
    });
  };

  const historyBack = () => jumpHistory(state.historyIndex - 1);
  const historyForward = () => jumpHistory(state.historyIndex + 1);
  const navigateParent = async () => {
    const origin = state.path;
    const parent = parentPath(origin);
    if (origin === parent) return;
    await navigateTo(parent);
    if (state.path === parent) setCursorToFile(baseName(origin));
  };

  const getSelectedNames = (): string[] => {
    if (state.selectedIndices.length > 0) {
      return state.selectedIndices
        .filter((i) => i >= 0 && i < state.files.length)
        .filter((i) => state.files[i].name !== "..")
        .map((i) => state.files[i].name);
    }
    const file = state.files[state.cursorIndex];
    if (file && file.name !== "..") return [file.name];
    return [];
  };
  const getSelectedPaths = (): string[] => getSelectedNames().map((name) => joinPath(state.path, name));

  const setCursorToFile = (name: string) => {
    resetRangeSelection();
    const idx = state.files.findIndex((f) => f.name === name);
    if (idx >= 0) setState("cursorIndex", idx);
  };

  const invertSelection = () => {
    resetRangeSelection();
    const selected = new Set(state.selectedIndices);
    const inverted = state.files
      .map((file, i) => (file.name !== ".." && !selected.has(i) ? i : -1))
      .filter((i) => i >= 0);
    setState("selectedIndices", inverted);
  };

  const selectByExtension = (ext: string) => {
    resetRangeSelection();
    const indices = state.files
      .map((file, i) => (!file.is_dir && file.extension === ext ? i : -1))
      .filter((i) => i >= 0);
    setState("selectedIndices", indices);
  };

  return {
    state,
    sort,
    setSort,
    resort,
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
    toggleSelectUp,
    selectAll,
    selectRangeTo,
    resetRangeSelection,
    selectFiles,
    selectDirectories,
    selectPattern,
    clearSelection,
    invertSelection,
    selectByExtension,
    refresh,
    historyBack,
    historyForward,
    jumpHistory,
    navigateParent,
    getSelectedNames,
    getSelectedPaths,
    setCursorToFile,
  };
}

export type PaneActions = ReturnType<typeof createPaneState>;

// Each tab owns its panes, including pending navigation. Switching tabs only
// changes the active reference; large listings are never serialized or copied.
export function createTabState() {
  function createTab(leftSort?: SortSpec, rightSort?: SortSpec) {
    const [panes, setPanes] = createSignal({ left: createPaneState(leftSort), right: createPaneState(rightSort) });
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
    const tab = createTab(current().left.sort(), current().right.sort());
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
    const saved = tabs().map((tab) => ({
      left_path: tab.left.state.path, right_path: tab.right.state.path, active_side: tab.activeSide(),
      left_sort: { ...tab.left.sort() }, right_sort: { ...tab.right.sort() },
    }));
    if (saved.some((tab) => !tab.left_path || !tab.right_path)) return null;
    return { tabs: saved, active_index: activeIndex() };
  };
  const restore = (snapshot: WorkspaceSnapshot) => {
    const restored = snapshot.tabs.map((saved) => {
      const tab = createTab(saved.left_sort, saved.right_sort);
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
  "Ctrl+Shift+s": "sort",
  "Ctrl+Shift+r": "sort_reverse",
  "Ctrl+Shift+p": "command_palette",
  "Ctrl+q": "quit",
  "Ctrl+,": "settings",
  "Ctrl+v": "paste",
  "Ctrl+Shift+t": "tab_duplicate",
  h: "history_list",
  w: "compare_panes",
  "Shift+f": "search_files",
  p: "zip_create",
  u: "zip_extract",
  "@": "select_pattern",
  "Shift+@": "select_pattern",
  "Shift+ArrowUp": "select_range_up",
  "Shift+ArrowDown": "select_range_down",
  "Shift+Home": "select_range_top",
  "Shift+End": "select_range_bottom",
  "Shift+PageUp": "select_range_page_up",
  "Shift+PageDown": "select_range_page_down",
  "Shift+r": "bulk_rename",
  "Shift+x": "external_commands",
  f: "filter",
  "Shift+ ": "toggle_select_up",
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
    throw e;
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
    throw e;
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
