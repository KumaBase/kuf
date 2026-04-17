import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import type { AppSettings } from "../types";
import {
  settings,
  saveSettings,
  saveKeybinds,
  keybinds,
} from "../state";
import { THEME_NAMES } from "../themes";

type Tab = "general" | "keymap";

export default function SettingsDialog(props: {
  onClose: () => void;
  onApply: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("general");
  const [editSettings, setEditSettings] = createSignal<AppSettings>(
    settings() ?? {
      display: { font_size: 13, row_height: 22, show_hidden: true, theme: "tokyo-night" },
      navigation: { left_dir: "", right_dir: "" },
      sort: { dirs_first: true, case_sensitive: false },
      editor: "vim",
    }
  );
  const [editKeybinds, setEditKeybinds] = createSignal<Record<string, string>>({
    ...keybinds(),
  });
  const [capturingKey, setCapturingKey] = createSignal<string | null>(null);

  const ALL_COMMANDS = [
    "cursor_up",
    "cursor_down",
    "cursor_top",
    "cursor_bottom",
    "enter",
    "parent_dir",
    "switch_pane",
    "toggle_select",
    "select_all",
    "refresh",
    "copy",
    "move",
    "delete",
    "rename",
    "new_folder",
    "clear_selection",
    "bookmark_add",
    "bookmark_list",
    "history_back",
    "history_forward",
    "left_pane",
    "right_pane",
    "sync_to_other",
    "sync_from_other",
    "copy_to_other",
    "move_to_other",
    "tab_new",
    "tab_close",
    "tab_next",
    "tab_prev",
    "open_file",
    "open_in_editor",
    "preview",
  ];

  function handleSave() {
    saveSettings(editSettings());
    saveKeybinds(editKeybinds());
    props.onApply();
    props.onClose();
  }

  function formatKeyForCapture(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey && e.key !== "Shift") parts.push("Shift");
    // Ignore pure modifier keys
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return "";
    parts.push(e.key);
    return parts.join("+");
  }

  function handleKeyCapture(e: KeyboardEvent, command: string) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setCapturingKey(null);
      return;
    }

    const key = formatKeyForCapture(e);
    if (!key) return;

    const kb = { ...editKeybinds() };
    // Remove old mapping for this command
    for (const [k, v] of Object.entries(kb)) {
      if (v === command) delete kb[k];
    }
    kb[key] = command;
    setEditKeybinds(kb);
    setCapturingKey(null);
  }

  function findKeyForCommand(command: string): string {
    const kb = editKeybinds();
    for (const [key, cmd] of Object.entries(kb)) {
      if (cmd === command) return key;
    }
    return "";
  }

  function handleResetSettings() {
    invoke<AppSettings>("settings_reset").then((s) => {
      setEditSettings(s);
    });
  }

  function handleResetKeybinds() {
    invoke<{ keybind: Record<string, string> }>("keybinds_reset").then((kb) => {
      if (kb?.keybind) setEditKeybinds(kb.keybind);
    });
  }

  async function invoke<T>(cmd: string): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd);
  }

  const s = editSettings;

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const cap = capturingKey();
      if (!cap) return;
      e.preventDefault();
      e.stopPropagation();
      handleKeyCapture(e, cap);
    };
    document.addEventListener("keydown", handler, true);
    onCleanup(() => document.removeEventListener("keydown", handler, true));
  });

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div
        class="settings-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <div class="settings-header">
          <span class="settings-title">Settings</span>
        </div>

        <div class="settings-tabs">
          <button
            classList={{
              "settings-tab": true,
              active: tab() === "general",
            }}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            classList={{
              "settings-tab": true,
              active: tab() === "keymap",
            }}
            onClick={() => setTab("keymap")}
          >
            Keymap
          </button>
        </div>

        <div class="settings-body">
          <Show when={tab() === "general"}>
            <div class="settings-section">
              <div class="settings-section-title">Display</div>
              <label class="settings-row">
                <span class="settings-label">Font Size</span>
                <input
                  class="settings-input"
                  type="number"
                  min="8"
                  max="24"
                  value={s().display.font_size}
                  onInput={(e) =>
                    setEditSettings({
                      ...s(),
                      display: {
                        ...s().display,
                        font_size: Number(e.currentTarget.value),
                      },
                    })
                  }
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">Row Height</span>
                <input
                  class="settings-input"
                  type="number"
                  min="16"
                  max="40"
                  value={s().display.row_height}
                  onInput={(e) =>
                    setEditSettings({
                      ...s(),
                      display: {
                        ...s().display,
                        row_height: Number(e.currentTarget.value),
                      },
                    })
                  }
                />
              </label>
              <label class="settings-row">
                <span class="settings-label">Show Hidden Files</span>
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
                <span class="settings-label">Theme</span>
                <select
                  class="settings-input"
                  value={s().display.theme}
                  onChange={(e) =>
                    setEditSettings({
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
              <div class="settings-section-title">Navigation</div>
              <label class="settings-row">
                <span class="settings-label">Left Dir</span>
                <input
                  class="settings-input"
                  type="text"
                  placeholder="Home"
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
              </label>
              <label class="settings-row">
                <span class="settings-label">Right Dir</span>
                <input
                  class="settings-input"
                  type="text"
                  placeholder="Home"
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
              </label>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">Applications</div>
              <label class="settings-row">
                <span class="settings-label">Editor</span>
                <input
                  class="settings-input"
                  type="text"
                  value={s().editor}
                  placeholder="vim"
                  onInput={(e) =>
                    setEditSettings({
                      ...s(),
                      editor: e.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>

            <div class="settings-section">
              <div class="settings-section-title">Sort</div>
              <label class="settings-row">
                <span class="settings-label">Directories First</span>
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
                <span class="settings-label">Case Sensitive</span>
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

            <div class="settings-section-actions">
              <button class="settings-reset-btn" onClick={handleResetSettings}>
                Reset to Defaults
              </button>
            </div>
          </Show>

          <Show when={tab() === "keymap"}>
            <div class="keybind-list">
              <For each={ALL_COMMANDS}>
                {(command) => (
                  <div class="keybind-row">
                    <span class="keybind-command">{command}</span>
                    <Show
                      when={capturingKey() === command}
                      fallback={
                        <button
                          class="keybind-key-btn"
                          onClick={() => setCapturingKey(command)}
                        >
                          {findKeyForCommand(command) || "(none)"}
                        </button>
                      }
                    >
                      <button
                        class="keybind-key-btn capturing"
                        ref={(el) => el.focus()}
                      >
                        Press key...
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <div class="settings-section-actions">
              <button class="settings-reset-btn" onClick={handleResetKeybinds}>
                Reset to Defaults
              </button>
            </div>
          </Show>
        </div>

        <div class="settings-footer">
          <button class="dialog-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button class="dialog-btn btn-ok" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
