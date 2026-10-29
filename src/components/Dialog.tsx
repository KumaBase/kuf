import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { focusApp } from "../focus";

interface DialogProps {
  type: "confirm" | "input" | "message";
  title: string;
  message: string;
  defaultValue?: string;
  selectStem?: boolean;
  okLabel?: string;
  onOk: (value?: string) => void;
  onCancel: () => void;
}

export default function Dialog(props: DialogProps) {
  const [inputValue, setInputValue] = createSignal(props.defaultValue || "");

  let inputRef!: HTMLInputElement;
  let overlayRef!: HTMLDivElement;

  onMount(() => {
    requestAnimationFrame(() => {
      if (props.type === "input") {
        inputRef?.focus();
        if (!inputRef) return;
        const value = inputRef.value;
        if (props.selectStem) {
          const dot = value.lastIndexOf(".");
          if (dot > 0) inputRef.setSelectionRange(0, dot);
          else inputRef.select();
        } else {
          inputRef.select();
        }
      } else {
        overlayRef?.focus();
      }
    });
  });

  onCleanup(() => {
    focusApp();
  });

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    // Leave Enter/Space on buttons to the browser so Enter on Cancel cancels.
    if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (props.type === "input") {
        props.onOk(inputValue());
      } else if (props.type === "confirm") {
        props.onOk();
      } else {
        props.onOk();
      }
    }
  }

  return (
    <div
      class="dialog-overlay"
      ref={overlayRef}
      tabindex="-1"
      onKeyDown={handleKeyDown}
    >
      <div class="dialog-box">
        <div class="dialog-title">{props.title}</div>
        <div class="dialog-message">{props.message}</div>
        <Show when={props.type === "input"}>
          <input
            ref={inputRef}
            class="dialog-input"
            value={inputValue()}
            onInput={(e) => setInputValue(e.currentTarget.value)}
          />
        </Show>
        <div class="dialog-buttons">
          <Show when={props.type !== "message"}>
            <button class="dialog-btn btn-cancel" onClick={props.onCancel}>
              キャンセル
            </button>
          </Show>
          <button
            class="dialog-btn btn-ok"
            onClick={() => {
              if (props.type === "input") props.onOk(inputValue());
              else props.onOk();
            }}
          >
            <Show when={props.type === "confirm"} fallback={props.okLabel || "OK"}>
              {props.okLabel || "OK"}
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
}
