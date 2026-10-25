import { createEffect, Show, type Component } from "solid-js";
import type { PaneState, Side, SortSpec } from "../types";
import { SORT_LABELS } from "../commands";
import FileList from "./FileList";
import { focusApp } from "../focus";
import type { FilterMode } from "../filter";
import { migemoStatus } from "../migemo";

interface PaneProps {
  side: Side;
  state: PaneState;
  isActive: boolean;
  sort: SortSpec;
  onSort: () => void;
  loading?: boolean;
  loadError?: string;
  watchError?: string;
  filterOpen: boolean;
  filterQuery: string;
  filterMode: FilterMode;
  filterHighlights: ReadonlyMap<string, readonly number[]>;
  totalCount: number;
  onFilterChange: (query: string) => void;
  onFilterModeChange: (mode: FilterMode) => void;
  onFilterClose: () => void;
  onFilterFocus: () => void;
  onFilterCommit: () => void;
  onClick?: (index: number, e: MouseEvent) => void;
  onDoubleClick?: (index: number) => void;
  onContextMenu?: (index: number, x: number, y: number) => void;
  onActivate?: () => void;
}

const Pane: Component<PaneProps> = (props) => {
  let filterInput: HTMLInputElement | undefined;
  createEffect(() => {
    if (props.filterOpen && props.isActive) queueMicrotask(() => filterInput?.focus());
  });
  const filteredCount = () => props.state.files.filter((file) => file.name !== "..").length;
  return (
    <div
      class="pane"
      aria-busy={props.loading}
      classList={{ active: props.isActive }}
      onMouseDown={props.onActivate}
    >
      <div class="path-bar" classList={{ "path-active": props.isActive }}>
        <span class="path-text">{props.state.path}</span>
        <button
          type="button"
          class="pane-sort"
          aria-label={`${props.side === "left" ? "左" : "右"}ペインのソート: ${SORT_LABELS[props.sort.key]}・${props.sort.order === "asc" ? "昇順" : "降順"}`}
          title="並び順を変更"
          onClick={props.onSort}
        >{SORT_LABELS[props.sort.key]} {props.sort.order === "asc" ? "↑" : "↓"}</button>
        <span class="path-count" role="status">{props.loading ? "読み込み中…" : `${props.state.files.length} items`}</span>
      </div>
      <Show when={props.filterOpen || props.filterQuery}>
        <div class="pane-filter" onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && !e.isComposing) {
            e.preventDefault(); props.onFilterClose(); focusApp();
          }
        }}>
          <input
            ref={filterInput}
            aria-label={`${props.side === "left" ? "左" : "右"}ペインの絞り込み`}
            placeholder={props.filterMode === "smart" ? "あいまい・ローマ字で絞り込み（例: nihon / usrctrl）" : "名前で絞り込み（部分一致 / *.txt）"}
            title={props.filterMode === "smart" ? "文字を飛ばした一致やローマ字で検索できます。空白で区切るとすべての語を含む名前に絞り込みます。*.txt などのワイルドカードも使えます。" : "入力した文字を含む名前に絞り込みます。*.txt などのワイルドカードも使えます。"}
            value={props.filterQuery}
            maxLength={128}
            onFocus={props.onFilterFocus}
            onInput={(e) => props.onFilterChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.isComposing) return;
              if (e.key === "Escape") { e.preventDefault(); props.onFilterClose(); focusApp(); }
              else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault(); props.onFilterCommit(); focusApp();
              }
            }}
          />
          <button
            type="button"
            class="filter-mode"
            aria-label="あいまい検索"
            aria-pressed={props.filterMode === "smart"}
            title={props.filterMode === "smart" ? "あいまい検索中。押すと部分一致に切り替えます。" : "部分一致で検索中。押すとあいまい検索に切り替えます。"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              props.onFilterModeChange(props.filterMode === "smart" ? "literal" : "smart");
              filterInput?.focus();
            }}
          >{props.filterMode === "smart" ? "あいまい" : "部分一致"}</button>
          <Show when={props.filterMode === "smart" && migemoStatus() !== "idle"}>
            <span
              class="filter-dictionary"
              classList={{ "dictionary-error": migemoStatus() === "error" }}
              role="status"
              title={migemoStatus() === "error" ? "日本語辞書を読み込めませんでした。日本語の直接入力や、英数字のあいまい検索は使えます。" : migemoStatus() === "loading" ? "日本語の名前をローマ字で検索する準備中です。" : "ローマ字から日本語の名前も検索できます。"}
            >{migemoStatus() === "loading" ? "日本語辞書…" : migemoStatus() === "ready" ? "Migemo" : "日本語辞書なし"}</span>
          </Show>
          <span class="filter-count" role="status">{filteredCount()} / {props.totalCount} 件</span>
          <button type="button" class="filter-clear" aria-label="絞り込みを解除" onClick={() => { props.onFilterClose(); focusApp(); }}>×</button>
        </div>
      </Show>
      <Show when={props.filterQuery && filteredCount() === 0}>
        <div class="filter-empty" role="status">一致する項目がありません</div>
      </Show>
      <div class="pane-body">
        <Show when={props.watchError && !props.loadError}>
          <div class="pane-load-error" role="status">この場所は自動更新できません。Ctrl+R で更新できます。</div>
        </Show>
        <Show when={props.loadError}>
          <div class="pane-load-error" role="status">読み込めませんでした。接続・場所を確認して Ctrl+R で再試行してください。<br />{props.loadError}</div>
        </Show>
        <FileList
          files={props.state.files}
          cursorIndex={props.state.cursorIndex}
          selectedIndices={props.state.selectedIndices}
          isActive={props.isActive}
          matchHighlights={props.filterHighlights}
          onClick={props.onClick}
          onDoubleClick={props.onDoubleClick}
          onContextMenu={props.onContextMenu}
        />
      </div>
    </div>
  );
};

export default Pane;
