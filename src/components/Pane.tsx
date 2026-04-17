import type { Component } from "solid-js";
import type { PaneState, Side } from "../types";
import FileList from "./FileList";

interface PaneProps {
  side: Side;
  state: PaneState;
  isActive: boolean;
  onClick?: (index: number, e: MouseEvent) => void;
  onDoubleClick?: (index: number) => void;
  onContextMenu?: (index: number, x: number, y: number) => void;
  onActivate?: () => void;
}

const Pane: Component<PaneProps> = (props) => {
  return (
    <div
      class="pane"
      classList={{ active: props.isActive }}
      onClick={props.onActivate}
    >
      <div class="path-bar" classList={{ "path-active": props.isActive }}>
        <span class="path-text">{props.state.path}</span>
        <span class="path-count">{props.state.files.length} items</span>
      </div>
      <div class="pane-body">
        <FileList
          files={props.state.files}
          cursorIndex={props.state.cursorIndex}
          selectedIndices={props.state.selectedIndices}
          isActive={props.isActive}
          onClick={props.onClick}
          onDoubleClick={props.onDoubleClick}
          onContextMenu={props.onContextMenu}
        />
      </div>
    </div>
  );
};

export default Pane;
