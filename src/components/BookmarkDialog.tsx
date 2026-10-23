import { createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { focusApp } from "../focus";
import { baseName } from "../types";

export default function BookmarkDialog(props: {
  onClose: () => void;
  onNavigate: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  const [bookmarks, setBookmarks] = createSignal<string[]>([]);
  const [cursorIndex, setCursorIndex] = createSignal(0);

  let dialogRef!: HTMLDivElement;
  let closed = false;

  onMount(async () => {
    dialogRef.focus();
    try {
      const list = await invoke<string[]>("bookmark_list");
      setBookmarks(list);
    } catch (e) {
      console.error("Failed to load bookmarks:", e);
    }
  });

  onCleanup(() => focusApp());

  function close() {
    if (closed) return;
    closed = true;
    props.onClose();
  }

  function choose(path: string) {
    if (!path || closed) return;
    props.onNavigate(path);
    // Close after this key/click finishes so Enter is not handled as "open folder".
    queueMicrotask(() => close());
  }

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

  function jumpByLetter(letter: string) {
    const list = bookmarks();
    if (list.length === 0) return;
    const ch = letter.toLowerCase();
    const matches = list
      .map((path, i) => ({ path, i }))
      .filter(({ path }) => baseName(path).toLowerCase().startsWith(ch));
    if (matches.length === 0) return;
    if (matches.length === 1) {
      setCursorIndex(matches[0].i);
      choose(matches[0].path);
      return;
    }
    const next = matches.find(({ i }) => i > cursorIndex()) ?? matches[0];
    setCursorIndex(next.i);
  }

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    const list = bookmarks();

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
        const path = list[cursorIndex()];
        if (path) choose(path);
        break;
      }
      case "Delete":
        e.preventDefault();
        removeSelected();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          jumpByLetter(e.key);
        }
        break;
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <div
        class="bookmark-dialog"
        ref={dialogRef}
        tabindex="-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div class="bookmark-header">
          <span class="bookmark-title">ブックマーク</span>
        </div>
        <div class="bookmark-body">
          <Show when={bookmarks().length === 0}>
            <div class="bookmark-empty">登録がありません。Ctrl+D で追加できます。</div>
          </Show>
          <For each={bookmarks()}>
            {(path, index) => (
              <div
                classList={{
                  "bookmark-row": true,
                  "bookmark-cursor": index() === cursorIndex(),
                }}
                onClick={() => {
                  setCursorIndex(index());
                  choose(path);
                }}
              >
                <span class="bookmark-name">{baseName(path) || path}</span>
                <span class="bookmark-path">{path}</span>
              </div>
            )}
          </For>
        </div>
        <div class="bookmark-footer">
          <button type="button" class="dialog-btn" onClick={removeSelected}>
            削除
          </button>
          <button type="button" class="dialog-btn btn-ok" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
