import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { focusApp } from "../focus";
import { isRemotePath, parseRemotePath } from "../types";
import { decodeBase64, decodePreview, findTextMatches, formatHexPage, PREVIEW_ENCODINGS, PREVIEW_IMAGE_TYPES, type PreviewBytes, type PreviewEncoding } from "../preview";
import "./FileViewer.css";

const HEX_PAGE_SIZE = 16 * 1024;

export default function FileViewer(props: {
  path: string;
  fileName: string;
  extension: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [bytes, setBytes] = createSignal(new Uint8Array());
  const [imageSrc, setImageSrc] = createSignal("");
  const [imageFailed, setImageFailed] = createSignal(false);
  const [encoding, setEncoding] = createSignal<PreviewEncoding>("auto");
  const [view, setView] = createSignal<"auto" | "text" | "hex">("auto");
  const [hexPage, setHexPage] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [matchCursor, setMatchCursor] = createSignal(0);
  let dialog!: HTMLDivElement;
  let textBody!: HTMLPreElement;
  let findInput!: HTMLInputElement;
  let generation = 0;
  let disposed = false;
  let ownedUrl = "";
  let closed = false;
  const imageMime = () => PREVIEW_IMAGE_TYPES[props.extension.toLowerCase()] ?? "";
  const decoded = createMemo(() => decodePreview(bytes(), encoding()));
  const hexMode = () => view() === "hex" || view() === "auto" && decoded().binary;
  const matches = createMemo(() => findTextMatches(decoded().text, query()));
  const hexPages = () => Math.max(1, Math.ceil(bytes().length / HEX_PAGE_SIZE));
  const hex = createMemo(() => formatHexPage(bytes(), hexPage() * HEX_PAGE_SIZE, HEX_PAGE_SIZE));
  const segments = createMemo(() => {
    const content = decoded().text;
    const parts: { text: string; index: number | null }[] = [];
    let offset = 0;
    for (const [index, match] of matches().matches.entries()) {
      if (match.start > offset) parts.push({ text: content.slice(offset, match.start), index: null });
      parts.push({ text: content.slice(match.start, match.end), index });
      offset = match.end;
    }
    if (offset < content.length || !parts.length) parts.push({ text: content.slice(offset), index: null });
    return parts;
  });

  function releaseImage() {
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    ownedUrl = "";
  }
  function close() { if (!closed) { closed = true; props.onClose(); } }

  createEffect(() => {
    const path = props.path;
    const mime = imageMime();
    const id = ++generation;
    releaseImage();
    setLoading(true); setError(""); setBytes(new Uint8Array()); setImageSrc(""); setImageFailed(false);
    setEncoding("auto"); setView("auto"); setQuery(""); setMatchCursor(0); setHexPage(0);
    void (async () => {
      try {
        const remote = isRemotePath(path) ? parseRemotePath(path) : null;
        if (isRemotePath(path) && !remote) throw new Error("SFTPのパスが不正です");
        const result = await invoke<PreviewBytes>(remote ? "ssh_read_preview" : "read_preview", remote
          ? { host: remote.host, port: remote.port, path: remote.remotePath, image: !!mime }
          : { path, image: !!mime });
        if (disposed || id !== generation) return;
        const data = decodeBase64(result.data_base64);
        if (mime) {
          ownedUrl = URL.createObjectURL(new Blob([data], { type: mime }));
          setImageSrc(ownedUrl);
        } else setBytes(data);
      } catch (e) {
        if (!disposed && id === generation) setError(String(e));
      } finally { if (!disposed && id === generation) setLoading(false); }
    })();
  });
  onMount(() => dialog.focus());
  onCleanup(() => { disposed = true; ++generation; releaseImage(); focusApp(); });

  createEffect(() => {
    const index = matchCursor();
    const count = matches().matches.length;
    if (index >= count && index !== 0) setMatchCursor(0);
    queueMicrotask(() => {
      if (!disposed) textBody?.querySelector<HTMLElement>(`mark[data-match="${index}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  function nextMatch(direction: number) {
    const count = matches().matches.length;
    if (count) setMatchCursor((current) => (current + direction + count) % count);
  }
  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !imageMime() && !loading() && !error()) {
      event.preventDefault(); setView("text"); queueMicrotask(() => { if (!disposed) { findInput?.focus(); findInput?.select(); } }); return;
    }
    if ((event.key === "F3" || event.key === "Enter" && event.target === findInput) && !hexMode()) {
      event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
      controls[next]?.focus();
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <div class="preview-dialog" ref={dialog} tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="preview-title"
        onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown}>
        <div class="preview-header"><span id="preview-title" title={props.path}>{props.fileName}</span><button type="button" class="dialog-btn" onClick={close}>閉じる (Esc)</button></div>
        <Show when={loading()}><div class="preview-message" role="status">読み込んでいます…</div></Show>
        <Show when={!loading() && error()}><div class="preview-message preview-error" role="alert">{error()}</div></Show>
        <Show when={!loading() && !error() && imageMime()}>
          <Show when={!imageFailed()} fallback={<div class="preview-message preview-error" role="alert">画像を表示できませんでした。この形式やファイルの状態を確認してください。</div>}>
            <div class="preview-image-body"><img src={imageSrc()} alt={props.fileName} onError={(event) => {
              if (!disposed && event.currentTarget.getAttribute("src") === imageSrc()) setImageFailed(true);
            }} /></div>
          </Show>
        </Show>
        <Show when={!loading() && !error() && !imageMime()}>
          <div class="preview-toolbar">
            <label>表示 <select value={view()} onChange={(event) => setView(event.currentTarget.value as "auto" | "text" | "hex")}>
              <option value="auto">自動</option><option value="text">テキスト</option><option value="hex">バイナリ (16進)</option>
            </select></label>
            <label>文字コード <select value={encoding()} disabled={hexMode()} onChange={(event) => { setEncoding(event.currentTarget.value as PreviewEncoding); setMatchCursor(0); }}>
              <For each={Object.entries(PREVIEW_ENCODINGS)}>{([value, label]) => <option value={value}>{label}</option>}</For>
            </select></label>
            <span>{bytes().length.toLocaleString()} bytes<Show when={!hexMode()}>・{PREVIEW_ENCODINGS[decoded().encoding]}{encoding() === "auto" && decoded().estimated ? "（推定）" : ""}</Show></span>
          </div>
          <Show when={!hexMode() && encoding() === "auto" && decoded().estimated}><p class="preview-note">文字コードは推定です。文字化けする場合は「文字コード」を変更してください。</p></Show>
          <Show when={!hexMode() && decoded().hadErrors}><p class="preview-note" role="status">この文字コードで読み取れない箇所を置換して表示しています。別の文字コードも試してください。</p></Show>
          <Show when={hexMode()} fallback={<>
            <div class="preview-find"><label>文中検索 <input ref={findInput} value={query()} maxLength={256} placeholder="Ctrl+F / Enter・F3で次へ" onInput={(event) => { setQuery(event.currentTarget.value); setMatchCursor(0); }} /></label>
              <span role="status">{query() ? matches().matches.length ? `${matchCursor() + 1} / ${matches().matches.length}${matches().limited ? "+" : ""}` : "一致なし" : ""}</span>
              <button type="button" disabled={!matches().matches.length} onClick={() => nextMatch(-1)}>前へ</button><button type="button" disabled={!matches().matches.length} onClick={() => nextMatch(1)}>次へ</button>
            </div>
            <pre class="preview-text" ref={textBody}><For each={segments()}>{(part) => part.index === null ? part.text : <mark data-match={part.index} classList={{ "preview-match-current": part.index === matchCursor() }}>{part.text}</mark>}</For></pre>
          </>}>
            <div class="preview-find"><span>16進数表示・{hexPage() + 1} / {hexPages()}ページ（1ページ16 KiB）</span>
              <button type="button" disabled={hexPage() <= 0} onClick={() => setHexPage((page) => page - 1)}>前のページ</button>
              <button type="button" disabled={hexPage() >= hexPages() - 1} onClick={() => setHexPage((page) => page + 1)}>次のページ</button>
            </div>
            <pre class="preview-text preview-hex">{hex()}</pre>
          </Show>
        </Show>
      </div>
    </div>
  );
}
