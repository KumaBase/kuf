import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Pane from "./components/Pane";
import StatusBar from "./components/StatusBar";
import Dialog from "./components/Dialog";
import SettingsDialog from "./components/SettingsDialog";
import BookmarkDialog from "./components/BookmarkDialog";
import TabBar from "./components/TabBar";
import FileViewer from "./components/FileViewer";
import ConnectDialog from "./components/ConnectDialog";
import {
  createPaneState,
  keybinds,
  loadSettings,
  applySettingsToDOM,
  settings,
  saveSettings,
  saveKeybinds,
  getClipboard,
  setClipboard,
  clearClipboard,
  getSearchQuery,
  resetSearch,
  appendSearch,
  showHidden,
  type PaneActions,
} from "./state";
import type { Command, Side, AppSettings, FileInfo, TabSnapshot } from "./types";
import { joinPath, parentPath, isRemotePath, parseRemotePath, buildRemotePath, remotePathHost } from "./types";

function App() {
  const left = createPaneState();
  const right = createPaneState();

  const [activeSide, setActiveSide] = createSignal<Side>("left");
  const [loading, setLoading] = createSignal(true);
  const [initError, setInitError] = createSignal("");
  const [dialog, setDialog] = createSignal<null | {
    type: "confirm" | "input" | "message";
    title: string;
    message: string;
    defaultValue?: string;
    onOk: (value?: string) => void;
    onCancel: () => void;
  }>(null);
  const [statusMessage, setStatusMessage] = createSignal("");
  const [searchDisplay, setSearchDisplay] = createSignal("");
  const [showSettings, setShowSettings] = createSignal(false);
  const [showBookmarks, setShowBookmarks] = createSignal(false);
  const [showConnect, setShowConnect] = createSignal(false);
  const [showViewer, setShowViewer] = createSignal<{
    path: string;
    fileName: string;
    extension: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
  } | null>(null);
  const [tabs, setTabs] = createSignal<TabSnapshot[]>([]);
  const [activeTabIndex, setActiveTabIndex] = createSignal(0);

  const getActive = (): PaneActions =>
    activeSide() === "left" ? left : right;
  const getInactive = (): PaneActions =>
    activeSide() === "left" ? right : left;

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
        if (file?.is_dir) {
          if (file.name === "..") {
            const parent = parentPath(pane.state.path);
            if (parent !== pane.state.path) await pane.navigateTo(parent);
          } else {
            await pane.navigateTo(joinPath(pane.state.path, file.name));
          }
        }
      },
      onContextMenu: (index: number, x: number, y: number) => {
        setActiveSide(side);
        pane.setState("cursorIndex", index);
        const menuW = 170;
        const menuH = 280;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH;
        setContextMenu({ x, y });
      },
      onActivate: () => setActiveSide(side),
    };
  }

  // --- Tab management ---

  function saveCurrentTab() {
    const idx = activeTabIndex();
    const currentTabs = tabs();
    if (idx >= currentTabs.length) return;
    const snapshot: TabSnapshot = {
      id: currentTabs[idx].id,
      left: JSON.parse(JSON.stringify(left.state)),
      right: JSON.parse(JSON.stringify(right.state)),
      activeSide: activeSide(),
    };
    setTabs((prev) => {
      const next = [...prev];
      next[idx] = snapshot;
      return next;
    });
  }

  function loadTab(idx: number) {
    const tab = tabs()[idx];
    if (!tab) return;
    left.setState(JSON.parse(JSON.stringify(tab.left)));
    right.setState(JSON.parse(JSON.stringify(tab.right)));
    setActiveSide(tab.activeSide);
    setActiveTabIndex(idx);
  }

  function switchToTab(index: number) {
    if (index === activeTabIndex()) return;
    saveCurrentTab();
    loadTab(index);
  }

  async function createNewTab() {
    saveCurrentTab();
    const home = await invoke<string>("home_dir");
    let leftFiles = await invoke<FileInfo[]>("read_dir", { path: home });
    if (!showHidden()) leftFiles = leftFiles.filter((f) => !f.is_hidden);
    let rightFiles = await invoke<FileInfo[]>("read_dir", { path: home });
    if (!showHidden()) rightFiles = rightFiles.filter((f) => !f.is_hidden);
    const newTab: TabSnapshot = {
      id: crypto.randomUUID(),
      left: {
        path: home,
        files: leftFiles,
        cursorIndex: 0,
        selectedIndices: [],
        history: [],
        historyIndex: -1,
      },
      right: {
        path: home,
        files: rightFiles,
        cursorIndex: 0,
        selectedIndices: [],
        history: [],
        historyIndex: -1,
      },
      activeSide: "left",
    };
    const newIdx = tabs().length;
    setTabs((prev) => [...prev, newTab]);
    loadTab(newIdx);
  }

  function closeTabByIndex(index: number) {
    if (tabs().length <= 1) return;
    const currentIdx = activeTabIndex();
    if (index === currentIdx) {
      const newTabs = [...tabs()];
      newTabs.splice(index, 1);
      const newIdx = Math.min(index, newTabs.length - 1);
      setTabs(newTabs);
      loadTab(newIdx);
    } else {
      const newTabs = [...tabs()];
      newTabs.splice(index, 1);
      setTabs(newTabs);
      if (currentIdx > index) {
        setActiveTabIndex(currentIdx - 1);
      }
    }
  }

  onMount(async () => {
    try {
      const s = await loadSettings();
      if (s) applySettingsToDOM(s);

      const home = await invoke<string>("home_dir");
      const leftDir = s?.navigation.left_dir || home;
      const rightDir = s?.navigation.right_dir || home;
      await Promise.all([
        left.navigateTo(leftDir, false),
        right.navigateTo(rightDir, false),
      ]);
      setTabs([
        {
          id: crypto.randomUUID(),
          left: JSON.parse(JSON.stringify(left.state)),
          right: JSON.parse(JSON.stringify(right.state)),
          activeSide: activeSide(),
        },
      ]);
      setLoading(false);
    } catch (e) {
      setInitError(String(e));
      setLoading(false);
    }

    listen<string>("menu-event", (event) => {
      const id = event.payload;
      const commandMap: Record<string, Command> = {
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
      };

      if (id === "settings") {
        setShowSettings(true);
      } else if (id === "about") {
        setDialog({
          type: "message",
          title: "About kuf",
          message: "kuf - Dual-pane File Manager\nVersion 0.1.0",
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
          left.refresh();
          right.refresh();
        }
      } else if (id === "ssh_connect") {
        setShowConnect(true);
      } else if (id === "ssh_disconnect") {
        executeCommand("ssh_disconnect");
      } else if (id === "quit") {
        // Handled by OS on macOS
      } else {
        const cmd = commandMap[id];
        if (cmd) executeCommand(cmd);
      }
    });
  });

  function flashStatus(msg: string) {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(""), 3000);
  }

  function formatKey(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(e.key);
    return parts.join("+");
  }

  function doIncrementalSearch(char: string) {
    const query = appendSearch(char);
    setSearchDisplay(query);
    const active = getActive();
    const files = active.state.files;

    // Find first file starting with query
    for (let i = 0; i < files.length; i++) {
      if (files[i].name.toLowerCase().startsWith(query)) {
        active.setState("cursorIndex", i);
        return;
      }
    }
    // If no exact prefix match, try contains
    for (let i = 0; i < files.length; i++) {
      if (files[i].name.toLowerCase().includes(query)) {
        active.setState("cursorIndex", i);
        return;
      }
    }
  }

  async function executeCommand(command: Command) {
    const active = getActive();
    const inactive = getInactive();

    if (dialog()) return;

    switch (command) {
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
      case "enter": {
        const file = active.state.files[active.state.cursorIndex];
        if (file?.is_dir) {
          if (file.name === "..") {
            const parent = parentPath(active.state.path);
            if (parent !== active.state.path) {
              await active.navigateTo(parent);
            }
          } else {
            await active.navigateTo(joinPath(active.state.path, file.name));
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
          await active.navigateTo(parent);
        }
        break;
      }
      case "switch_pane":
        setActiveSide(activeSide() === "left" ? "right" : "left");
        break;
      case "left_pane":
        setActiveSide("left");
        break;
      case "right_pane":
        setActiveSide("right");
        break;
      case "toggle_select":
        active.toggleSelect();
        break;
      case "select_all":
        active.selectAll();
        break;
      case "clear_selection":
        active.clearSelection();
        resetSearch();
        setSearchDisplay("");
        break;
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
        saveCurrentTab();
        const next = (activeTabIndex() + 1) % tabs().length;
        loadTab(next);
        break;
      }
      case "tab_prev": {
        saveCurrentTab();
        const prev =
          (activeTabIndex() - 1 + tabs().length) % tabs().length;
        loadTab(prev);
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
      case "copy_to_other": {
        const paths = active.getSelectedPaths();
        if (paths.length === 0) break;
        const srcRemote = isRemotePath(active.state.path);
        const dstRemote = isRemotePath(getInactive().state.path);
        try {
          if (srcRemote && !dstRemote) {
            // Remote -> Local
            const srcParsed = parseRemotePath(active.state.path);
            if (srcParsed) {
              const remotePaths = paths.map((p) => {
                const pp = parseRemotePath(p);
                return pp?.remotePath ?? p;
              });
              await invoke("ssh_copy_from_remote", {
                remoteHost: srcParsed.host,
                remotePort: srcParsed.port,
                remotePaths,
                localPath: parseRemotePath(getInactive().state.path)?.remotePath ?? getInactive().state.path,
              });
            }
          } else if (!srcRemote && dstRemote) {
            // Local -> Remote
            const dstParsed = parseRemotePath(getInactive().state.path);
            if (dstParsed) {
              await invoke("ssh_copy_to_remote", {
                localPaths: paths,
                remoteHost: dstParsed.host,
                remotePort: dstParsed.port,
                remotePath: dstParsed.remotePath,
              });
            }
          } else {
            await invoke("copy_items", {
              sources: paths,
              dest: getInactive().state.path,
            });
          }
          flashStatus(`Copied ${paths.length} item(s)`);
          await Promise.all([active.refresh(), getInactive().refresh()]);
        } catch (e) {
          setDialog({
            type: "message",
            title: "Error",
            message: String(e),
            onOk: () => setDialog(null),
            onCancel: () => setDialog(null),
          });
        }
        break;
      }
      case "move_to_other": {
        const paths = active.getSelectedPaths();
        if (paths.length === 0) break;
        const srcRemote = isRemotePath(active.state.path);
        const dstRemote = isRemotePath(getInactive().state.path);
        try {
          if (srcRemote && !dstRemote) {
            // Remote -> Local (move)
            const srcParsed = parseRemotePath(active.state.path);
            if (srcParsed) {
              const remotePaths = paths.map((p) => {
                const pp = parseRemotePath(p);
                return pp?.remotePath ?? p;
              });
              await invoke("ssh_move_from_remote", {
                remoteHost: srcParsed.host,
                remotePort: srcParsed.port,
                remotePaths,
                localPath: getInactive().state.path,
              });
            }
          } else if (!srcRemote && dstRemote) {
            // Local -> Remote (move)
            const dstParsed = parseRemotePath(getInactive().state.path);
            if (dstParsed) {
              await invoke("ssh_move_to_remote", {
                localPaths: paths,
                remoteHost: dstParsed.host,
                remotePort: dstParsed.port,
                remotePath: dstParsed.remotePath,
              });
            }
          } else {
            await invoke("move_items", {
              sources: paths,
              dest: getInactive().state.path,
            });
          }
          flashStatus(`Moved ${paths.length} item(s)`);
          await Promise.all([active.refresh(), getInactive().refresh()]);
        } catch (e) {
          setDialog({
            type: "message",
            title: "Error",
            message: String(e),
            onOk: () => setDialog(null),
            onCancel: () => setDialog(null),
          });
        }
        break;
      }
      case "delete": {
        const paths = active.getSelectedPaths();
        if (paths.length === 0) break;
        const names = paths.map((p) => p.split("/").pop()).join(", ");
        const isRemoteDel = isRemotePath(active.state.path);
        setDialog({
          type: "confirm",
          title: "Delete",
          message: `Delete ${paths.length} item(s)?\n${names}`,
          onOk: async () => {
            setDialog(null);
            try {
              if (isRemoteDel) {
                const parsed = parseRemotePath(active.state.path);
                if (parsed) {
                  const remotePaths = paths.map((p) => {
                    const pp = parseRemotePath(p);
                    return pp?.remotePath ?? p;
                  });
                  await invoke("ssh_delete_items", {
                    host: parsed.host,
                    port: parsed.port,
                    paths: remotePaths,
                  });
                }
              } else {
                await invoke("delete_items", { paths });
              }
              flashStatus(`Deleted ${paths.length} item(s)`);
              await active.refresh();
              active.clearSelection();
            } catch (e) {
              setDialog({
                type: "message",
                title: "Error",
                message: String(e),
                onOk: () => setDialog(null),
                onCancel: () => setDialog(null),
              });
            }
          },
          onCancel: () => setDialog(null),
        });
        break;
      }
      case "rename": {
        const file = active.state.files[active.state.cursorIndex];
        if (!file) break;
        const isRemoteRename = isRemotePath(active.state.path);
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
            try {
              if (isRemoteRename) {
                const parsed = parseRemotePath(active.state.path);
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
                const fullPath = joinPath(active.state.path, file.name);
                await invoke("rename_item", { path: fullPath, newName: fullName });
              }
              await active.refresh();
              flashStatus(`Renamed to ${fullName}`);
            } catch (e) {
              setDialog({
                type: "message",
                title: "Error",
                message: String(e),
                onOk: () => setDialog(null),
                onCancel: () => setDialog(null),
              });
            }
          },
          onCancel: () => setDialog(null),
        });
        break;
      }
      case "new_folder": {
        const isRemote = isRemotePath(active.state.path);
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
            try {
              if (isRemote) {
                const parsed = parseRemotePath(active.state.path);
                if (parsed) {
                  await invoke("ssh_create_dir", {
                    host: parsed.host,
                    port: parsed.port,
                    path: parsed.remotePath,
                    name,
                  });
                }
              } else {
                await invoke("create_dir", { path: active.state.path, name });
              }
              await active.refresh();
              flashStatus(`Created folder: ${name}`);
            } catch (e) {
              setDialog({
                type: "message",
                title: "Error",
                message: String(e),
                onOk: () => setDialog(null),
                onCancel: () => setDialog(null),
              });
            }
          },
          onCancel: () => setDialog(null),
        });
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
            } catch (e) {
              flashStatus(`Disconnect error: ${e}`);
            }
          }
        }
        break;
      }
    }
  }

  async function handlePaste() {
    const clip = getClipboard();
    if (!clip) return;
    const active = getActive();
    if (clip.op === "move" && clip.sourcePath === active.state.path) {
      flashStatus("Cannot move to same directory");
      return;
    }
    try {
      if (clip.op === "copy") {
        await invoke("copy_items", {
          sources: clip.files,
          dest: active.state.path,
        });
        flashStatus(`Copied ${clip.files.length} item(s)`);
      } else {
        await invoke("move_items", {
          sources: clip.files,
          dest: active.state.path,
        });
        flashStatus(`Moved ${clip.files.length} item(s)`);
        clearClipboard();
      }
      await active.refresh();
      active.clearSelection();
    } catch (e) {
      setDialog({
        type: "message",
        title: "Error",
        message: String(e),
        onOk: () => setDialog(null),
        onCancel: () => setDialog(null),
      });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (contextMenu()) {
      if (e.key === "Escape") setContextMenu(null);
      return;
    }
    if (dialog()) return;
    if (showViewer()) {
      if (e.key === "Escape") {
        setShowViewer(null);
      }
      return;
    }
    if (showSettings()) return;
    if (showBookmarks()) return;
    if (showConnect()) return;

    // Ctrl+, = open settings
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      setShowSettings(true);
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
    <div class="app" tabindex="0" onKeyDown={handleKeyDown}>
      <Show when={loading()}>
        <div class="loading">Loading...</div>
      </Show>
      <Show when={initError()}>
        <div class="error">{initError()}</div>
      </Show>
      <Show when={!loading() && !initError()}>
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
            state={left.state}
            isActive={activeSide() === "left"}
            {...paneCallbacks(left, "left")}
          />
          <Pane
            side="right"
            state={right.state}
            isActive={activeSide() === "right"}
            {...paneCallbacks(right, "right")}
          />
        </div>
        <StatusBar
          leftState={left.state}
          rightState={right.state}
          activeSide={activeSide()}
          statusMessage={statusMessage()}
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
            document.querySelector<HTMLElement>(".app")?.focus();
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
            document.querySelector<HTMLElement>(".app")?.focus();
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
      <Show when={showConnect()}>
        <ConnectDialog
          onClose={() => {
            setShowConnect(false);
            document.querySelector<HTMLElement>(".app")?.focus();
          }}
          onConnected={(host, user, port, path) => {
            const remotePath = buildRemotePath(host, user, port, path);
            getActive().navigateTo(remotePath);
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
            document.querySelector<HTMLElement>(".app")?.focus();
          }}
        />
      </Show>
      <Show when={contextMenu()}>
        <div
          class="context-overlay"
          onClick={() => setContextMenu(null)}
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
            Open
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("preview");
            }}
          >
            Preview
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy");
            }}
          >
            Copy
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("move");
            }}
          >
            Move
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("delete");
            }}
          >
            Delete
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("rename");
            }}
          >
            Rename
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("new_folder");
            }}
          >
            New Folder
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("copy_to_other");
            }}
          >
            Copy to Other
          </div>
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              executeCommand("move_to_other");
            }}
          >
            Move to Other
          </div>
          <div class="context-separator" />
          <div
            class="context-item"
            onClick={() => {
              setContextMenu(null);
              setShowConnect(true);
            }}
          >
            Connect to Server...
          </div>
        </div>
      </Show>
    </div>
  );
}

export default App;
