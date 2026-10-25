import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { FileInfo } from "../types";
import { compareFilesForSelection, type CompareMode } from "../filer-selection";
import { focusApp } from "../focus";

export default function CompareDialog(props: {
  sourceFiles: readonly FileInfo[];
  targetFiles: readonly FileInfo[];
  caseSensitive: boolean;
  sourcePath?: string;
  targetPath?: string;
  onApply: (mode: CompareMode) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = createSignal<CompareMode>("missing");
  const count = createMemo(() => compareFilesForSelection(props.sourceFiles, props.targetFiles, mode(), props.caseSensitive).length);
  let form!: HTMLFormElement;
  let modeSelect!: HTMLSelectElement;
  let closed = false;
  let applying = false;
  const close = () => { if (!closed) { closed = true; props.onClose(); } };
  const apply = () => {
    if (closed || applying) return;
    applying = true;
    props.onApply(mode());
    queueMicrotask(close);
  };
  onMount(() => modeSelect.focus());
  onCleanup(focusApp);
  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); apply(); }
    else if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(form.querySelectorAll<HTMLElement>("select, button:not(:disabled)"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  }
  return (
    <div class="dialog-overlay" onClick={close}>
      <form class="dialog-box" ref={form} role="dialog" aria-modal="true" aria-labelledby="compare-dialog-title"
        onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown} onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <h2 class="dialog-title" id="compare-dialog-title">左右を比較して選択</h2>
        <Show when={props.sourcePath}><p class="dialog-message">選択する側: {props.sourcePath}<br />相手側: {props.targetPath}</p></Show>
        <label class="settings-field"><span>選択する条件</span>
          <select ref={modeSelect} class="settings-input" value={mode()} onChange={(event) => setMode(event.currentTarget.value as CompareMode)}>
            <option value="missing">相手に同名のファイルがない</option><option value="different">同名でサイズ・更新日時が異なる</option><option value="newer">同名でこちらの更新日時が新しい</option>
          </select>
        </label>
        <p class="dialog-message" role="status">操作中のペインで {count()} 件を選択します。現在の選択は置き換えます。</p>
        <p class="sort-hint">表示中のファイルだけを比較します。フォルダーとその配下は対象外です。絞り込み中は両側の表示内容が対象になります。</p>
        <p class="sort-hint">名前の大文字・小文字を{props.caseSensitive ? "区別します" : "区別しません"}。日時が不明な項目を「新しい」とは判定しません。</p>
        <p class="sort-hint">サイズと更新日時による比較です。ファイル内容の一致を保証しません。コピーや移動は行いません。</p>
        <div class="dialog-buttons"><button type="button" class="dialog-btn" onClick={close}>キャンセル</button><button type="submit" class="dialog-btn btn-ok">選択</button></div>
      </form>
    </div>
  );
}
