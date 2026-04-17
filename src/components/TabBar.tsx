import { For, Show } from "solid-js";
import type { TabSnapshot } from "../types";
import { pathLabel } from "../types";

export default function TabBar(props: {
  tabs: TabSnapshot[];
  activeIndex: number;
  onSwitch: (index: number) => void;
  onClose: (index: number) => void;
  onNew: () => void;
}) {
  return (
    <div class="tab-bar">
      <For each={props.tabs}>
        {(tab, index) => (
          <div
            classList={{
              "tab-item": true,
              "tab-active": index() === props.activeIndex,
            }}
            onClick={() => props.onSwitch(index())}
          >
            <span class="tab-label">{pathLabel(tab.left.path)}</span>
            <Show when={props.tabs.length > 1}>
              <span
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(index());
                }}
              >
                x
              </span>
            </Show>
          </div>
        )}
      </For>
      <div class="tab-new" onClick={props.onNew}>
        +
      </div>
    </div>
  );
}
