import { createSignal, createEffect, onMount, onCleanup, untrack, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import Pane from "./components/Pane";
import StatusBar from "./components/StatusBar";
import Dialog from "./components/Dialog";
import SettingsDialog from "./components/SettingsDialog";
import BookmarkDialog from "./components/BookmarkDialog";
import TabBar from "./components/TabBar";
import FileViewer from "./components/FileViewer";
import ConnectDialog from "./components/ConnectDialog";
import DriveDialog from "./components/DriveDialog";
import MenuBar from "./components/MenuBar";
import WorkspaceDialog from "./components/WorkspaceDialog";
import SortDialog from "./components/SortDialog";
import {
  createTabState,
  keybinds,
  loadSettings,
  applySettingsToDOM,
  settings,
  saveSettings,
  saveKeybinds,
  getClipboard,
  setClipboard,
  clearClipboard,
  resetSearch,
  appendSearch,
  rowHeight,
  type PaneActions,
} from "./state";
import type { Command, Side, ConnectedServer, WorkspaceData, WorkspaceSnapshot, SortKey, SortSpec } from "./types";
import { joinPath, parentPath, rootPath, isRemotePath, parseRemotePath, buildRemotePath, baseName, remotePathOnly } from "./types";
import { formatKeyEvent, SORT_LABELS } from "./commands";
import { focusApp, isTypingTarget, hasDialogOverlay } from "./focus";
import { createAutoRefresh } from "./auto-refresh";
import { migemoStatus } from "./migemo";

function App() {
  const workspace = createTabState();
  let sortPreferences = "";
  createEffect(() => {
    const preferences = settings()?.sort;
    const signature = preferences ? `${preferences.dirs_first}/${preferences.case_sensitive}` : "";
    if (!preferences || signature === sortPreferences) return;
    sortPreferences = signature;
    untrack(() => {
      for (const tab of workspace.tabs()) {
        tab.left.resort();
        tab.right.resort();
      }
    });
  });
  createEffect(() => {
    if (migemoStatus() === "ready") untrack(() => {
      for (const tab of workspace.tabs()) {
        for (const pane of [tab.left, tab.right]) if (pane.filterQuery().trim()) pane.reapplyFilter();
      }
    });
  });
  const left = () => workspace.current().left;
  const right = () => workspace.current().right;
  const activeSide = () => workspace.current().activeSide();
  const setActiveSide = (side: Side) => workspace.current().setActiveSide(side);
  const [loading, setLoading] = createSignal(true);
  const [initError, setInitError] = createSignal("");
  const [dialog, setDialog] = createSignal<null | {
    type: "confirm" | "input" | "message";
    title: string;
    message: string;
    defaultValue?: string;
    selectStem?: boolean;
    okLabel?: string;
    onOk: (value?: string) => void;
    onCancel: () => void;
  }>(null);
  const [statusMessage, setStatusMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [operation, setOperation] = createSignal<{
    id: string; label: string; elapsed: number; completed: number; total: number;
    cancellable: boolean; cancelling: boolean;
  } | null>(null);
  const [searchDisplay, setSearchDisplay] = createSignal("");
  const [showSettings, setShowSettings] = createSignal(false);
  const [showBookmarks, setShowBookmarks] = createSignal(false);
  const [showConnect, setShowConnect] = createSignal(false);
  const [showDrives, setShowDrives] = createSignal(false);
  const [showWorkspaces, setShowWorkspaces] = createSignal(false);
  const [sortTarget, setSortTarget] = createSignal<PaneActions | null>(null);
  const [workspaceData, setWorkspaceData] = createSignal<WorkspaceData>({ version: 1, last_session: null, workspaces: [] });
  const [sessionReady, setSessionReady] = createSignal(false);
  const [restoring, setRestoring] = createSignal(false);
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionQueue: Promise<unknown> = Promise.resolve();
  let workspaceLoaded = false;

  const queueWorkspaceCommand = (command: string, args: Record<string, unknown>) => {
    const saved = sessionQueue.catch(() => {}).then(() => invoke<WorkspaceData>(command, args)).then((data) => {
      setWorkspaceData(data);
      return data;
    });
    sessionQueue = saved;
    return saved;
  };
  const persistSession = (snapshot: WorkspaceSnapshot) => queueWorkspaceCommand("workspace_save_session", { snapshot });
  createEffect(() => {
    if (!sessionReady() || restoring()) return;
    const snapshot = workspace.snapshot();
    if (!snapshot) return;
    sessionTimer = setTimeout(() => {
      void persistSession(snapshot).catch((e) => {
        setSessionReady(false);
        flashStatus(`前回の状態を保存できませんでした: ${e}`);
      });
    }, 500);
    onCleanup(() => clearTimeout(sessionTimer));
  });
  const [showViewer, setShowViewer] = createSignal<{
    path: string;
    fileName: string;
    extension: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  const tabs = () => workspace.tabs().map((tab) => ({
    id: tab.id, left: tab.left.state, right: tab.right.state, activeSide: tab.activeSide(),
  }));
  const activeTabIndex = workspace.activeIndex;
  const [connectedServers, setConnectedServers] = createSignal<ConnectedServer[]>([]);

  const getActive = (): PaneActions =>
    activeSide() === "left" ? left() : right();
  const getInactive = (): PaneActions =>
    activeSide() === "left" ? right() : left();

  function applySort(pane: PaneActions, sort: SortSpec) {
    pane.setSort(sort);
    resetSearch();
    setSearchDisplay("");
    flashStatus(`${SORT_LABELS[sort.key]}・${sort.order === "asc" ? "昇順" : "降順"}`);
    focusApp();
  }

  const visibleLocalPanes = () => [left(), right()].filter((pane) => pane.state.path && !isRemotePath(pane.state.path));
  const [watchErrors, setWatchErrors] = createSignal<Record<string, string>>({});
  const autoRefresh = createAutoRefresh(visibleLocalPanes, () => loading() || restoring() || busy(), (path) => {
    flashStatus(`一覧を自動更新できませんでした: ${path}`);
  });
  let watchGeneration = 0;
  let watchKey: string | null = null;
  let watchQueue: Promise<unknown> = Promise.resolve();
  const [watchRetry, setWatchRetry] = createSignal(0);
  let watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchRetryAt = 0;
  let watchRetryDelay = 1000;
  function retryWatch(delay = watchRetryDelay) {
    const retryAt = Date.now() + delay;
    if (watchRetryTimer && watchRetryAt <= retryAt) return;
    clearTimeout(watchRetryTimer);
    watchRetryAt = retryAt;
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = undefined;
      watchKey = null;
      setWatchRetry((n) => n + 1);
    }, delay);
  }
  const directoryListener = listen<{ generation: number; paths: string[] }>("directory-changed", ({ payload }) => {
    if (payload.generation === watchGeneration) {
      autoRefresh.request(payload.paths);
      if (payload.paths.some((path) => watchErrors()[path])) retryWatch(500);
    }
  });
  createEffect(() => {
    watchRetry();
    if (loading() || restoring()) return;
    const paths = [...new Set(visibleLocalPanes().map((pane) => pane.state.path))];
    autoRefresh.request(paths);
    const key = paths.join("\0");
    if (key === watchKey) return;
    watchKey = key;
    const generation = ++watchGeneration;
    watchQueue = watchQueue.catch(() => {}).then(async () => {
      await directoryListener;
      if (generation !== watchGeneration) return;
      const statuses = await invoke<{ path: string; error: string | null }[]>("watch_directories", { generation, paths });
      if (generation !== watchGeneration) return;
      setWatchErrors(Object.fromEntries(statuses.filter((status) => status.error).map((status) => [status.path, status.error!])));
      if (statuses.some((status) => status.error)) {
        retryWatch(); watchRetryDelay = Math.min(30000, watchRetryDelay * 2);
      } else { watchRetryDelay = 1000; clearTimeout(watchRetryTimer); watchRetryTimer = undefined; }
      autoRefresh.request(paths);
    }).catch((e) => {
      if (generation === watchGeneration) {
        setWatchErrors(Object.fromEntries(paths.map((path) => [path, String(e)])));
        retryWatch(); watchRetryDelay = Math.min(30000, watchRetryDelay * 2);
      }
    });
  });
  onCleanup(() => {
    autoRefresh.dispose();
    clearTimeout(watchRetryTimer);
    const generation = ++watchGeneration;
    void directoryListener.then((unlisten) => unlisten());
    void watchQueue.finally(() => invoke("watch_directories", { generation, paths: [] }).catch(() => {}));
  });

  // --- Mouse callbacks ---

  function paneCallbacks(pane: PaneActions, side: Side) {
    return {
      onClick: (index: number, e: MouseEvent) => {
        setActiveSide(side);
        if (e.ctrlKey || e.metaKey) {
          const selected = [...pane.state.selectedIndices];
          const pos = selected.indexOf(index);
          if (pos >= 0) selected.splice(pos, 1);
          else selected.push(index);
          pane.setState("selectedIndices", selected);
        } else {
          pane.setState("selectedIndices", []);
        }
        pane.setState("cursorIndex", index);
      },
      onDoubleClick: async (index: number) => {
        setActiveSide(side);
        pane.setState("cursorIndex", index);
        const file = pane.state.files[index];
        try {
          if (file?.is_dir) {
            if (file.name === "..") {
              const parent = parentPath(pane.state.path);
              if (parent !== pane.state.path) await pane.navigateTo(parent);
            } else {
              await pane.navigateTo(joinPath(pane.state.path, file.name));
            }
          }
        } catch (e) { flashStatus(`移動エラー: ${e}`); }
      },
      onContextMenu: (index: number, x: number, y: number) => {
        setActiveSide(side);
        pane.setState("cursorIndex", index);
        const menuW = 260;
        const menuH = 420;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH;
        setContextMenu({ x, y });
      },
      onActivate: () => setActiveSide(side),
    };
  }

  // --- Tab management ---

  function switchToTab(index: number) {
    workspace.switchTo(index);
    resetSearch();
    setSearchDisplay("");
    void ensureTabLoaded();
    focusApp();
  }

  async function createNewTab() {
    if (workspace.tabs().length >= 64) { flashStatus("タブは64個まで開けます"); return; }
    try {
      const home = await invoke<string>("home_dir");
      if (workspace.tabs().length >= 64) { flashStatus("タブは64個まで開けます"); return; }
      const tab = workspace.add();
      tab.left.setState("path", home);
      tab.right.setState("path", home);
      await Promise.all([tab.left.navigateTo(home, false), tab.right.navigateTo(home, false)]);
    } catch (e) {
      flashStatus(`タブを開けませんでした: ${e}`);
    }
    focusApp();
  }

  function closeTabByIndex(index: number) {
    workspace.close(index);
    void ensureTabLoaded();
    focusApp();
  }

  async function ensureTabLoaded() {
    const tab = workspace.current();
    const panes = [tab.left, tab.right].filter((pane) => pane.state.path && !pane.loading() && pane.state.files.length === 0);
    const results = await Promise.allSettled(panes.map((pane) => pane.navigateTo(pane.state.path, false)));
    if (results.some((result) => result.status === "rejected")) flashStatus("開けない場所があります。接続・パスを確認して再読み込みしてください。");
  }

  async function restoreWorkspace(snapshot: WorkspaceSnapshot) {
    if (busy()) { flashStatus("ファイル処理の完了後に作業セットを開いてください"); return; }
    setRestoring(true);
    clearTimeout(sessionTimer);
    try {
      workspace.restore(snapshot);
      await ensureTabLoaded();
    } finally { setRestoring(false); focusApp(); }
  }

  async function saveWorkspace() {
    const snapshot = workspace.snapshot();
    if (!snapshot) { flashStatus("場所の読み込みが終わってから保存してください"); return; }
    try {
      await queueWorkspaceCommand("workspace_load", {});
      workspaceLoaded = true;
    } catch (e) { flashStatus(`既存の作業セットを確認できないため保存できません: ${e}`); return; }
    const entered = await askInput("作業セットを保存", "この左右の場所とタブ構成の名前:", "", false, "保存");
    const name = entered?.trim();
    if (!name) return;
    if (workspaceData().workspaces.some((saved) => saved.name === name) &&
        !await askConfirm("作業セットを上書き", `「${name}」を現在の構成で置き換えますか？`)) return;
    try {
      await queueWorkspaceCommand("workspace_save_named", { name, snapshot });
      setSessionReady(true);
      flashStatus(`作業セット「${name}」を保存しました`);
    } catch (e) { flashStatus(`作業セットを保存できませんでした: ${e}`); }
  }

  async function openWorkspaces() {
    try {
      await queueWorkspaceCommand("workspace_load", {});
      workspaceLoaded = true;
      setShowWorkspaces(true);
    } catch (e) { flashStatus(`作業セットを読み込めませんでした: ${e}`); }
  }

  async function removeWorkspace(name: string) {
    setShowWorkspaces(false);
    if (await askConfirm("作業セットを削除", `保存した「${name}」を削除しますか？\nフォルダやファイルは削除されません。`)) {
      try { await queueWorkspaceCommand("workspace_remove", { name }); }
      catch (e) { flashStatus(`作業セットを削除できませんでした: ${e}`); }
    }
    setShowWorkspaces(true);
  }

  async function refreshServers() {
    try {
      setConnectedServers(await invoke<ConnectedServer[]>("ssh_list_connections"));
    } catch {
      setConnectedServers([]);
    }
  }

  async function handleMenuAction(id: string) {
    const commandMap: Record<string, Command> = {
      workspace_save: "workspace_save",
      workspace_list: "workspace_list",
      filter: "filter",
      sort: "sort",
      sort_name: "sort_name",
      sort_extension: "sort_extension",
      sort_size: "sort_size",
      sort_modified: "sort_modified",
      sort_reverse: "sort_reverse",
      new_folder: "new_folder",
      copy: "copy",
      move: "move",
      rename: "rename",
      delete: "delete",
      refresh: "refresh",
      back: "history_back",
      forward: "history_forward",
      parent_dir: "parent_dir",
      switch_pane: "switch_pane",
      bookmark_add: "bookmark_add",
      bookmark_list: "bookmark_list",
      tab_new: "tab_new",
      tab_close: "tab_close",
      open_file: "open_file",
      open_editor: "open_in_editor",
      copy_to_other: "copy_to_other",
      move_to_other: "move_to_other",
      drive_list: "drive_list",
    };

    if (id === "settings") {
      setShowSettings(true);
    } else if (id === "about") {
      setDialog({
        type: "message",
        title: "kuf について",
        message: `kuf - 2ペイン ファイルマネージャ\nVersion ${await getVersion()}`,
        onOk: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
    } else if (id === "toggle_hidden") {
      const s = settings();
      if (s) {
        const updated = {
          ...s,
          display: { ...s.display, show_hidden: !s.display.show_hidden },
        };
        saveSettings(updated);
        void refreshPanes([left(), right()]);
      }
    } else if (id === "ssh_connect") {
      setShowConnect(true);
    } else if (id === "ssh_disconnect") {
      executeCommand("ssh_disconnect");
    } else if (id === "drive_list") {
      setShowDrives(true);
    } else if (id.startsWith("ssh_server:")) {
      const parts = id.split(":");
      const alias = parts[1];
      const port = parseInt(parts[2]) || 22;
      try {
        const connections = await invoke<ConnectedServer[]>("ssh_list_connections");
        const server = connections.find((c) => c.alias === alias && c.port === port);
        if (server) {
          getActive().navigateTo(buildRemotePath(server.alias, server.user, server.port, "/"));
        }
      } catch (e) {
        flashStatus(`Menu navigate error: ${e}`);
      }
    } else if (id === "quit") {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } else {
      const cmd = commandMap[id];
      if (cmd) executeCommand(cmd);
    }
  }

  onMount(() => {
    const progressListener = listen<{ id: string; completed: number; total: number }>(
      "file-operation-progress", ({ payload }) => {
        setOperation((current) => current?.id === payload.id ? { ...current, ...payload } : current);
      },
    );
    onCleanup(() => { void progressListener.then((unlisten) => unlisten()); });
    const menuListener = listen<string>("menu-event", ({ payload }) => { void handleMenuAction(payload); });
    onCleanup(() => { void menuListener.then((unlisten) => unlisten()); });
    const onWindowFocus = () => {
      autoRefresh.request(visibleLocalPanes().map((pane) => pane.state.path));
      if (Object.keys(watchErrors()).length) retryWatch(100);
      if (
        dialog() ||
        showViewer() ||
        showSettings() ||
        showBookmarks() ||
        showConnect() ||
        showDrives() ||
        showWorkspaces() ||
        sortTarget() ||
        contextMenu()
      ) {
        return;
      }
      if (isTypingTarget(document.activeElement)) return;
      focusApp();
    };
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("keydown", handleKeyDown);
    });
    const closeListener = (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const currentWindow = getCurrentWindow();
      let closing = false;
      return currentWindow.onCloseRequested((event) => {
        event.preventDefault();
        if (busy()) { flashStatus("ファイル処理が終わってから終了してください"); return; }
        if (closing) return;
        closing = true;
        clearTimeout(sessionTimer);
        void (async () => {
          try {
            const snapshot = workspace.snapshot();
            if (!loading() && workspaceLoaded && snapshot) await persistSession(snapshot);
            await currentWindow.destroy();
          } catch (e) {
            closing = false;
            setDialog({ type: "confirm", title: "状態を保存できませんでした",
              message: `${e}\n\n前回の状態を保存せずに終了しますか？`, okLabel: "保存せず終了",
              onOk: () => {
                setDialog(null);
                void currentWindow.destroy().catch((error) => flashStatus(`終了できませんでした: ${error}`));
              },
              onCancel: () => setDialog(null),
            });
          }
        })();
      });
    })();
    onCleanup(() => { clearTimeout(sessionTimer); void closeListener.then((unlisten) => unlisten()); });

    void (async () => {
      try {
        const s = await loadSettings();
        if (s) applySettingsToDOM(s);

        const home = await invoke<string>("home_dir");
        const leftDir = s?.navigation.left_dir || home;
        const rightDir = s?.navigation.right_dir || home;
        let saved: WorkspaceData | null = null;
        try { saved = await invoke<WorkspaceData>("workspace_load"); setWorkspaceData(saved); workspaceLoaded = true; }
        catch (e) { flashStatus(`作業セットを読み込めませんでした。既存の保存内容は保持されています: ${e}`); }
        await restoreWorkspace(saved?.last_session && s?.navigation.restore_session !== false ? saved.last_session : {
          tabs: [{ left_path: leftDir, right_path: rightDir, active_side: "left" }], active_index: 0,
        });
        setSessionReady(saved !== null);
        setLoading(false);
        focusApp();
        await refreshServers();
      } catch (e) {
        setInitError(String(e));
        setLoading(false);
      }

    })();
  });

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(statusTimer));
  function flashStatus(msg: string) {
    clearTimeout(statusTimer);
    setStatusMessage(msg);
    statusTimer = setTimeout(() => setStatusMessage(""), 5000);
  }

  function visibleRowCount(): number {
    return Math.max(1, Math.floor((window.innerHeight - 90) / rowHeight()) - 2);
  }

  function askConfirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      setDialog({
        type: "confirm",
        title,
        message,
        onOk: () => {
          setDialog(null);
          resolve(true);
        },
        onCancel: () => {
          setDialog(null);
          resolve(false);
        },
      });
    });
  }

  function askInput(
    title: string,
    message: string,
    defaultValue: string,
    selectStem = false,
    okLabel = "OK"
  ): Promise<string | null> {
    return new Promise((resolve) => {
      setDialog({
        type: "input",
        title,
        message,
        defaultValue,
        selectStem,
        okLabel,
        onOk: (value?: string) => {
          setDialog(null);
          const trimmed = (value ?? "").trim();
          resolve(trimmed ? trimmed : null);
        },
        onCancel: () => {
          setDialog(null);
          resolve(null);
        },
      });
    });
  }

  async function collectConflicts(
    paths: string[],
    destDir: string,
    destNames?: string[]
  ): Promise<string[]> {
    if (isRemotePath(destDir)) {
      const parsed = parseRemotePath(destDir);
      if (!parsed) return [];
      const conflicts: string[] = [];
      for (let i = 0; i < paths.length; i++) {
        const name = destNames?.[i] ?? baseName(paths[i]);
        const remoteItem = parsed.remotePath.endsWith("/")
          ? parsed.remotePath + name
          : `${parsed.remotePath}/${name}`;
        try {
          const exists = await invoke<boolean>("ssh_path_exists", {
            host: parsed.host,
            port: parsed.port,
            path: remoteItem,
          });
          if (exists) conflicts.push(name);
        } catch {
          // ignore missing connection / stat errors
        }
      }
      return conflicts;
    }
    const localSources = paths.map((p) => (isRemotePath(p) ? remotePathOnly(p) : p));
    return invoke<string[]>("check_conflicts", {
      sources: localSources,
      dest: destDir,
      destNames,
    });
  }

  async function refreshPanes(panes: PaneActions[]) {
    const results = await Promise.allSettled([...new Set(panes)].map((pane) => pane.refresh()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) flashStatus(`${failures.length} 個の一覧を更新できませんでした。再読み込みしてください。`);
  }

  async function runOp(label: string, fn: (id: string) => Promise<void>, locations: string[] = [], cancellable = false) {
    if (busy()) {
      flashStatus("Another operation is running");
      return false;
    }
    setBusy(true);
    const id = crypto.randomUUID();
    let started = false;
    const start = performance.now();
    setOperation({ id, label, elapsed: 0, completed: 0, total: 0, cancellable: false, cancelling: false });
    const timer = setInterval(() => {
      setOperation((current) => current?.id === id ? { ...current, elapsed: Math.floor((performance.now() - start) / 1000) } : current);
    }, 1000);
    try {
      await invoke("operation_begin", { id });
      started = true;
      setOperation((current) => current && { ...current, cancellable });
      await fn(id);
      return true;
    } catch (e) {
      setDialog({
        type: "message",
        title: operation()?.cancelling ? "処理結果" : "Error",
        message: String(e),
        onOk: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
      return false;
    } finally {
      clearInterval(timer);
      // Refresh all tabs showing affected locations, including after partial failure.
      const affected = workspace.tabs().flatMap((tab) => [tab.left, tab.right])
        .filter((pane) => locations.includes(pane.state.path));
      await refreshPanes(affected);
      if (started) {
        try { await invoke("operation_end", { id }); }
        catch (e) { flashStatus(`処理状態を終了できませんでした: ${e}`); }
      }
      setOperation(null);
      setBusy(false);
    }
  }

  async function cancelOperation() {
    const current = operation();
    if (!current?.cancellable || current.cancelling) return;
    try {
      await invoke("operation_cancel", { id: current.id });
      setOperation((op) => op?.id === current.id ? { ...op, cancelling: true } : op);
    } catch (e) { flashStatus(`停止を要求できませんでした: ${e}`); }
  }

  async function transferToOther(op: "copy" | "move", forceRename = false) {
    const active = getActive();
    const inactive = getInactive();
    const sourceDir = active.state.path;
    let paths = active.getSelectedPaths();
    if (forceRename) {
      const file = active.state.files[active.state.cursorIndex];
      if (!file || file.name === "..") return;
      paths = [joinPath(active.state.path, file.name)];
    }
    if (paths.length === 0) return;
    const dest = inactive.state.path;
    const srcRemote = isRemotePath(sourceDir);
    const dstRemote = isRemotePath(dest);
    if (srcRemote && dstRemote) {
      setDialog({
        type: "message",
        title: "未対応",
        message: "リモート同士のコピー / 移動はまだ未対応です。",
        onOk: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
      return;
    }

    const verb = op === "copy" ? "コピー" : "移動";
    let destNames: string[] | undefined;
    if (paths.length === 1 || forceRename) {
      const original = baseName(paths[0]);
      const file = active.state.files.find((f) => f.name === original);
      const selectStem = !!(
        settings()?.display.rename_without_extension &&
        file &&
        !file.is_dir &&
        file.extension
      );
      const name = await askInput(
        `${verb}先の名前`,
        `${verb}先:\n${dest}\n\n名前を変えて ${verb}できます。`,
        original,
        selectStem,
        verb
      );
      if (!name) return;
      destNames = [name];
    } else {
      const names = paths.map(baseName).slice(0, 8).join("\n");
      const extra = paths.length > 8 ? `\n...ほか ${paths.length - 8} 件` : "";
      const ok = await askConfirm(
        `相手窓へ${verb}`,
        `${paths.length} 件を次へ${verb}します。\n${dest}\n\n${names}${extra}\n\n名前を変える場合は 1 件だけ選んでください。`
      );
      if (!ok) return;
    }

    const conflicts = await collectConflicts(paths, dest, destNames);
    let overwrite = true;
    if (conflicts.length > 0) {
      const listed = conflicts.slice(0, 8).join("\n");
      const more = conflicts.length > 8 ? `\n...ほか ${conflicts.length - 8} 件` : "";
      overwrite = await askConfirm(
        "上書きしますか？",
        `先に ${conflicts.length} 件が存在します。上書きしますか？\n\n${listed}${more}`
      );
      if (!overwrite) return;
    }
    const succeeded = await runOp(`${verb}しています…`, async (operationId) => {
      if (srcRemote && !dstRemote) {
        const srcParsed = parseRemotePath(sourceDir);
        if (!srcParsed) return;
        const remotePaths = paths.map((p) => parseRemotePath(p)?.remotePath ?? p);
        await invoke(op === "copy" ? "ssh_copy_from_remote" : "ssh_move_from_remote", {
          remoteHost: srcParsed.host,
          remotePort: srcParsed.port,
          remotePaths,
          localPath: dest,
          overwrite,
          destNames,
          operationId,
        });
      } else if (!srcRemote && dstRemote) {
        const dstParsed = parseRemotePath(dest);
        if (!dstParsed) return;
        await invoke(op === "copy" ? "ssh_copy_to_remote" : "ssh_move_to_remote", {
          localPaths: paths,
          remoteHost: dstParsed.host,
          remotePort: dstParsed.port,
          remotePath: dstParsed.remotePath,
          overwrite,
          destNames,
          operationId,
        });
      } else {
        await invoke(op === "copy" ? "copy_items" : "move_items", {
          sources: paths,
          dest,
          overwrite,
          destNames,
          operationId,
        });
      }
      flashStatus(`${paths.length} 件を${verb}しました`);
    }, [sourceDir, dest], true);
    if (succeeded && destNames?.[0] && inactive.state.path === dest) inactive.setCursorToFile(destNames[0]);
  }

  function formatKey(e: KeyboardEvent): string {
    return formatKeyEvent(e);
  }

  function doIncrementalSearch(char: string) {
    const query = appendSearch(char);
    setSearchDisplay(query);
    const active = getActive();
    const files = active.state.files;
    const n = files.length;
    if (n === 0) return;
    const start = active.state.cursorIndex;
    const q = query.toLowerCase();

    const matchFrom = (from: number, pred: (name: string) => boolean): number => {
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n;
        if (pred(files[i].name.toLowerCase())) return i;
      }
      return -1;
    };

    let idx = matchFrom(start, (name) => name.startsWith(q));
    if (idx < 0) idx = matchFrom(start, (name) => name.includes(q));
    if (idx >= 0) active.setState("cursorIndex", idx);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      flashStatus("クリップボードへコピーできませんでした");
    }
  }

  async function executeCommand(command: Command) {
    const active = getActive();

    if (dialog()) return;
    if (restoring()) return;
    if (
      busy() &&
      (command === "copy_to_other" ||
        command === "move_to_other" ||
        command === "copy_as" ||
        command === "move_as" ||
        command === "delete" ||
        command === "rename" ||
        command === "new_folder" ||
        command === "new_file")
    ) {
      flashStatus("Another operation is running");
      return;
    }

    try {
      switch (command) {
        case "sort":
          setSortTarget(active);
          break;
        case "sort_name":
        case "sort_extension":
        case "sort_size":
        case "sort_modified":
          applySort(active, { key: command.slice(5) as SortKey, order: active.sort().order });
          break;
        case "sort_reverse":
          applySort(active, { ...active.sort(), order: active.sort().order === "asc" ? "desc" : "asc" });
          break;
        case "cursor_up":
          active.cursorUp();
          break;
        case "cursor_down":
          active.cursorDown();
          break;
        case "cursor_top":
          active.cursorTop();
          break;
        case "cursor_bottom":
          active.cursorBottom();
          break;
        case "cursor_page_up":
          active.cursorPageUp(visibleRowCount());
          break;
        case "cursor_page_down":
          active.cursorPageDown(visibleRowCount());
          break;
        case "enter": {
          const file = active.state.files[active.state.cursorIndex];
          if (file?.is_dir) {
            if (file.name === "..") {
              const parent = parentPath(active.state.path);
              if (parent !== active.state.path) {
                try {
                  await active.navigateTo(parent);
                } catch (e) {
                  flashStatus(`Navigate error: ${e}`);
                }
              }
            } else {
              try {
                await active.navigateTo(joinPath(active.state.path, file.name));
              } catch (e) {
                flashStatus(`Navigate error: ${e}`);
              }
            }
          } else if (file && file.name !== "..") {
            const fullPath = joinPath(active.state.path, file.name);
            try {
              await invoke("open_file", { path: fullPath });
            } catch (e) {
              flashStatus(`Open error: ${e}`);
            }
          }
          break;
        }
        case "parent_dir": {
          const parent = parentPath(active.state.path);
          if (parent !== active.state.path) {
            try {
              await active.navigateTo(parent);
            } catch (e) {
              flashStatus(`Navigate error: ${e}`);
            }
          }
          break;
        }
        case "go_root": {
          const root = rootPath(active.state.path);
          if (root !== active.state.path) {
            try {
              await active.navigateTo(root);
            } catch (e) {
              flashStatus(`Navigate error: ${e}`);
            }
          }
          break;
        }
        case "switch_pane":
          setActiveSide(activeSide() === "left" ? "right" : "left");
              focusApp();
          break;
        case "left_pane":
          setActiveSide("left");
              focusApp();
          break;
        case "right_pane":
          setActiveSide("right");
              focusApp();
          break;
        case "toggle_select":
          active.toggleSelect();
          break;
        case "select_all":
          active.selectAll();
          break;
        case "clear_selection":
          if (active.filterQuery() || active.filterOpen()) active.closeFilter();
          else active.clearSelection();
          resetSearch();
          setSearchDisplay("");
          break;
        case "filter":
          active.setFilterOpen(true);
          break;
        case "workspace_save": await saveWorkspace(); break;
        case "workspace_list": await openWorkspaces(); break;
        case "bookmark_add": {
          try {
            await invoke("bookmark_add", { path: active.state.path });
            flashStatus(`Bookmarked: ${active.state.path}`);
          } catch (e) {
            flashStatus(`Bookmark error: ${e}`);
          }
          break;
        }
        case "bookmark_list":
          setShowBookmarks(true);
          break;
        case "drive_list":
          setShowDrives(true);
          break;
        case "sync_to_other":
          await active.navigateTo(getInactive().state.path);
          break;
        case "sync_from_other":
          await getInactive().navigateTo(active.state.path);
          break;
        case "tab_new":
          await createNewTab();
          break;
        case "tab_close":
          closeTabByIndex(activeTabIndex());
          break;
        case "tab_next": {
          const next = (activeTabIndex() + 1) % tabs().length;
          switchToTab(next);
          break;
        }
        case "tab_prev": {
          const prev =
            (activeTabIndex() - 1 + tabs().length) % tabs().length;
          switchToTab(prev);
          break;
        }
        case "open_file": {
          const file = active.state.files[active.state.cursorIndex];
          if (file && file.name !== "..") {
            const fullPath = joinPath(active.state.path, file.name);
            try {
              await invoke("open_file", { path: fullPath });
            } catch (e) {
              flashStatus(`Open error: ${e}`);
            }
          }
          break;
        }
        case "preview": {
          const file = active.state.files[active.state.cursorIndex];
          if (!file) break;
          if (file.is_dir) {
            if (file.name === "..") {
              const parent = parentPath(active.state.path);
              if (parent !== active.state.path) {
                await active.navigateTo(parent);
              }
            } else {
              await active.navigateTo(joinPath(active.state.path, file.name));
            }
          } else if (file.name !== "..") {
            setShowViewer({
              path: joinPath(active.state.path, file.name),
              fileName: file.name,
              extension: file.extension,
            });
          }
          break;
        }
        case "open_in_editor": {
          const file = active.state.files[active.state.cursorIndex];
          if (file && file.name !== "..") {
            const fullPath = joinPath(active.state.path, file.name);
            const editor = settings()?.editor || "vim";
            try {
              await invoke("open_in_editor", { path: fullPath, editor });
            } catch (e) {
              flashStatus(`Editor error: ${e}`);
            }
          }
          break;
        }
        case "refresh":
          await active.refresh();
          flashStatus("Refreshed");
          break;
        case "history_back":
          await active.historyBack();
          break;
        case "history_forward":
          await active.historyForward();
          break;

        case "copy": {
          const paths = active.getSelectedPaths();
          if (paths.length === 0) break;
          setClipboard(active.state.path, paths, "copy");
          active.clearSelection();
          flashStatus(`Copy: ${paths.length} item(s)`);
          break;
        }
        case "move": {
          const paths = active.getSelectedPaths();
          if (paths.length === 0) break;
          setClipboard(active.state.path, paths, "move");
          active.clearSelection();
          flashStatus(`Move: ${paths.length} item(s)`);
          break;
        }
        case "copy_to_other":
          await transferToOther("copy");
          break;
        case "move_to_other":
          await transferToOther("move");
          break;
        case "copy_as":
          await transferToOther("copy", true);
          break;
        case "move_as":
          await transferToOther("move", true);
          break;
        case "delete": {
          const sourceDir = active.state.path;
          const paths = active.getSelectedPaths();
          if (paths.length === 0) break;
          const names = paths.map((p) => baseName(p)).join(", ");
          const isRemoteDel = isRemotePath(sourceDir);
          setDialog({
            type: "confirm",
            title: isRemoteDel ? "リモートを完全削除" : "ごみ箱へ移動",
            message: isRemoteDel
              ? `${paths.length} 件を完全削除しますか？\nリモートにはごみ箱がなく、復元できません。\n${names}`
              : `${paths.length} 件をごみ箱へ移動しますか？\n${names}`,
            onOk: async () => {
              setDialog(null);
              await runOp(isRemoteDel ? "完全削除しています…" : "ごみ箱へ移動しています…", async (operationId) => {
                if (isRemoteDel) {
                  const parsed = parseRemotePath(sourceDir);
                  if (parsed) {
                    const remotePaths = paths.map((p) => {
                      const pp = parseRemotePath(p);
                      return pp?.remotePath ?? p;
                    });
                    await invoke("ssh_delete_items", {
                      host: parsed.host,
                      port: parsed.port,
                      paths: remotePaths,
                      operationId,
                    });
                  }
                } else {
                  await invoke("trash_items", { paths, operationId });
                }
                flashStatus(isRemoteDel ? `${paths.length} 件を完全削除しました` : `${paths.length} 件をごみ箱へ移動しました`);
              }, [sourceDir], true);
            },
            onCancel: () => setDialog(null),
          });
          break;
        }
        case "rename": {
          const sourceDir = active.state.path;
          const file = active.state.files[active.state.cursorIndex];
          if (!file || file.name === "..") break;
          const isRemoteRename = isRemotePath(sourceDir);
          const noExt = settings()?.display.rename_without_extension && file.extension;
          const displayName = noExt
            ? file.name.slice(0, file.name.length - file.extension.length - 1)
            : file.name;
          const originalExt = noExt ? `.${file.extension}` : "";
          setDialog({
            type: "input",
            title: "Rename",
            message: `Rename: ${file.name}`,
            defaultValue: displayName,
            onOk: async (newName?: string) => {
              const fullName = newName + originalExt;
              if (!newName || fullName === file.name) {
                setDialog(null);
                return;
              }
              setDialog(null);
              const succeeded = await runOp("名前を変更しています…", async () => {
                if (isRemoteRename) {
                  const parsed = parseRemotePath(sourceDir);
                  if (parsed) {
                    const fullPath = parsed.remotePath + "/" + file.name;
                    await invoke("ssh_rename_item", {
                      host: parsed.host,
                      port: parsed.port,
                      path: fullPath,
                      newName: fullName,
                    });
                  }
                } else {
                  const fullPath = joinPath(sourceDir, file.name);
                  await invoke("rename_item", { path: fullPath, newName: fullName });
                }
                flashStatus(`Renamed to ${fullName}`);
              }, [sourceDir]);
              if (succeeded && active.state.path === sourceDir) active.setCursorToFile(fullName);
            },
            onCancel: () => setDialog(null),
          });
          break;
        }
        case "new_folder": {
          const sourceDir = active.state.path;
          const isRemote = isRemotePath(sourceDir);
          setDialog({
            type: "input",
            title: "New Folder",
            message: "Folder name:",
            defaultValue: "",
            onOk: async (name?: string) => {
              if (!name) {
                setDialog(null);
                return;
              }
              setDialog(null);
              const succeeded = await runOp("フォルダを作成しています…", async () => {
                if (isRemote) {
                  const parsed = parseRemotePath(sourceDir);
                  if (parsed) {
                    await invoke("ssh_create_dir", {
                      host: parsed.host,
                      port: parsed.port,
                      path: parsed.remotePath,
                      name,
                    });
                  }
                } else {
                  await invoke("create_dir", { path: sourceDir, name });
                }
                flashStatus(`Created folder: ${name}`);
              }, [sourceDir]);
              if (succeeded && active.state.path === sourceDir) active.setCursorToFile(name);
            },
            onCancel: () => setDialog(null),
          });
          break;
        }
        case "new_file": {
          const sourceDir = active.state.path;
          const isRemote = isRemotePath(sourceDir);
          const name = await askInput("新規ファイル", "ファイル名:", "untitled.txt", true, "作成");
          if (!name) break;
          const created = await runOp("作成しています...", async () => {
            if (isRemote) {
              const parsed = parseRemotePath(sourceDir);
              if (!parsed) return;
              await invoke("ssh_create_file", {
                host: parsed.host,
                port: parsed.port,
                path: parsed.remotePath,
                name,
              });
            } else {
              await invoke("create_file", { path: sourceDir, name });
            }
            flashStatus(`作成: ${name}`);
          }, [sourceDir]);
          if (created && active.state.path === sourceDir) active.setCursorToFile(name);
          break;
        }
        case "goto_path": {
          const raw = await askInput("パスへ移動", "移動先のパス:", active.state.path, false, "移動");
          if (!raw) break;
          try {
            let target = raw;
            if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
              const home = await invoke<string>("home_dir");
              target = target === "~" ? home : joinPath(home, target.slice(2));
            }
            await active.navigateTo(target);
          } catch (e) {
            flashStatus(`移動エラー: ${e}`);
          }
          break;
        }
        case "go_home": {
          try {
            const home = await invoke<string>("home_dir");
            await active.navigateTo(home);
          } catch (e) {
            flashStatus(`移動エラー: ${e}`);
          }
          break;
        }
        case "copy_path": {
          const paths = active.getSelectedPaths();
          const text =
            paths.length > 0
              ? paths.join("\n")
              : active.state.path;
          await copyText(text);
          flashStatus("パスをコピーしました");
          break;
        }
        case "copy_name": {
          const file = active.state.files[active.state.cursorIndex];
          if (!file || file.name === "..") break;
          await copyText(file.name);
          flashStatus("名前をコピーしました");
          break;
        }
        case "invert_selection":
          active.invertSelection();
          break;
        case "select_same_ext": {
          const file = active.state.files[active.state.cursorIndex];
          if (!file || file.is_dir || !file.extension) {
            flashStatus("拡張子のあるファイルにカーソルを合わせてください");
            break;
          }
          active.selectByExtension(file.extension);
          flashStatus(`.${file.extension} を選択`);
          break;
        }
        case "swap_panes": {
          workspace.current().swap();
          flashStatus("左右を入れ替えました");
          break;
        }
        case "open_terminal": {
          const dir = isRemotePath(active.state.path)
            ? null
            : active.state.path;
          if (!dir) {
            flashStatus("ローカルフォルダでのみ使えます");
            break;
          }
          try {
            await invoke("open_terminal", { path: dir });
          } catch (e) {
            flashStatus(`ターミナル: ${e}`);
          }
          break;
        }
        case "ssh_connect":
          setShowConnect(true);
          break;
        case "ssh_disconnect": {
          const activePath = active.state.path;
          if (isRemotePath(activePath)) {
            const parsed = parseRemotePath(activePath);
            if (parsed) {
              try {
                await invoke("ssh_disconnect", { host: parsed.host, port: parsed.port });
                const home = await invoke<string>("home_dir");
                await active.navigateTo(home);
                flashStatus(`Disconnected from ${parsed.host}`);
                await refreshServers();
              } catch (e) {
                flashStatus(`Disconnect error: ${e}`);
              }
            }
          }
          break;
        }
      }
    } catch (e) { flashStatus(`操作エラー: ${e}`); }
  }

  async function handlePaste() {
    const clip = getClipboard();
    if (!clip) return;
    const active = getActive();
    if (clip.op === "move" && clip.sourcePath === active.state.path) {
      flashStatus("Cannot move to same directory");
      return;
    }
    if (isRemotePath(active.state.path) || clip.files.some((p) => isRemotePath(p))) {
      setDialog({
        type: "message",
        title: "Not supported",
        message: "Clipboard paste currently works for local paths only. Use F5/F6 to transfer with the other pane.",
        onOk: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
      return;
    }
    const verb = clip.op === "copy" ? "Copy" : "Move";
    const dest = active.state.path;
    const ok = await askConfirm(
      "Paste",
      `${verb} ${clip.files.length} item(s) to\n${dest}`
    );
    if (!ok) return;
    const conflicts = await collectConflicts(clip.files, dest);
    let overwrite = true;
    if (conflicts.length > 0) {
      overwrite = await askConfirm(
        "Overwrite?",
        `${conflicts.length} item(s) already exist. Overwrite?`
      );
      if (!overwrite) return;
    }
    await runOp(`${verb}ing...`, async (operationId) => {
      await invoke(clip.op === "copy" ? "copy_items" : "move_items", {
        sources: clip.files,
        dest,
        overwrite,
        operationId,
      });
      flashStatus(`${verb}d ${clip.files.length} item(s)`);
      if (clip.op === "move" && getClipboard() === clip) clearClipboard();
    }, [clip.sourcePath, dest], true);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.target instanceof HTMLElement && e.target.closest("button") && (e.key === "Enter" || e.key === " ")) return;
    if (isTypingTarget(e.target)) return;
    if (e.isComposing) return;
    if (loading() || initError()) return;
    if (hasDialogOverlay()) return;

    if (contextMenu()) {
      if (e.key === "Escape") {
        setContextMenu(null);
            focusApp();
      }
      return;
    }
    if (dialog()) return;
    if (showViewer()) {
      if (e.key === "Escape") {
        setShowViewer(null);
            focusApp();
      }
      return;
    }
    if (showSettings()) return;
    if (showBookmarks()) return;
    if (showConnect()) return;
    if (showDrives()) return;
    if (showWorkspaces()) return;
    if (sortTarget()) return;

    // Ctrl+, = open settings
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      setShowSettings(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "q" || e.key === "Q")) {
      e.preventDefault();
      handleMenuAction("quit");
      return;
    }

    const key = formatKey(e);
    const kb = keybinds();
    const command = kb[key] as Command | undefined;

    if (command) {
      e.preventDefault();
      e.stopPropagation();
      executeCommand(command);
      return;
    }

    // Ctrl+V = paste
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      e.preventDefault();
      handlePaste();
      return;
    }

    // Incremental search: single printable character (no modifiers except Shift)
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      doIncrementalSearch(e.key);
    }
  }

  return (
    <div
      class="app"
      tabindex="-1"
      onMouseDown={(e) => {
        if (isTypingTarget(e.target)) return;
        if ((e.target as HTMLElement).closest?.(".dialog-overlay")) return;
            focusApp();
      }}
    >
      <Show when={loading()}>
        <div class="loading">Loading...</div>
      </Show>
      <Show when={initError()}>
        <div class="error">{initError()}</div>
      </Show>
      <Show when={!loading() && !initError()}>
        <MenuBar servers={connectedServers()} sort={getActive().sort()} onAction={handleMenuAction} />
        <TabBar
          tabs={tabs()}
          activeIndex={activeTabIndex()}
          onSwitch={switchToTab}
          onClose={closeTabByIndex}
          onNew={createNewTab}
        />
        <div class="panes">
          <Pane
            side="left"
            sort={left().sort()}
            onSort={() => { setActiveSide("left"); setSortTarget(left()); }}
            state={left().state}
            loading={left().loading()}
            loadError={left().loadError()}
            watchError={watchErrors()[left().state.path]}
            filterOpen={left().filterOpen()}
            filterQuery={left().filterQuery()}
            filterMode={left().filterMode()}
            filterHighlights={left().filterHighlights()}
            onFilterModeChange={(mode) => left().setFilterMode(mode)}
            totalCount={left().totalCount()}
            onFilterChange={(query) => left().setFilter(query)}
            onFilterClose={() => left().closeFilter()}
            onFilterFocus={() => left().setFilterOpen(true)}
            onFilterCommit={() => left().setFilterOpen(false)}
            isActive={activeSide() === "left"}
            {...paneCallbacks(left(), "left")}
          />
          <Pane
            side="right"
            sort={right().sort()}
            onSort={() => { setActiveSide("right"); setSortTarget(right()); }}
            state={right().state}
            loading={right().loading()}
            loadError={right().loadError()}
            watchError={watchErrors()[right().state.path]}
            filterOpen={right().filterOpen()}
            filterQuery={right().filterQuery()}
            filterMode={right().filterMode()}
            filterHighlights={right().filterHighlights()}
            onFilterModeChange={(mode) => right().setFilterMode(mode)}
            totalCount={right().totalCount()}
            onFilterChange={(query) => right().setFilter(query)}
            onFilterClose={() => right().closeFilter()}
            onFilterFocus={() => right().setFilterOpen(true)}
            onFilterCommit={() => right().setFilterOpen(false)}
            isActive={activeSide() === "right"}
            {...paneCallbacks(right(), "right")}
          />
        </div>
        <Show when={operation()}>
          {(op) => (
            <div class="operation-bar" role="status" aria-live="polite">
              <span>{op().label}</span>
              <Show when={op().total > 0}>
                <progress value={op().completed} max={op().total} aria-label="処理済み項目" />
                <span>{op().completed} / {op().total} 件</span>
              </Show>
              <span>{op().elapsed}秒</span>
              <Show when={op().cancellable}>
                <button disabled={op().cancelling} onClick={cancelOperation}>
                  {op().cancelling ? "現在の項目の完了後に停止します" : "この項目の後で停止"}
                </button>
              </Show>
            </div>
          )}
        </Show>
        <StatusBar
          leftState={left().state}
          rightState={right().state}
          activeSide={activeSide()}
          statusMessage={busy() ? statusMessage() || "Working..." : statusMessage()}
          searchQuery={searchDisplay()}
        />
      </Show>
      <Show when={dialog()}>
        <Dialog {...dialog()!} />
      </Show>
      <Show when={showSettings()}>
        <SettingsDialog
          onClose={() => {
            setShowSettings(false);
            focusApp();
          }}
          onApply={() => {
            const s = settings();
            if (s) applySettingsToDOM(s);
          }}
        />
      </Show>
      <Show when={showBookmarks()}>
        <BookmarkDialog
          onClose={() => {
            setShowBookmarks(false);
            focusApp();
          }}
          onNavigate={async (path) => {
            await getActive().navigateTo(path);
          }}
          onRemove={async (path) => {
            try {
              await invoke("bookmark_remove", { path });
            } catch (e) {
              console.error("Failed to remove bookmark:", e);
            }
          }}
        />
      </Show>
      <Show when={showWorkspaces()}>
        <WorkspaceDialog
          workspaces={workspaceData().workspaces}
          onClose={() => { setShowWorkspaces(false); focusApp(); }}
          onRestore={(snapshot) => { setShowWorkspaces(false); void restoreWorkspace(snapshot); }}
          onRemove={(name) => { void removeWorkspace(name); }}
        />
      </Show>
      <Show when={sortTarget()}>
        {(pane) => <SortDialog value={pane().sort()} onApply={(sort) => applySort(pane(), sort)} onClose={() => setSortTarget(null)} />}
      </Show>
      <Show when={showConnect()}>
        <ConnectDialog
          onClose={() => {
            setShowConnect(false);
            void refreshServers();
            focusApp();
          }}
          onConnected={(host, user, port, path) => {
            const remotePath = buildRemotePath(host, user, port, path);
            getActive().navigateTo(remotePath);
            void refreshServers();
          }}
        />
      </Show>
      <Show when={showDrives()}>
        <DriveDialog
          onClose={() => {
            setShowDrives(false);
            focusApp();
          }}
          onNavigate={async (path) => {
            await getActive().navigateTo(path);
          }}
        />
      </Show>
      <Show when={showViewer()}>
        <FileViewer
          path={showViewer()!.path}
          fileName={showViewer()!.fileName}
          extension={showViewer()!.extension}
          onClose={() => {
            setShowViewer(null);
            focusApp();
          }}
        />
      </Show>
      <Show when={contextMenu()}>
        <div
          class="context-overlay"
          onClick={() => {
            setContextMenu(null);
            focusApp();
          }}
        />
        <div
          class="context-menu"
          style={{
            left: `${contextMenu()!.x}px`,
            top: `${contextMenu()!.y}px`,
          }}
        >
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("enter");
            }}
          >
            開く
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("preview");
            }}
          >
            プレビュー
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy");
            }}
          >
            クリップボードへコピー
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("move");
            }}
          >
            切り取り
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("delete");
            }}
          >
            削除
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("rename");
            }}
          >
            名前の変更
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("new_folder");
            }}
          >
            新しいフォルダ
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("new_file");
            }}
          >
            新しいファイル
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy_to_other");
            }}
          >
            相手窓へコピー
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy_as");
            }}
          >
            名前を付けてコピー...
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("move_to_other");
            }}
          >
            相手窓へ移動
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy_path");
            }}
          >
            パスをコピー
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              setShowConnect(true);
            }}
          >
            サーバーに接続...
          </div>
        </div>
      </Show>
    </div>
  );
}

export default App;
