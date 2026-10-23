import { createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { DriveInfo } from "../types";
import { formatSize } from "../types";
import { focusApp } from "../focus";

export default function DriveDialog(props: {
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const [drives, setDrives] = createSignal<DriveInfo[]>([]);
  const [cursorIndex, setCursorIndex] = createSignal(0);
  const [error, setError] = createSignal("");

  let dialogRef!: HTMLDivElement;

  onMount(async () => {
    dialogRef.focus();
    try {
      const list = await invoke<DriveInfo[]>("list_drives");
      setDrives(list);
    } catch (e) {
      setError(String(e));
    }
  });

  onCleanup(() => focusApp());

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    props.onClose();
  }

  function choose(path: string) {
    if (!path || closed) return;
    props.onNavigate(path);
    queueMicrotask(() => close());
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const list = drives();

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowUp":
        e.preventDefault();
        if (cursorIndex() > 0) setCursorIndex(cursorIndex() - 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (cursorIndex() < list.length - 1) setCursorIndex(cursorIndex() + 1);
        break;
      case "Enter": {
        e.preventDefault();
        const drive = list[cursorIndex()];
        if (drive) choose(drive.path);
        break;
      }
    }
  }

  function capacityBar(available: number, total: number) {
    const used = total - available;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    return (
      <div class="drive-bar-track">
        <div class="drive-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    );
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <div
        class="drive-dialog"
        ref={dialogRef}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="drive-header">
          <span class="drive-title">Drives</span>
        </div>
        <div class="drive-body">
          <Show when={error()}>
            <div class="drive-empty">{error()}</div>
          </Show>
          <Show when={drives().length === 0 && !error()}>
            <div class="drive-empty">No drives found</div>
          </Show>
          <For each={drives()}>
            {(drive, index) => (
              <div
                classList={{
                  "drive-row": true,
                  "drive-cursor": index() === cursorIndex(),
                }}
                onClick={() => {
                  setCursorIndex(index());
                  choose(drive.path);
                }}
              >
                <span class="drive-icon">💾</span>
                <div class="drive-info">
                  <div class="drive-name">{drive.name}</div>
                  <div class="drive-path">{drive.path}</div>
                </div>
                <div class="drive-capacity">
                  <div class="drive-capacity-text">
                    {formatSize(drive.available_bytes)} free / {formatSize(drive.total_bytes)}
                  </div>
                  {capacityBar(drive.available_bytes, drive.total_bytes)}
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="drive-footer">
          <button type="button" class="dialog-btn btn-ok" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
