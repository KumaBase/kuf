import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  For,
} from "solid-js";
import type { FileInfo } from "../types";
import { formatSize } from "../types";
import { rowHeight, settings } from "../state";

interface FileListProps {
  files: FileInfo[];
  cursorIndex: number;
  selectedIndices: number[];
  isActive: boolean;
  matchHighlights?: ReadonlyMap<string, readonly number[]>;
  onClick?: (index: number, e: MouseEvent) => void;
  onDoubleClick?: (index: number) => void;
  onContextMenu?: (index: number, x: number, y: number) => void;
}

interface HighlightedNameProps {
  text: string;
  positions?: readonly number[];
  offset?: number;
}

function HighlightedName(props: HighlightedNameProps) {
  const segments = createMemo(() => {
    const positions = new Set(props.positions);
    const result: { text: string; matched: boolean }[] = [];
    let offset = props.offset ?? 0;
    // Iterate by code point so a highlight can never split a surrogate pair.
    for (const character of props.text) {
      const matched = positions.has(offset) || (character.length === 2 && positions.has(offset + 1));
      const previous = result[result.length - 1];
      if (previous?.matched === matched) previous.text += character;
      else result.push({ text: character, matched });
      offset += character.length;
    }
    return result;
  });
  return <For each={segments()}>{(segment) => segment.matched ? <mark class="filter-match">{segment.text}</mark> : segment.text}</For>;
}

export default function FileList(props: FileListProps) {
  let containerRef!: HTMLDivElement;
  let scrollTick = false;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [containerHeight, setContainerHeight] = createSignal(400);

  const rh = () => rowHeight();
  const cols = () => settings()?.display.columns ?? ["extension", "size", "date", "permissions"];
  const extVisible = () => cols().includes("extension");
  const selected = createMemo(() => new Set(props.selectedIndices));

  const visibleRange = createMemo(() => {
    const h = rh();
    const start = Math.max(0, Math.floor(scrollTop() / h) - 2);
    const end = Math.min(
      props.files.length,
      start + Math.ceil(containerHeight() / h) + 4
    );
    return { start, end };
  });

  const visibleIndices = createMemo(() => {
    const { start, end } = visibleRange();
    const indices: number[] = [];
    for (let i = start; i < end; i++) indices.push(i);
    return indices;
  });

  function onScroll() {
    if (!scrollTick) {
      scrollTick = true;
      requestAnimationFrame(() => {
        setScrollTop(containerRef.scrollTop);
        scrollTick = false;
      });
    }
  }

  // Keep cursor visible
  createEffect(() => {
    const h = rh();
    const cursor = props.cursorIndex;
    const top = cursor * h;
    const bottom = top + h;
    const viewTop = containerRef.scrollTop;
    const viewBottom = viewTop + containerRef.clientHeight;

    if (top < viewTop) {
      containerRef.scrollTop = top;
    } else if (bottom > viewBottom) {
      containerRef.scrollTop = bottom - containerRef.clientHeight;
    }
  });

  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());
  });

  return (
    <div ref={containerRef} class="file-list" onScroll={onScroll}>
      <div
        style={{
          height: `${props.files.length * rh()}px`,
          position: "relative",
        }}
      >
        <For each={visibleIndices()}>
          {(index) => {
            const file = () => props.files[index];
            const nameEnd = () => extVisible() && file().extension
              ? file().name.length - file().extension.length - 1
              : file().name.length;
            const highlights = () => props.matchHighlights?.get(file().name);
            return (
              <div
                class="file-row"
                classList={{
                  "cursor-active":
                    index === props.cursorIndex && props.isActive,
                  "cursor-inactive":
                    index === props.cursorIndex && !props.isActive,
                  selected: selected().has(index),
                }}
                style={{
                  position: "absolute",
                  top: `${index * rh()}px`,
                  height: `${rh()}px`,
                  width: "100%",
                }}
                onClick={(e) => props.onClick?.(index, e)}
                onDblClick={() => props.onDoubleClick?.(index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onContextMenu?.(index, e.clientX, e.clientY);
                }}
              >
                <span class="row-icon">
                  {file().is_dir ? "/" : file().is_symlink ? "@" : " "}
                </span>
                <span
                  class="row-name"
                  classList={{
                    "name-dir": file().is_dir,
                    "name-hidden": file().is_hidden && !file().is_dir,
                    "name-symlink": file().is_symlink,
                  }}
                >
                  <HighlightedName text={file().name.slice(0, nameEnd())} positions={highlights()} />
                </span>
                <For each={cols()}>
                  {(col) => {
                    switch (col) {
                      case "extension":
                        return <span class="row-extension"><HighlightedName text={file().extension ? `.${file().extension}` : ""} positions={highlights()} offset={file().name.length - file().extension.length - 1} /></span>;
                      case "size":
                        return <span class="row-size">{file().is_dir ? "" : formatSize(file().size)}</span>;
                      case "date":
                        return <span class="row-date">{file().modified || ""}</span>;
                      case "permissions":
                        return <span class="row-permissions">{file().permissions}</span>;
                      default:
                        return null;
                    }
                  }}
                </For>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
