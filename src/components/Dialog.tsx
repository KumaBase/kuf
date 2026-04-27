import { createSignal, onMount, onCleanup, Show } from "solid-js";

interface DialogProps {
  type: "confirm" | "input" | "message";
  title: string;
  message: string;
  defaultValue?: string;
  onOk: (value?: string) => void;
  onCancel: () => void;
}

export default function Dialog(props: DialogProps) {
  const [inputValue, setInputValue] = createSignal(props.defaultValue || "");

  let inputRef!: HTMLInputElement;

  onMount(() => {
    if (props.type === "input") {
      setTimeout(() => inputRef?.focus(), 0);
    }
  });

  onCleanup(() => {
    document.querySelector<HTMLElement>(".app")?.focus();
  });

  function handleKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      props.onCancel();
    } else if (e.key === "Enter") {
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
    <div class="dialog-overlay" onKeyDown={handleKeyDown}>
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
              Cancel
            </button>
          </Show>
          <button
            class="dialog-btn btn-ok"
            onClick={() => {
              if (props.type === "input") props.onOk(inputValue());
              else props.onOk();
            }}
          >
            <Show when={props.type === "confirm"} fallback="OK">
              OK
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
}
