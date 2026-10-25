import { createMemo, createSignal, createEffect, For, onCleanup, onMount, Show } from "solid-js";
import type { Command } from "../types";
import { COMMAND_CATALOG } from "../commands";
import { keybinds } from "../state";
import { compileFileFilter, prepareFileName } from "../filter";
import { focusApp } from "../focus";
import "./CommandPalette.css";

export default function CommandPalette(props: { onClose: () => void; onExecute: (command: Command) => void }) {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  let closeButton!: HTMLButtonElement;
  const matches = createMemo(() => {
    const match = compileFileFilter(query(), { mode: "smart" });
    return COMMAND_CATALOG.filter((c) => c.id !== "command_palette").flatMap((command, index) => {
      const keys = Object.entries(keybinds()).filter(([, id]) => id === command.id).map(([key]) => key);
      const result = match(prepareFileName(`${command.label} ${command.description} ${command.group} ${command.id} ${keys.join(" ")}`));
      return result ? [{ command, keys, score: result.score, index }] : [];
    }).sort((a, b) => b.score - a.score || a.index - b.index);
  });
  createEffect(() => { query(); setCursor(0); });
  createEffect(() => { cursor(); list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); });
  onMount(() => input.focus());
  onCleanup(focusApp);
  const choose = (command: Command) => { props.onClose(); queueMicrotask(() => props.onExecute(command)); };
  return <div class="dialog-overlay" onClick={props.onClose} onKeyDown={(e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); setCursor((i) => Math.max(0, Math.min(matches().length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    }
    if (e.key === "Enter" && e.target === input) { e.preventDefault(); const item = matches()[cursor()]; if (item) choose(item.command.id); }
    if (e.key === "Tab") { e.preventDefault(); (document.activeElement === input ? closeButton : input).focus(); }
  }}>
    <section class="dialog-box command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onClick={(e) => e.stopPropagation()}>
      <h2 class="dialog-title" id="command-palette-title">コマンドを検索</h2>
      <input ref={input} class="settings-input" placeholder="操作名・説明・キーを入力" aria-label="コマンドを検索" role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={matches().length ? `command-${cursor()}` : undefined} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      <div ref={list} id="command-results" class="command-results" role="listbox" aria-label="コマンド一覧">
        <For each={matches()}>{(item, index) => <div id={`command-${index()}`} class="command-result" role="option" aria-selected={index() === cursor()} onMouseMove={() => setCursor(index())} onClick={() => choose(item.command.id)}>
          <div><strong>{item.command.label}</strong><span class="command-detail">{item.command.description}</span></div>
          <span class="command-keys">{item.keys.join(" / ") || item.command.group}</span>
        </div>}</For>
        <Show when={!matches().length}><p>一致する操作がありません。</p></Show>
      </div>
      <p class="sort-hint">↑↓で選択、Enterで実行、Escで閉じる。キーは設定の「キーマップ」で変更できます。</p>
      <div class="dialog-buttons"><button ref={closeButton} class="dialog-btn" onClick={props.onClose}>閉じる</button></div>
    </section>
  </div>;
}
