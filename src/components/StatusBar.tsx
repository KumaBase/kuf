import { Show, type Component } from "solid-js";
import type { PaneState } from "../types";
import { formatSize } from "../types";

interface StatusBarProps {
  leftState: PaneState;
  rightState: PaneState;
  activeSide: "left" | "right";
  statusMessage: string;
  searchQuery: string;
}

const StatusBar: Component<StatusBarProps> = (props) => {
  const activeState = () =>
    props.activeSide === "left" ? props.leftState : props.rightState;

  const cursorFile = () => {
    const s = activeState();
    if (s.cursorIndex >= 0 && s.cursorIndex < s.files.length) {
      return s.files[s.cursorIndex];
    }
    return null;
  };

  return (
    <div class="status-bar">
      <span class="status-info" classList={{ "status-busy": props.statusMessage.endsWith("...") }}>
        {props.statusMessage ||
          (cursorFile()
            ? `${cursorFile()!.name}${
                cursorFile()!.is_dir
                  ? ""
                  : ` ｜ ${formatSize(cursorFile()!.size)}`
              }${
                cursorFile()!.modified
                  ? ` ｜ ${cursorFile()!.modified}`
                  : ""
              }`
            : "")}
      </span>
      <Show when={props.searchQuery}>
        <span class="status-search">検索: {props.searchQuery}</span>
      </Show>
      <span class="status-selected">
        {activeState().selectedIndices.length > 0
          ? `${activeState().selectedIndices.length} 件選択 ｜ ${formatSize(activeState().selectedIndices.reduce((total, index) => total + (activeState().files[index]?.is_dir ? 0 : activeState().files[index]?.size ?? 0), 0))}（ファイル合計）`
          : ""}
      </span>
      <span class="status-cursor">
        {activeState().files.length > 0
          ? `${activeState().cursorIndex + 1}/${activeState().files.length}`
          : "0"}
      </span>
    </div>
  );
};

export default StatusBar;
