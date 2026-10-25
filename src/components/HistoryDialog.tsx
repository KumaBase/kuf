import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { HistoryEntry } from "../types";
import { focusApp } from "../focus";

export default function HistoryDialog(props: {
  entries: readonly HistoryEntry[];
  currentIndex: number;
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = createSignal(Math.max(0, props.currentIndex));
  let container!: HTMLDivElement;
  let closed = false;
  let applying = false;
  const close = () => { if (!closed) { closed = true; props.onClose(); } };
  const jump = (index = cursor()) => {
    if (closed || applying || !props.entries[index]) return;
    applying = true;
    props.onJump(index);
    queueMicrotask(close);
  };
  onMount(() => container.focus());
  onCleanup(focusApp);
  createEffect(() => {
    const index = Math.max(0, Math.min(cursor(), props.entries.length - 1));
    if (index !== cursor()) setCursor(index);
    queueMicrotask(() => container?.querySelectorAll<HTMLElement>(".bookmark-row")[index]?.scrollIntoView({ block: "nearest" }));
  });

  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setCursor((index) => event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, props.entries.length - 1)
        : Math.max(0, Math.min(props.entries.length - 1, index + (event.key === "ArrowUp" ? -1 : 1))));
      container.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.target instanceof HTMLButtonElement) event.target.click(); else jump();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
      buttons[next]?.focus();
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <div class="bookmark-dialog" ref={container} tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title"
        onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
        <div class="bookmark-header"><span class="bookmark-title" id="history-dialog-title">移動履歴</span></div>
        <div class="bookmark-body" role="listbox" aria-label="操作中のペインの移動履歴">
          <Show when={!props.entries.length}><div class="bookmark-empty">移動履歴はありません。</div></Show>
          <For each={props.entries}>{(entry, index) => (
            <div classList={{ "bookmark-row": true, "bookmark-cursor": index() === cursor() }} role="option" aria-selected={index() === cursor()}
              onClick={() => { setCursor(index()); container.focus(); }} onDblClick={() => jump(index())}>
              <span class="bookmark-name">{index() === props.currentIndex ? "● 現在" : `${index() + 1}`}</span>
              <span class="bookmark-path" title={entry.path}>{entry.path}</span>
            </div>
          )}</For>
        </div>
        <div class="bookmark-footer"><button type="button" class="dialog-btn" onClick={close}>閉じる</button>
          <button type="button" class="dialog-btn btn-ok" disabled={!props.entries[cursor()]} onClick={() => jump()}>移動</button></div>
      </div>
    </div>
  );
}
