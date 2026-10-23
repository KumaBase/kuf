import { createSignal, For, Show, onMount, onCleanup, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../types";
import {
  settings,
  saveSettings,
  saveKeybinds,
  keybinds,
  DEFAULT_KEYBINDS,
  applySettingsToDOM,
} from "../state";
import { THEME_NAMES } from "../themes";
import { COMMAND_CATALOG, COMMAND_GROUPS, commandLabel, formatKeyEvent } from "../commands";
import { focusApp } from "../focus";

type Tab = "general" | "keymap";

export default function SettingsDialog(props: {
  onClose: () => void;
  onApply: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("general");
  const [dragCol, setDragCol] = createSignal<string | null>(null);
  let listRef!: HTMLDivElement;

  const COL_LABELS: Record<string, string> = { extension: "拡張子", size: "サイズ", date: "日付", permissions: "権限" };

  function moveColumn(fromId: string, toId: string) {
    const current = [...s().display.columns];
    const fromIdx = current.indexOf(fromId);
    const toIdx = current.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = current.splice(fromIdx, 1);
    current.splice(toIdx, 0, moved);
    setEditSettings({ ...s(), display: { ...s().display, columns: current } });
  }

  function handleDragPointerDown(e: PointerEvent, col: string) {
    if ((e.target as HTMLElement).closest(".column-remove")) return;
    e.preventDefault();
    setDragCol(col);
  }

  function handleDragPointerMove(e: PointerEvent) {
    const from = dragCol();
    if (!from || !listRef) return;
    const items = listRef.querySelectorAll(".column-item");
    let targetCol: string | null = null;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        targetCol = (item as HTMLElement).dataset.col ?? null;
        break;
      }
    }
    if (targetCol && targetCol !== from) {
      moveColumn(from, targetCol);
    }
  }

  function handleDragPointerUp() {
    setDragCol(null);
  }

  function removeColumn(col: string) {
    const current = [...s().display.columns];
    current.splice(current.indexOf(col), 1);
    setEditSettings({ ...s(), display: { ...s().display, columns: current } });
  }

  function addColumn(col: string) {
    setEditSettings({ ...s(), display: { ...s().display, columns: [...s().display.columns, col] } });
  }

  const initialSettings = settings();
  const [editSettings, setEditSettings] = createSignal<AppSettings>(
    initialSettings ?? {
      display: { font_size: 16, row_height: 29, show_hidden: true, theme: "tokyo-night", columns: ["extension", "size", "date", "permissions"], rename_without_extension: false },
      navigation: { left_dir: "", right_dir: "" },
      sort: { dirs_first: true, case_sensitive: false },
      editor: "vim",
      window: { mode: "remember", width: 1200, height: 800 },
    }
  );
  const [editKeybinds, setEditKeybinds] = createSignal<Record<string, string>>({
    ...keybinds(),
  });
  const [capturing, setCapturing] = createSignal<{
    command: string;
    replacing?: string;
  } | null>(null);
  const [keyQuery, setKeyQuery] = createSignal("");
  const [keyConflict, setKeyConflict] = createSignal("");
  let dialogRef!: HTMLDivElement;

  function handleSave() {
    saveSettings(editSettings());
    saveKeybinds(editKeybinds());
    props.onApply();
    props.onClose();
  }

  function handleCancel() {
    if (initialSettings) applySettingsToDOM(initialSettings);
    props.onClose();
  }

  function previewSettings(next: AppSettings) {
    setEditSettings(next);
    applySettingsToDOM(next);
  }

  async function browseEditor() {
    const path = await invoke<string | null>("pick_file", {
      title: "エディタを選択",
      filters: [
        { name: "プログラム", extensions: ["exe", "bat", "cmd", "com"] },
      ],
    });
    if (path) setEditSettings({ ...s(), editor: path });
  }

  async function browseFolder(side: "left" | "right") {
    const path = await invoke<string | null>("pick_folder", {
      title: side === "left" ? "左ペインの起動フォルダ" : "右ペインの起動フォルダ",
    });
    if (!path) return;
    setEditSettings({
      ...s(),
      navigation: {
        ...s().navigation,
        [side === "left" ? "left_dir" : "right_dir"]: path,
      },
    });
  }

  function keysForCommand(command: string): string[] {
    return Object.entries(editKeybinds())
      .filter(([, cmd]) => cmd === command)
      .map(([key]) => key);
  }

  function formatKeyForCapture(e: KeyboardEvent): string {
    return formatKeyEvent(e);
  }

  function assignKey(command: string, key: string, replacing?: string) {
    const kb = { ...editKeybinds() };
    const previous = kb[key];
    if (replacing) delete kb[replacing];
    kb[key] = command;
    setEditKeybinds(kb);
    if (previous && previous !== command) {
      setKeyConflict(`「${key}」は「${commandLabel(previous)}」から付け替えました`);
    } else {
      setKeyConflict("");
    }
  }

  function removeKey(key: string) {
    const kb = { ...editKeybinds() };
    delete kb[key];
    setEditKeybinds(kb);
  }

  function handleKeyCapture(e: KeyboardEvent) {
    const cap = capturing();
    if (!cap) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setCapturing(null);
      return;
    }
    if (e.key === "Backspace" && cap.replacing) {
      removeKey(cap.replacing);
      setCapturing(null);
      return;
    }

    const key = formatKeyForCapture(e);
    if (!key) return;
    assignKey(cap.command, key, cap.replacing);
    setCapturing(null);
  }

  const filteredCatalog = createMemo(() => {
    const q = keyQuery().trim().toLowerCase();
    if (!q) return COMMAND_CATALOG;
    return COMMAND_CATALOG.filter((c) => {
      const keys = keysForCommand(c.id).join(" ").toLowerCase();
      return (
        c.id.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        keys.includes(q)
      );
    });
  });

  function handleResetSettings() {
    invoke<AppSettings>("settings_reset").then((s) => {
      setEditSettings(s);
      applySettingsToDOM(s);
    });
  }

  function handleResetKeybinds() {
    invoke<{ keybind: Record<string, string> }>("keybinds_reset").then((kb) => {
      setEditKeybinds({ ...DEFAULT_KEYBINDS, ...(kb?.keybind ?? {}) });
      setKeyConflict("");
    });
  }

  const s = editSettings;

  onMount(() => {
    dialogRef?.focus();
    const handler = (e: KeyboardEvent) => {
      if (!capturing()) return;
      e.preventDefault();
      e.stopPropagation();
      handleKeyCapture(e);
    };
    document.addEventListener("keydown", handler, true);
    onCleanup(() => document.removeEventListener("keydown", handler, true));

    const onMove = (e: PointerEvent) => handleDragPointerMove(e);
    const onUp = () => handleDragPointerUp();
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    onCleanup(() => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      focusApp();
    });
  });

  return (
    <div class="dialog-overlay" onClick={handleCancel}>
      <div
        class="settings-dialog"
        ref={dialogRef}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (capturing()) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            handleCancel();
          }
        }}
      >
        <div class="settings-header">
          <span class="settings-title">設定</span>
        </div>

        <div class="settings-tabs">
          <button
            classList={{
              "settings-tab": true,
              active: tab() === "general",
            }}
            onClick={() => setTab("general")}
          >
            一般
          </button>
          <button
            classList={{
              "settings-tab": true,
              active: tab() === "keymap",
            }}
            onClick={() => setTab("keymap")}
          >
            キーマップ
          </button>
        </div>

        <div class="settings-body">
          <Show when={tab() === "general"}>
            <div class="settings-section">
              <div class="settings-section-title">表示</div>
              <label class="settings-row">
                <span class="settings-label">フォントサイズ</span>
                <div class="settings-slider">
                  <input
                    type="range"
                    min="10"
                    max="28"
                    value={s().display.font_size}
                    onInput={(e) => {
                      const font_size = Number(e.currentTarget.value);
                      previewSettings({
                        ...s(),
                        display: {
                          ...s().display,
                          font_size,
                          row_height: font_size + 13,
                        },
                      });
                    }}
                  />
                  <span class="settings-slider-value">{s().display.font_size}px</span>
                </div>
              </label>
              <label class="settings-row">
                <span class="settings-label">行の高さ</span>
                <div class="settings-slider">
                  <input
                    type="range"
                    min="18"
                    max="48"
                    value={s().display.row_height}
                    onInput={(e) =>
                      previewSettings({
                        ...s(),
                        display: {
                          ...s().display,
                          row_height: Number(e.currentTarget.value),
                        },
                      })
                    }
                  />
                  <span class="settings-slider-value">{s().display.row_height}px</span>
                </div>
              </label>
              <label class="settings-row">
                <span class="settings-label">隠しファイルを表示</span>
                <input
                  class="settings-checkbox"
                  type="checkbox"
                  checked={s().display.show_hidden}
                  onChange={(e) =>
                    setEditSettings({
                      ...s(),
                      display: {
                        ...s().display,
                        show_hidden: e.currentTarget.checked,
                      },
                    })
                  }
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">テーマ</span>
                <select
                  class="settings-input"
                  value={s().display.theme}
                  onChange={(e) =>
                    previewSettings({
                      ...s(),
                      display: {
                        ...s().display,
                        theme: e.currentTarget.value,
                      },
                    })
                  }
                >
                  <For each={THEME_NAMES}>
                    {(t) => <option value={t.value}>{t.label}</option>}
                  </For>
                </select>
              </label>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">列</div>
              <div
                class="column-list"
                ref={listRef}
              >
                <For each={s().display.columns}>
                  {(col) => (
                    <div
                      class="column-item"
                      classList={{ dragging: dragCol() === col }}
                      data-col={col}
                      onPointerDown={(e) => handleDragPointerDown(e, col)}
                    >
                      <span class="column-drag-handle">&#9776;</span>
                      <span class="column-name">{COL_LABELS[col] || col}</span>
                      <button
                        class="column-remove"
                        onClick={() => removeColumn(col)}
                      >
                        &times;
                      </button>
                    </div>
                  )}
                </For>
              </div>
              <Show when={s().display.columns.length < 4}>
                <div class="column-add-row">
                  <span class="column-add-label">追加:</span>
                  <For each={["extension", "size", "date", "permissions"].filter(c => !s().display.columns.includes(c))}>
                    {(col) => (
                      <button
                        class="column-add-chip"
                        onClick={() => addColumn(col)}
                      >
                        + {COL_LABELS[col]}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <label class="settings-row" style="margin-top: 8px;">
                <span class="settings-label">リネーム時に拡張子を除いて選択</span>
                <input
                  class="settings-checkbox"
                  type="checkbox"
                  checked={s().display.rename_without_extension}
                  onChange={(e) =>
                    setEditSettings({
                      ...s(),
                      display: {
                        ...s().display,
                        rename_without_extension: e.currentTarget.checked,
                      },
                    })
                  }
                />
              </label>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">起動フォルダ</div>
              <label class="settings-check">
                <input type="checkbox" checked={s().navigation.restore_session !== false}
                  onChange={(e) => setEditSettings({ ...s(), navigation: { ...s().navigation, restore_session: e.currentTarget.checked } })} />
                起動時に前回の左右の場所とタブを復元する
              </label>
              <div class="settings-hint">前回の状態がない場合、または復元しない場合は次のフォルダを開きます。</div>
              <div class="settings-field">
                <span class="settings-label">左ペイン</span>
                <div class="settings-path">
                  <input
                    class="settings-input settings-input-grow"
                    type="text"
                    placeholder="空欄ならホーム"
                    value={s().navigation.left_dir}
                    onInput={(e) =>
                      setEditSettings({
                        ...s(),
                        navigation: {
                          ...s().navigation,
                          left_dir: e.currentTarget.value,
                        },
                      })
                    }
                  />
                  <button type="button" class="settings-browse" onClick={() => browseFolder("left")}>
                    参照...
                  </button>
                </div>
              </div>
              <div class="settings-field">
                <span class="settings-label">右ペイン</span>
                <div class="settings-path">
                  <input
                    class="settings-input settings-input-grow"
                    type="text"
                    placeholder="空欄ならホーム"
                    value={s().navigation.right_dir}
                    onInput={(e) =>
                      setEditSettings({
                        ...s(),
                        navigation: {
                          ...s().navigation,
                          right_dir: e.currentTarget.value,
                        },
                      })
                    }
                  />
                  <button type="button" class="settings-browse" onClick={() => browseFolder("right")}>
                    参照...
                  </button>
                </div>
              </div>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">アプリ</div>
              <div class="settings-field">
                <span class="settings-label">エディタ</span>
                <div class="settings-path">
                  <input
                    class="settings-input settings-input-grow"
                    type="text"
                    value={s().editor}
                    placeholder="notepad.exe またはフルパス"
                    onInput={(e) =>
                      setEditSettings({
                        ...s(),
                        editor: e.currentTarget.value,
                      })
                    }
                  />
                  <button type="button" class="settings-browse" onClick={browseEditor}>
                    参照...
                  </button>
                </div>
                <div class="settings-hint">
                  「参照」から .exe を選べます。コマンド名（notepad など）だけでも指定できます。
                </div>
              </div>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">並び順</div>
              <label class="settings-row">
                <span class="settings-label">フォルダを先に表示</span>
                <input
                  class="settings-checkbox"
                  type="checkbox"
                  checked={s().sort.dirs_first}
                  onChange={(e) =>
                    setEditSettings({
                      ...s(),
                      sort: {
                        ...s().sort,
                        dirs_first: e.currentTarget.checked,
                      },
                    })
                  }
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">大文字小文字を区別</span>
                <input
                  class="settings-checkbox"
                  type="checkbox"
                  checked={s().sort.case_sensitive}
                  onChange={(e) =>
                    setEditSettings({
                      ...s(),
                      sort: {
                        ...s().sort,
                        case_sensitive: e.currentTarget.checked,
                      },
                    })
                  }
                />
              </label>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">ウィンドウ</div>
              <label class="settings-row">
                <span class="settings-label">起動時のサイズ</span>
                <select
                  class="settings-input"
                  value={s().window.mode}
                  onChange={(e) =>
                    setEditSettings({
                      ...s(),
                      window: {
                        ...s().window,
                        mode: e.currentTarget.value,
                      },
                    })
                  }
                >
                  <option value="remember">前回のサイズを使う</option>
                  <option value="fixed">固定サイズ</option>
                </select>
              </label>
              <label class="settings-row">
                <span class="settings-label">幅</span>
                <input
                  class="settings-input"
                  type="number"
                  min="400"
                  max="3840"
                  value={s().window.width}
                  disabled={s().window.mode === "remember"}
                  onInput={(e) =>
                    setEditSettings({
                      ...s(),
                      window: {
                        ...s().window,
                        width: Number(e.currentTarget.value),
                      },
                    })
                  }
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">高さ</span>
                <input
                  class="settings-input"
                  type="number"
                  min="300"
                  max="2160"
                  value={s().window.height}
                  disabled={s().window.mode === "remember"}
                  onInput={(e) =>
                    setEditSettings({
                      ...s(),
                      window: {
                        ...s().window,
                        height: Number(e.currentTarget.value),
                      },
                    })
                  }
                />
              </label>
            </div>

            <div class="settings-section-actions">
              <button class="settings-reset-btn" onClick={handleResetSettings}>
                デフォルトに戻す
              </button>
            </div>
          </Show>

          <Show when={tab() === "keymap"}>
            <div class="keybind-toolbar">
              <input
                class="settings-input keybind-search"
                type="text"
                placeholder="コマンド名・キーで検索"
                value={keyQuery()}
                onInput={(e) => setKeyQuery(e.currentTarget.value)}
              />
              <Show when={keyConflict()}>
                <div class="keybind-conflict">{keyConflict()}</div>
              </Show>
              <div class="keybind-hint">
                デフォルトはあふw寄り（J=ブックマーク、Shift+J=パスジャンプ、L=ドライブ、C/M=相手窓へコピー/移動、Fは検索）。キーをクリックして変更、＋で追加。
              </div>
            </div>
            <div class="keybind-list">
              <For each={[...COMMAND_GROUPS]}>
                {(group) => {
                  const items = () =>
                    filteredCatalog().filter((c) => c.group === group);
                  return (
                    <Show when={items().length > 0}>
                      <div class="keybind-group-title">{group}</div>
                      <For each={items()}>
                        {(command) => {
                          const keys = () => keysForCommand(command.id);
                          const cap = () => capturing();
                          return (
                            <div class="keybind-row">
                              <div class="keybind-meta">
                                <span class="keybind-command">{command.label}</span>
                                <span class="keybind-desc">{command.description}</span>
                              </div>
                              <div class="keybind-keys">
                                <For each={keys()}>
                                  {(key) => (
                                    <Show
                                      when={
                                        cap()?.command === command.id &&
                                        cap()?.replacing === key
                                      }
                                      fallback={
                                        <button
                                          class="keybind-chip"
                                          title="クリックして変更"
                                          onClick={() =>
                                            setCapturing({
                                              command: command.id,
                                              replacing: key,
                                            })
                                          }
                                        >
                                          {key === " " ? "Space" : key}
                                          <span
                                            class="keybind-chip-x"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              removeKey(key);
                                            }}
                                          >
                                            ×
                                          </span>
                                        </button>
                                      }
                                    >
                                      <button class="keybind-chip capturing">入力中...</button>
                                    </Show>
                                  )}
                                </For>
                                <Show
                                  when={
                                    cap()?.command === command.id && !cap()?.replacing
                                  }
                                  fallback={
                                    <button
                                      class="keybind-add"
                                      title="キーを追加"
                                      onClick={() =>
                                        setCapturing({ command: command.id })
                                      }
                                    >
                                      ＋
                                    </button>
                                  }
                                >
                                  <button class="keybind-chip capturing">入力中...</button>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </Show>
                  );
                }}
              </For>
            </div>

            <div class="settings-section-actions">
              <button class="settings-reset-btn" onClick={handleResetKeybinds}>
                デフォルトに戻す
              </button>
            </div>
          </Show>
        </div>

        <div class="settings-footer">
          <button class="dialog-btn" onClick={handleCancel}>
            キャンセル
          </button>
          <button class="dialog-btn btn-ok" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
