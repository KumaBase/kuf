import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { focusApp, isTypingTarget } from "../focus";
import { isRemotePath } from "../types";
import type { SearchProgress, SearchRequest, SearchResponse, SearchResult } from "../search";
import "./SearchDialog.css";

const RESULT_HEIGHT = 56;

export default function SearchDialog(props: {
  rootPath: string;
  showHidden: boolean;
  caseSensitive: boolean;
  onChoose: (result: SearchResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [includeFiles, setIncludeFiles] = createSignal(true);
  const [includeDirectories, setIncludeDirectories] = createSignal(true);
  const [running, setRunning] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [error, setError] = createSignal("");
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [response, setResponse] = createSignal<SearchResponse | null>(null);
  const [progress, setProgress] = createSignal<SearchProgress | null>(null);
  const [cursor, setCursor] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewHeight, setViewHeight] = createSignal(280);
  let form!: HTMLFormElement;
  let queryInput!: HTMLInputElement;
  let resultList!: HTMLDivElement;
  let currentId: string | null = null;
  let closed = false;
  let choosing = false;
  const remote = () => isRemotePath(props.rootPath);

  const listener = listen<SearchProgress>("file-search-progress", ({ payload }) => {
    // Search IDs also act as generations: late events never update a new run.
    if (!closed && payload.search_id === currentId) setProgress(payload);
  }).then((unlisten) => ({ unlisten, error: "" }), (e) => ({ unlisten: null, error: String(e) }));

  onMount(() => {
    queryInput.focus();
    const observer = new ResizeObserver(([entry]) => setViewHeight(entry.contentRect.height));
    observer.observe(resultList);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    closed = true;
    if (currentId) void invoke("search_cancel", { searchId: currentId }).catch(() => {});
    currentId = null;
    void listener.then(({ unlisten }) => unlisten?.());
    focusApp();
  });

  function close() {
    if (closed) return;
    closed = true;
    props.onClose();
  }

  async function startSearch() {
    if (closed || remote()) return;
    if (!query().trim()) { setError("検索する名前を入力してください"); queryInput.focus(); return; }
    if (!includeFiles() && !includeDirectories()) { setError("ファイルかフォルダを選んでください"); return; }
    const previous = currentId;
    const id = crypto.randomUUID();
    currentId = id;
    if (previous) void invoke("search_cancel", { searchId: previous }).catch(() => {});
    const request: SearchRequest = {
      search_id: id, root_path: props.rootPath, query: query().trim(),
      include_files: includeFiles(), include_directories: includeDirectories(),
      show_hidden: props.showHidden, case_sensitive: props.caseSensitive, max_results: 5000,
    };
    setRunning(true); setStopping(false); setError(""); setResults([]); setResponse(null); setProgress(null);
    setCursor(0); setScrollTop(0); resultList.scrollTop = 0;
    try {
      const ready = await listener;
      if (ready.error) throw new Error(`検索の進捗を受信できません: ${ready.error}`);
      // Register before run, so cancellation during startup cannot be lost.
      await invoke("search_begin", { searchId: id });
      if (closed || currentId !== id || stopping()) await invoke("search_cancel", { searchId: id });
      // Always run after begin, even if cancelled while awaiting it. The backend
      // returns immediately for a cancelled token and releases its slot.
      const data = await invoke<SearchResponse>("search_files", { request });
      if (closed || currentId !== id || data.search_id !== id) return;
      setResults(data.results); setResponse(data);
      setProgress({ search_id: id, visited: data.visited, matched: data.results.length, skipped: data.skipped });
    } catch (e) {
      if (!closed && currentId === id) setError(String(e));
    } finally {
      if (!closed && currentId === id) { currentId = null; setRunning(false); setStopping(false); }
    }
  }

  async function stopSearch() {
    if (!currentId || stopping()) return;
    const id = currentId;
    setStopping(true);
    try { await invoke("search_cancel", { searchId: id }); }
    catch (e) { if (!closed && currentId === id) { setStopping(false); setError(`停止を依頼できませんでした: ${e}`); } }
  }

  function choose(result = results()[cursor()]) {
    if (!result || closed || choosing || running()) return;
    choosing = true;
    props.onChoose(result);
    // Do not expose the opening Enter to the file pane behind this modal.
    queueMicrotask(close);
  }

  const visibleResults = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / RESULT_HEIGHT) - 2);
    const end = Math.min(results().length, start + Math.ceil(viewHeight() / RESULT_HEIGHT) + 4);
    return Array.from({ length: Math.max(0, end - start) }, (_, offset) => ({ item: results()[start + offset], index: start + offset }));
  });
  createEffect(() => {
    const index = cursor();
    if (!resultList) return;
    const top = index * RESULT_HEIGHT;
    if (top < resultList.scrollTop) resultList.scrollTop = top;
    else if (top + RESULT_HEIGHT > resultList.scrollTop + resultList.clientHeight) {
      resultList.scrollTop = top + RESULT_HEIGHT - resultList.clientHeight;
    }
  });

  function handleKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      const controls = Array.from(form.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled):not([tabindex='-1']), [tabindex='0']"));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
      controls[next]?.focus(); return;
    }
    const inResults = event.target instanceof HTMLElement && resultList.contains(event.target);
    if (inResults || !isTypingTarget(event.target) && !(event.target instanceof HTMLButtonElement)) {
      if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(event.key)) {
        event.preventDefault();
        const page = Math.max(1, Math.floor(viewHeight() / RESULT_HEIGHT));
        const next = event.key === "Home" ? 0 : event.key === "End" ? results().length - 1
          : cursor() + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? page : -page);
        setCursor(Math.max(0, Math.min(results().length - 1, next))); resultList.focus();
      } else if (event.key === "Enter") { event.preventDefault(); choose(); }
    }
  }

  return (
    <div class="dialog-overlay" onClick={close}>
      <form ref={form} class="dialog-box search-dialog" role="dialog" aria-modal="true" aria-labelledby="search-title"
        onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}
        onSubmit={(e) => { e.preventDefault(); void startSearch(); }}>
        <h2 class="dialog-title" id="search-title">配下の名前検索</h2>
        <div class="search-root" title={props.rootPath}>{props.rootPath}</div>
        <Show when={remote()}><p class="search-error" role="alert">配下検索はローカルフォルダで利用できます。SFTPの場所では実行できません。</p></Show>
        <label class="settings-field"><span>ファイル名・フォルダ名</span>
          <input ref={queryInput} class="settings-input" value={query()} maxLength={256} disabled={remote()}
            placeholder="部分一致、*.txt、資料?.pdf" onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
        <div class="search-options">
          <label><input type="checkbox" checked={includeFiles()} onChange={(e) => setIncludeFiles(e.currentTarget.checked)} />ファイル</label>
          <label><input type="checkbox" checked={includeDirectories()} onChange={(e) => setIncludeDirectories(e.currentTarget.checked)} />フォルダ</label>
          <span>{props.showHidden ? "隠し項目も検索" : "隠し項目は除外"}・{props.caseSensitive ? "大文字小文字を区別" : "大文字小文字を区別しない"}</span>
        </div>
        <p class="search-hint">名前だけを検索します。* は任意の文字列、? は1文字です。リンクはファイル扱いで表示し、配下は辿りません。最大5,000件です。</p>
        <div class="search-status" role="status" aria-live="polite">
          <Show when={progress()} fallback={running() ? "検索を準備しています…" : "名前を入力して検索してください。"}>
            {(p) => <>{running() ? stopping() ? "停止しています…" : "検索中…" : response()?.cancelled ? "停止しました" : "検索完了"}　{p().visited.toLocaleString()}項目確認・{p().matched.toLocaleString()}件一致
              <Show when={p().skipped > 0}>・読み取り不可など {p().skipped.toLocaleString()}件</Show></>}
          </Show>
        </div>
        <Show when={response()?.truncated}><p class="search-limit" role="status">{response()?.limit_reason === "results" ? "結果が5,000件に達したため検索を停止しました。" : response()?.limit_reason === "depth" ? "フォルダの深さが上限に達したため検索を停止しました。" : "確認項目が100万件に達したため検索を停止しました。"}検索する場所や名前を絞ってください。</p></Show>
        <Show when={error()}><p class="search-error" role="alert">{error()}</p></Show>
        <div ref={resultList} class="search-results" tabindex="0" role="listbox" aria-label="検索結果"
          aria-activedescendant={results().length ? `search-result-${cursor()}` : undefined}
          onScroll={() => setScrollTop(resultList.scrollTop)}>
          <Show when={!running() && response() && results().length === 0}><div class="search-empty">一致する項目はありません。</div></Show>
          <div style={{ height: `${results().length * RESULT_HEIGHT}px`, position: "relative" }}>
            <For each={visibleResults()}>{({ item, index }) => (
              <button type="button" role="option" aria-selected={index === cursor()} id={`search-result-${index}`} tabindex="-1"
                class="search-result" classList={{ "search-result-selected": index === cursor() }}
                style={{ top: `${index * RESULT_HEIGHT}px`, height: `${RESULT_HEIGHT}px` }}
                title={item.path} onClick={() => { setCursor(index); resultList.focus(); }} onDblClick={() => choose(item)}>
                <span class="search-result-name">{item.is_dir ? "/ " : item.is_symlink ? "@ " : ""}{item.name}</span>
                <span class="search-result-path">{item.parent_path}</span>
              </button>
            )}</For>
          </div>
        </div>
        <p class="search-hint">Enter・ダブルクリックで含まれるフォルダを開き、対象へカーソルを合わせます。</p>
        <div class="dialog-buttons">
          <Show when={running()}><button type="button" class="dialog-btn" disabled={stopping()} onClick={() => void stopSearch()}>検索を停止</button></Show>
          <button type="submit" class="dialog-btn" disabled={remote()}>{running() ? "検索し直す" : "検索"}</button>
          <button type="button" class="dialog-btn btn-ok" disabled={running() || !results().length} onClick={() => choose()}>場所を開く</button>
          <button type="button" class="dialog-btn" onClick={close}>閉じる</button>
        </div>
      </form>
    </div>
  );
}
