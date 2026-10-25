import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { FileInfo } from "../types";
import { buildRenamePreview, DEFAULT_RENAME_OPTIONS, type RenameOptions, type RenamePlanItem } from "../batch-rename";
import { focusApp } from "../focus";
import "./BulkRenameDialog.css";

export default function BulkRenameDialog(props: {
  files: readonly FileInfo[];
  existingFiles: readonly FileInfo[];
  directory: string;
  onApply: (plan: RenamePlanItem[]) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = createSignal<RenameOptions>({ ...DEFAULT_RENAME_OPTIONS });
  const preview = createMemo(() => buildRenamePreview(props.files, props.existingFiles, options(), /^[A-Za-z]:|^\\\\/.test(props.directory)));
  const pageSize = 100;
  const [page, setPage] = createSignal(0);
  const pageCount = createMemo(() => Math.max(1, Math.ceil(preview().rows.length / pageSize)));
  const currentPage = createMemo(() => Math.min(page(), pageCount() - 1));
  const firstRow = () => currentPage() * pageSize;
  const visibleRows = createMemo(() => preview().rows.slice(firstRow(), firstRow() + pageSize));
  createEffect(() => { if (page() !== currentPage()) setPage(currentPage()); });
  const changed = () => preview().rows.filter((row) => row.changed).length;
  const update = <K extends keyof RenameOptions>(key: K, value: RenameOptions[K]) => setOptions((previous) => ({ ...previous, [key]: value }));
  let form!: HTMLFormElement;
  let modeSelect!: HTMLSelectElement;
  let previewTable!: HTMLDivElement;
  const changePage = (index: number) => {
    setPage(Math.max(0, Math.min(pageCount() - 1, index)));
    previewTable.scrollTop = 0;
  };
  let closed = false, applying = false;
  const close = () => { if (!closed) { closed = true; props.onClose(); } };
  const apply = () => {
    if (closed || applying || preview().errors.length || !changed()) return;
    applying = true;
    props.onApply(preview().plan);
    queueMicrotask(close);
  };
  onMount(() => modeSelect.focus());
  onCleanup(focusApp);
  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const button = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("button") : null;
      if (button) { if (!button.disabled) button.click(); }
      else apply();
    }
    else if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(form.querySelectorAll<HTMLElement>("input, select, button:not(:disabled)"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
      controls[next]?.focus();
    }
  }
  return (
    <div class="dialog-overlay" onClick={close}>
      <form ref={form} class="dialog-box bulk-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-rename-title"
        onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown} onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <h2 class="dialog-title" id="bulk-rename-title">一括リネーム</h2>
        <p class="sort-hint">{props.directory}<br />{props.files.length} 件の名前を変更します。ファイルは拡張子とその大文字・小文字を保ちます。</p>
        <label class="settings-field"><span>変更方法</span><select ref={modeSelect} class="settings-input" value={options().mode} onChange={(event) => update("mode", event.currentTarget.value as RenameOptions["mode"])}>
          <option value="replace">文字列を置換</option><option value="affix">接頭辞・接尾辞を付ける</option><option value="sequence">連番にする</option>
        </select></label>
        <Show when={options().mode === "replace"}><div class="bulk-rename-fields">
          <label class="settings-field"><span>置換する文字列</span><input class="settings-input" value={options().find} onInput={(event) => update("find", event.currentTarget.value)} /></label>
          <label class="settings-field"><span>置換後</span><input class="settings-input" value={options().replacement} onInput={(event) => update("replacement", event.currentTarget.value)} /></label>
        </div></Show>
        <Show when={options().mode !== "replace"}><div class="bulk-rename-fields">
          <label class="settings-field"><span>接頭辞</span><input class="settings-input" value={options().prefix} onInput={(event) => update("prefix", event.currentTarget.value)} /></label>
          <label class="settings-field"><span>接尾辞</span><input class="settings-input" value={options().suffix} onInput={(event) => update("suffix", event.currentTarget.value)} /></label>
        </div></Show>
        <Show when={options().mode === "sequence"}><div class="bulk-rename-fields">
          <label class="settings-field"><span>開始番号</span><input class="settings-input" type="number" min="0" step="1" value={options().start} onInput={(event) => update("start", event.currentTarget.valueAsNumber)} /></label>
          <label class="settings-field"><span>増分</span><input class="settings-input" type="number" min="1" step="1" value={options().step} onInput={(event) => update("step", event.currentTarget.valueAsNumber)} /></label>
          <label class="settings-field"><span>桁数</span><input class="settings-input" type="number" min="1" max="12" step="1" value={options().padding} onInput={(event) => update("padding", event.currentTarget.valueAsNumber)} /></label>
        </div></Show>
        <p class="sort-hint">置換は大文字・小文字を区別する文字列置換です。フォルダーは名前全体が対象です。既存名への変更や入れ替えは実行しません。</p>
        <div class="bulk-rename-pages" role="group" aria-label="変更予定一覧のページ切替">
          <button type="button" class="dialog-btn" disabled={currentPage() === 0} onClick={() => changePage(0)}>先頭</button>
          <button type="button" class="dialog-btn" disabled={currentPage() === 0} onClick={() => changePage(currentPage() - 1)}>前へ</button>
          <span role="status" aria-live="polite">{preview().rows.length ? firstRow() + 1 : 0}〜{Math.min(firstRow() + pageSize, preview().rows.length)} / 全{preview().rows.length}件</span>
          <button type="button" class="dialog-btn" disabled={currentPage() >= pageCount() - 1} onClick={() => changePage(currentPage() + 1)}>次へ</button>
          <button type="button" class="dialog-btn" disabled={currentPage() >= pageCount() - 1} onClick={() => changePage(pageCount() - 1)}>末尾</button>
        </div>
        <div ref={previewTable} class="bulk-rename-preview"><table><thead><tr><th>変更前</th><th>変更後</th></tr></thead><tbody>
          <For each={visibleRows()}>{(row) => <tr classList={{ "bulk-rename-invalid": !!row.error, "bulk-rename-unchanged": !row.changed }}>
            <td>{row.from}</td><td>{row.to}<Show when={row.error}><span class="bulk-rename-error">{row.error}</span></Show></td>
          </tr>}</For>
        </tbody></table></div>
        <p class="sort-hint">一覧は100件ずつ表示します。ページに関係なく、全件を事前検査して実行します。</p>
        <Show when={preview().errors.length}><p class="bulk-rename-error" role="alert">{preview().errors[0]}{preview().errors.length > 1 ? `（ほか${preview().errors.length - 1}件）` : ""}</p></Show>
        <p class="sort-hint" role="status">変更 {changed()} 件・変更なし {props.files.length - changed()} 件。実行中に停止・失敗した場合、完了した変更は保持し、結果を表示します。</p>
        <div class="dialog-buttons"><button type="button" class="dialog-btn" onClick={close}>キャンセル</button><button type="submit" class="dialog-btn btn-ok" disabled={!!preview().errors.length || !changed()}>名前を変更</button></div>
      </form>
    </div>
  );
}
