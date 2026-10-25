import { createSignal, For, onCleanup, onMount } from "solid-js";
import type { SortKey, SortOrder, SortSpec } from "../types";
import { SORT_LABELS } from "../commands";
import { focusApp } from "../focus";

export default function SortDialog(props: {
  value: SortSpec;
  onApply: (sort: SortSpec) => void;
  onClose: () => void;
}) {
  const [key, setKey] = createSignal<SortKey>(props.value.key);
  const [order, setOrder] = createSignal<SortOrder>(props.value.order);
  let form!: HTMLFormElement;
  let keySelect!: HTMLSelectElement;
  let closed = false;
  let applying = false;
  const close = () => { if (!closed) { closed = true; props.onClose(); } };
  const apply = () => {
    if (closed || applying) return;
    applying = true;
    props.onApply({ key: key(), order: order() });
    queueMicrotask(close);
  };
  onMount(() => keySelect.focus());
  onCleanup(focusApp);

  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      apply();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(form.querySelectorAll<HTMLElement>("select, button"));
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <form
        class="dialog-box sort-dialog"
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sort-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <h2 class="dialog-title" id="sort-dialog-title">並び順（ソート）</h2>
        <p class="sort-hint">操作中のペインだけに反映します。</p>
        <label class="settings-field">
          <span>項目</span>
          <select ref={keySelect} class="settings-input" value={key()} onChange={(event) => setKey(event.currentTarget.value as SortKey)}>
            <For each={Object.entries(SORT_LABELS)}>{([value, label]) => <option value={value}>{label}</option>}</For>
          </select>
        </label>
        <label class="settings-field">
          <span>順序</span>
          <select class="settings-input" value={order()} onChange={(event) => setOrder(event.currentTarget.value as SortOrder)}>
            <option value="asc">昇順{key() === "size" ? "（小さい順）" : key() === "modified" ? "（古い順）" : ""}</option>
            <option value="desc">降順{key() === "size" ? "（大きい順）" : key() === "modified" ? "（新しい順）" : ""}</option>
          </select>
        </label>
        <p class="sort-hint">あいまい絞り込み中は一致度を優先し、同じ一致度の項目をこの順で並べます。</p>
        <div class="dialog-buttons">
          <button type="button" class="dialog-btn" onClick={close}>キャンセル</button>
          <button type="submit" class="dialog-btn btn-ok">適用</button>
        </div>
      </form>
    </div>
  );
}
