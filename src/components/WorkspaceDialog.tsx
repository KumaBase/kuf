import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { focusApp } from "../focus";
import type { NamedWorkspace, WorkspaceSnapshot } from "../types";

export default function WorkspaceDialog(props: {
  workspaces: NamedWorkspace[];
  onRestore: (snapshot: WorkspaceSnapshot) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}) {
  const [cursorIndex, setCursorIndex] = createSignal(0);
  const selected = () => props.workspaces[cursorIndex()];
  let dialogRef!: HTMLDivElement;
  let closed = false;

  onMount(() => dialogRef.focus());
  onCleanup(() => focusApp());

  createEffect(() => {
    const index = Math.min(cursorIndex(), Math.max(0, props.workspaces.length - 1));
    if (index !== cursorIndex()) setCursorIndex(index);
    queueMicrotask(() => {
      dialogRef?.querySelectorAll<HTMLElement>(".bookmark-row")[index]
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  function close() {
    if (closed) return;
    closed = true;
    props.onClose();
  }

  function restore(workspace = selected()) {
    if (!workspace || closed) return;
    props.onRestore(workspace.snapshot);
    // Keep this modal mounted until the triggering Enter has finished bubbling.
    queueMicrotask(close);
  }

  function removeSelected() {
    const workspace = selected();
    if (!workspace || closed) return;
    // The parent confirms removal and supplies the resulting list.
    props.onRemove(workspace.name);
  }

  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "ArrowUp":
      case "ArrowDown":
        event.preventDefault();
        setCursorIndex((index) => Math.max(0, Math.min(
          Math.max(0, props.workspaces.length - 1),
          index + (event.key === "ArrowUp" ? -1 : 1),
        )));
        dialogRef.focus();
        break;
      case "Home":
      case "End":
        event.preventDefault();
        setCursorIndex(event.key === "Home" ? 0 : Math.max(0, props.workspaces.length - 1));
        dialogRef.focus();
        break;
      case "Enter":
        event.preventDefault();
        if (event.target instanceof HTMLButtonElement) event.target.click();
        else restore();
        break;
      case "Delete":
        event.preventDefault();
        removeSelected();
        break;
      case "Tab": {
        event.preventDefault();
        const buttons = Array.from(dialogRef.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? (index <= 0 ? buttons.length - 1 : index - 1)
          : (index + 1) % buttons.length;
        buttons[next]?.focus();
        break;
      }
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <div
        class="bookmark-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
        tabindex="-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="bookmark-header">
          <span class="bookmark-title" id="workspace-dialog-title">作業セット</span>
        </div>
        <div class="bookmark-body" role="listbox" aria-label="保存した作業セット">
          <Show when={props.workspaces.length === 0}>
            <div class="bookmark-empty">
              保存した作業セットがありません。メニューの「作業セットを保存」から、左右の場所とタブ構成を保存できます。
            </div>
          </Show>
          <For each={props.workspaces}>
            {(workspace, index) => {
              const activeTab = () => workspace.snapshot.tabs[workspace.snapshot.active_index];
              return (
                <div
                  classList={{ "bookmark-row": true, "bookmark-cursor": index() === cursorIndex() }}
                  role="option"
                  aria-selected={index() === cursorIndex()}
                  onClick={() => { setCursorIndex(index()); dialogRef.focus(); }}
                  onDblClick={() => restore(workspace)}
                >
                  <span class="bookmark-name">{workspace.name}</span>
                  <span class="bookmark-path">{workspace.snapshot.tabs.length} タブ</span>
                  <span class="bookmark-path" title={`${activeTab()?.left_path ?? ""} ⇄ ${activeTab()?.right_path ?? ""}`}>
                    {activeTab()?.left_path} ⇄ {activeTab()?.right_path}
                  </span>
                </div>
              );
            }}
          </For>
        </div>
        <div class="bookmark-footer">
          <button type="button" class="dialog-btn" disabled={!selected()} onClick={removeSelected}>削除</button>
          <button type="button" class="dialog-btn btn-ok" disabled={!selected()} onClick={() => restore()}>復元</button>
          <button type="button" class="dialog-btn" onClick={close}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
