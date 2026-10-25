import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { PatternSelectionMode } from "../filer-selection";
import { focusApp } from "../focus";

export default function PatternSelectDialog(props: {
  caseSensitive: boolean;
  value?: string;
  onApply: (pattern: string, mode: PatternSelectionMode) => void;
  onClose: () => void;
}) {
  const [pattern, setPattern] = createSignal(props.value ?? "*");
  const [mode, setMode] = createSignal<PatternSelectionMode>("replace");
  const [error, setError] = createSignal("");
  let form!: HTMLFormElement;
  let input!: HTMLInputElement;
  let closed = false;
  let applying = false;
  const close = () => { if (!closed) { closed = true; props.onClose(); } };
  const apply = () => {
    if (closed || applying) return;
    if (!pattern()) { setError("条件を入力してください。"); input.focus(); return; }
    applying = true;
    try { props.onApply(pattern(), mode()); queueMicrotask(close); }
    catch (failure) { applying = false; setError(String(failure)); }
  };
  onMount(() => { input.focus(); input.select(); });
  onCleanup(focusApp);

  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); apply(); }
    else if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(form.querySelectorAll<HTMLElement>("input, select, button:not(:disabled)"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <form class="dialog-box" ref={form} role="dialog" aria-modal="true" aria-labelledby="pattern-select-title"
        onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}
        onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <h2 class="dialog-title" id="pattern-select-title">条件で選択</h2>
        <p class="dialog-message">表示中の項目を名前で選択します。* は任意の文字列、? は1文字です。親フォルダーは選択しません。</p>
        <label class="settings-field"><span>条件</span>
          <input ref={input} class="dialog-input" value={pattern()} maxLength={128}
            placeholder="例: *.txt" onInput={(event) => { setPattern(event.currentTarget.value); setError(""); }} />
        </label>
        <label class="settings-field"><span>選択方法</span>
          <select class="settings-input" value={mode()} onChange={(event) => setMode(event.currentTarget.value as PatternSelectionMode)}>
            <option value="replace">一致する項目を選択</option><option value="add">現在の選択へ追加</option><option value="remove">現在の選択から解除</option>
          </select>
        </label>
        <p class="sort-hint">英字の大文字・小文字を{props.caseSensitive ? "区別します" : "区別しません"}（ソート設定と共通）。正規表現は使いません。</p>
        <Show when={error()}><p class="pane-load-error" role="alert">{error()}</p></Show>
        <div class="dialog-buttons"><button type="button" class="dialog-btn" onClick={close}>キャンセル</button><button type="submit" class="dialog-btn btn-ok">選択</button></div>
      </form>
    </div>
  );
}
