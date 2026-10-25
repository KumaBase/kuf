import { createSignal, createMemo, For, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { focusApp } from "../focus";
import { expandExternalArguments, type ExternalCommand, type ExternalCommandContext } from "../external-commands";
import "./ExternalCommandsDialog.css";

const empty = (): ExternalCommand => ({ name: "", program: "", args: [] });
export default function ExternalCommandsDialog(props: { context: ExternalCommandContext; onClose: () => void; onRun: (name: string) => void }) {
  const [commands, setCommands] = createSignal<ExternalCommand[]>([]);
  const [draft, setDraft] = createSignal<ExternalCommand>(empty());
  const [selected, setSelected] = createSignal(-1);
  const [busy, setBusy] = createSignal(true);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal("");
  let form!: HTMLFormElement;
  let nameInput!: HTMLInputElement;
  let disposed = false;
  onMount(async () => {
    form.focus();
    try {
      const saved = await invoke<ExternalCommand[]>("external_commands_load");
      if (disposed) return;
      setCommands(saved); setLoaded(true);
      if (saved.length) pick(0);
    } catch (error) { if (!disposed) setError(String(error)); }
    finally { if (!disposed) { setBusy(false); if (loaded()) nameInput.focus(); else form.focus(); } }
  });
  onCleanup(() => { disposed = true; focusApp(); });
  function pick(index: number) {
    setSelected(index);
    const command = commands()[index];
    setDraft(command ? { ...command, args: [...command.args] } : empty());
    setError("");
  }
  const update = (field: "name" | "program", value: string) => setDraft((command) => ({ ...command, [field]: value }));
  const preview = createMemo(() => expandExternalArguments(draft(), props.context));
  async function save(run: boolean) {
    if (busy() || !loaded()) return;
    const command = { ...draft(), name: draft().name.trim(), program: draft().program.trim() };
    if (!command.name || !command.program) { setError("名前と実行ファイルを入力してください。"); return; }
    const next = commands().map((item) => ({ ...item, args: [...item.args] }));
    if (selected() < 0) next.push(command); else next[selected()] = command;
    setBusy(true); setError("");
    try {
      await invoke("external_commands_save", { commands: next, expected: commands() });
      if (disposed) return;
      setCommands(next); setDraft(command); setSelected(selected() < 0 ? next.length - 1 : selected());
      if (run) { props.onClose(); queueMicrotask(() => props.onRun(command.name)); }
    } catch (error) { if (!disposed) setError(String(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function remove() {
    if (busy() || selected() < 0 || !loaded()) return;
    const next = commands().filter((_, index) => index !== selected());
    setBusy(true);
    try { await invoke("external_commands_save", { commands: next, expected: commands() }); if (!disposed) { setCommands(next); pick(next.length ? 0 : -1); } }
    catch (error) { if (!disposed) setError(String(error)); }
    finally { if (!disposed) setBusy(false); }
  }
  async function browse() {
    if (busy()) return;
    try {
      const path = await invoke<string | null>("pick_file", { title: "実行ファイルを選択" });
      if (path && !disposed) update("program", path);
    } catch (error) { if (!disposed) setError(String(error)); }
  }
  return <div class="dialog-overlay" onClick={() => { if (!busy()) props.onClose(); }} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); if (!busy()) props.onClose(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(true); }
    if (event.key === "Tab") {
      const controls = Array.from(form.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)'));
      if (!controls.length) return;
      event.preventDefault(); const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
  }}>
    <form ref={form} tabindex="-1" class="dialog-box external-dialog" role="dialog" aria-modal="true" aria-labelledby="external-title" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <h2 class="dialog-title" id="external-title">外部コマンド</h2>
      <p class="sort-hint">作業フォルダ: {props.context.directory}</p>
      <div class="external-layout">
        <div class="external-list" role="list" aria-label="登録した外部コマンド">
          <For each={commands()}>{(command, index) => <button type="button" class="dialog-btn" aria-pressed={selected() === index()} disabled={busy()} onClick={() => pick(index())}>{command.name}</button>}</For>
          <button type="button" class="dialog-btn" disabled={busy() || !loaded()} onClick={() => { pick(-1); nameInput.focus(); }}>＋ 新規登録</button>
        </div>
        <fieldset disabled={busy() || !loaded()} class="external-fields">
          <label>名前<input ref={nameInput} class="settings-input" value={draft().name} maxLength={80} onInput={(event) => update("name", event.currentTarget.value)} /></label>
          <label>実行ファイル（シェル・bat/cmdを除く）<div class="external-program"><input class="settings-input" value={draft().program} onInput={(event) => update("program", event.currentTarget.value)} /><button type="button" class="dialog-btn" onClick={() => void browse()}>参照…</button></div></label>
          <label>引数（1行につき1個・引用符は不要）<textarea class="settings-input" rows={5} value={draft().args.join("\n")} onInput={(event) => setDraft((command) => ({ ...command, args: event.currentTarget.value === "" ? [] : event.currentTarget.value.split("\n") }))} /></label>
          <Show when={draft().args.length === 0 || draft().args.length === 1 && draft().args[0] === ""}><label><input type="checkbox" style={{ width: "auto" }} checked={draft().args.length === 1} onChange={(event) => setDraft((command) => ({ ...command, args: event.currentTarget.checked ? [""] : [] }))} /> 空の引数を1個渡す</label></Show>
          <p class="sort-hint">{"{file}: カーソルのパス　{name}: 名前　{dir}: 現在地　{other}: 相手の場所　{selected}: 選択パス（独立した1行で指定）"}</p>
          <div class="external-preview" aria-label="実行内容のプレビュー"><strong>{draft().program || "実行ファイル"}</strong><For each={preview().slice(0, 100)}>{(arg, index) => <div><span>{index() + 1}:</span> {arg === "" ? "（空の引数）" : arg}</div>}</For><Show when={preview().length > 100}><p>先頭100個を表示しています。残り{preview().length - 100}個を含む、全{preview().length}個の引数が実行対象です。</p></Show></div>
        </fieldset>
      </div>
      <Show when={error()}><p class="external-error" role="alert">{error()}</p></Show>
      <div class="dialog-buttons">
        <button type="button" class="dialog-btn" disabled={busy() || selected() < 0} onClick={() => void remove()}>登録を削除</button>
        <button type="button" class="dialog-btn" disabled={busy()} onClick={props.onClose}>閉じる</button>
        <button type="submit" class="dialog-btn" disabled={busy() || !loaded()}>保存</button>
        <button type="button" class="dialog-btn btn-ok" disabled={busy() || !loaded()} onClick={() => void save(true)}>保存して実行（Ctrl+Enter）</button>
      </div>
    </form>
  </div>;
}
