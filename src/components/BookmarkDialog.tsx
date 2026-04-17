import { createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export default function BookmarkDialog(props: {
  onClose: () => void;
  onNavigate: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  const [bookmarks, setBookmarks] = createSignal<string[]>([]);
  const [cursorIndex, setCursorIndex] = createSignal(0);

  let dialogRef!: HTMLDivElement;

  onMount(async () => {
    dialogRef.focus();
    try {
      const list = await invoke<string[]>("bookmark_list");
      setBookmarks(list);
    } catch (e) {
      console.error("Failed to load bookmarks:", e);
    }
  });

  function removeSelected() {
    const list = bookmarks();
    const path = list[cursorIndex()];
    if (!path) return;
    props.onRemove(path);
    const newList = list.filter((_, i) => i !== cursorIndex());
    setBookmarks(newList);
    if (newList.length === 0) {
      setCursorIndex(0);
    } else if (cursorIndex() >= newList.length) {
      setCursorIndex(newList.length - 1);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const list = bookmarks();

    switch (e.key) {
      case "Escape":
        props.onClose();
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
        const path = list[cursorIndex()];
        if (path) {
          props.onNavigate(path);
          props.onClose();
        }
        break;
      }
      case "Delete":
        removeSelected();
        break;
    }
  }

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div
        class="bookmark-dialog"
        ref={dialogRef}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="bookmark-header">
          <span class="bookmark-title">Bookmarks</span>
        </div>
        <div class="bookmark-body">
          <Show when={bookmarks().length === 0}>
            <div class="bookmark-empty">No bookmarks</div>
          </Show>
          <For each={bookmarks()}>
            {(path, index) => (
              <div
                classList={{
                  "bookmark-row": true,
                  "bookmark-cursor": index() === cursorIndex(),
                }}
                onClick={() => setCursorIndex(index())}
                onDblClick={() => {
                  props.onNavigate(path);
                  props.onClose();
                }}
              >
                <span class="bookmark-path">{path}</span>
              </div>
            )}
          </For>
        </div>
        <div class="bookmark-footer">
          <button class="dialog-btn" onClick={removeSelected}>
            Remove
          </button>
          <button class="dialog-btn btn-ok" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
