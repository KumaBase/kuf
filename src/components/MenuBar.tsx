import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import type { Command, ConnectedServer, SortSpec } from "../types";
import { SORT_LABELS } from "../commands";
import { keybinds } from "../state";

export type MenuAction = string;

interface MenuItemDef {
  label?: string;
  action?: MenuAction;
  shortcut?: string;
  sep?: boolean;
}

interface MenuDef {
  id: string;
  label: string;
  items: MenuItemDef[];
}

export default function MenuBar(props: {
  servers: ConnectedServer[];
  sort: SortSpec;
  onAction: (action: MenuAction) => void;
}) {
  const [open, setOpen] = createSignal<string | null>(null);

  function menus(): MenuDef[] {
    const shortcutFor = (command: Command) => Object.entries(keybinds()).find(([, value]) => value === command)?.[0];
    const remoteItems: MenuItemDef[] = [
      { label: "サーバーに接続...", action: "ssh_connect", shortcut: "Ctrl+S" },
      { label: "切断", action: "ssh_disconnect" },
    ];
    if (props.servers.length > 0) {
      remoteItems.push({ sep: true });
      for (const s of props.servers) {
        remoteItems.push({
          label: `${s.alias} (${s.user})`,
          action: `ssh_server:${s.alias}:${s.port}`,
        });
      }
    }

    return [
      {
        id: "file",
        label: "ファイル",
        items: [
          { label: "新しいタブ", action: "tab_new", shortcut: "Ctrl+T" },
          { label: "タブを閉じる", action: "tab_close", shortcut: "Ctrl+W" },
          { sep: true },
          { label: "開く", action: "open_file" },
          { label: "エディタで開く", action: "open_editor" },
          { sep: true },
          { label: "新しいフォルダ", action: "new_folder", shortcut: "F7" },
          { sep: true },
          { label: "相手窓へコピー", action: "copy_to_other", shortcut: "F5" },
          { label: "相手窓へ移動", action: "move_to_other", shortcut: "F6" },
          { label: "名前の変更", action: "rename", shortcut: "F2" },
          { label: "削除", action: "delete", shortcut: "Delete" },
          { sep: true },
          { label: "設定...", action: "settings", shortcut: "Ctrl+," },
          { sep: true },
          { label: "終了", action: "quit", shortcut: "Ctrl+Q" },
        ],
      },
      {
        id: "view",
        label: "表示",
        items: [
          { label: "一覧を絞り込む", action: "filter", shortcut: "/ / Ctrl+F" },
          { label: "最新の情報に更新", action: "refresh", shortcut: "Ctrl+R" },
          { label: "隠しファイルの表示切替", action: "toggle_hidden" },
          { sep: true },
          { label: "並び順（ソート）...", action: "sort", shortcut: shortcutFor("sort") },
          ...Object.entries(SORT_LABELS).map(([key, label]) => ({
            label: `${props.sort.key === key ? "✓ " : ""}${label}順`, action: `sort_${key}`,
            shortcut: shortcutFor(`sort_${key}` as Command),
          })),
          { label: props.sort.order === "asc" ? "降順にする" : "昇順にする", action: "sort_reverse", shortcut: shortcutFor("sort_reverse") },
        ],
      },
      {
        id: "go",
        label: "移動",
        items: [
          { label: "戻る", action: "back", shortcut: "Alt+←" },
          { label: "進む", action: "forward", shortcut: "Alt+→" },
          { label: "親フォルダ", action: "parent_dir", shortcut: "Backspace" },
          { label: "ペイン切替", action: "switch_pane", shortcut: "Tab" },
          { sep: true },
          { label: "ドライブ...", action: "drive_list", shortcut: "L" },
        ],
      },
      {
        id: "bookmarks",
        label: "ブックマーク",
        items: [
          { label: "追加", action: "bookmark_add", shortcut: "Ctrl+D" },
          { label: "一覧", action: "bookmark_list", shortcut: "J" },
        ],
      },
      {
        id: "workspaces",
        label: "作業セット",
        items: [
          { label: "現在の構成を保存...", action: "workspace_save" },
          { label: "保存した作業セット...", action: "workspace_list" },
        ],
      },
      {
        id: "remote",
        label: "リモート",
        items: remoteItems,
      },
      {
        id: "help",
        label: "ヘルプ",
        items: [{ label: "kuf について", action: "about" }],
      },
    ];
  }

  function close() {
    setOpen(null);
  }

  function choose(action: MenuAction) {
    close();
    props.onAction(action);
  }

  function onDocMouseDown(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".app-menubar")) return;
    close();
  }

  onMount(() => {
    document.addEventListener("mousedown", onDocMouseDown);
    onCleanup(() => document.removeEventListener("mousedown", onDocMouseDown));
  });

  return (
    <div class="app-menubar" onMouseDown={(e) => e.stopPropagation()}>
      <For each={menus()}>
        {(menu) => (
          <div class="app-menu">
            <button
              classList={{ "app-menu-title": true, open: open() === menu.id }}
              onClick={() => setOpen(open() === menu.id ? null : menu.id)}
              onMouseEnter={() => {
                if (open()) setOpen(menu.id);
              }}
            >
              {menu.label}
            </button>
            <Show when={open() === menu.id}>
              <div class="app-menu-dropdown">
                <For each={menu.items}>
                  {(item) =>
                    item.sep ? (
                      <div class="app-menu-sep" />
                    ) : (
                      <button
                        class="app-menu-item"
                        onClick={() => choose(item.action!)}
                      >
                        <span>{item.label}</span>
                        <Show when={item.shortcut}>
                          <span class="app-menu-shortcut">{item.shortcut}</span>
                        </Show>
                      </button>
                    )
                  }
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
