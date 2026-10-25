import { createSignal, onMount, onCleanup } from "solid-js";
import { baseName } from "../types";
import { focusApp } from "../focus";

export interface ArchiveDialogProps {
  mode: "create" | "extract";
  target: string;
  sources: string[];
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export default function ArchiveDialog(props: ArchiveDialogProps) {
  const creating = props.mode === "create";
  const sourceName = props.sources.length === 1 ? baseName(props.sources[0]) : "選択ファイル";
  const stem = sourceName.replace(/\.zip$/i, "") || "展開ファイル";
  const [name, setName] = createSignal(creating ? `${sourceName}.zip` : stem);
  const [error, setError] = createSignal("");
  let inputRef!: HTMLInputElement;
  let dialogRef!: HTMLDivElement;
  let submitted = false;

  onMount(() => {
    inputRef?.focus();
    if (creating) inputRef?.setSelectionRange(0, Math.max(0, name().length - 4));
    else inputRef?.select();
  });
  onCleanup(() => focusApp());

  function submit() {
    if (submitted) return;
    const value = name().trim();
    if (!value || value === "." || value === ".." || /[\\/:<>"|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value)) {
      setError("パスを含まない、新しい名前を指定してください。");
      return;
    }
    if (creating && (!/\.zip$/i.test(value) || value.length <= 4)) {
      setError("ZIP名は .zip で終わる名前にしてください。");
      return;
    }
    submitted = true;
    props.onSubmit(value);
  }

  return (
    <div class="dialog-overlay" onClick={props.onClose} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
      else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); submit(); }
      else if (event.key === "Tab") {
        event.preventDefault();
        const controls = Array.from(dialogRef.querySelectorAll<HTMLElement>("input, button"));
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
    }}>
      <div ref={dialogRef} class="dialog-box" role="dialog" aria-modal="true" aria-label={creating ? "ZIPを作成" : "ZIPを展開"} onClick={(event) => event.stopPropagation()}>
        <div class="dialog-title">{creating ? "ZIPを作成" : "ZIPを展開"}</div>
        <div class="dialog-message">
          {creating ? `${props.sources.length}件をZIPにまとめます。` : `${sourceName}を新しいフォルダに展開します。`}
          <br />{creating ? "作成先" : "展開先の親フォルダ"}: {props.target}
          <br />既存の名前には上書きしません。
        </div>
        <label>
          <span>{creating ? "新しいZIP名" : "新しいフォルダ名"}</span>
          <input ref={inputRef} class="dialog-input" value={name()} maxLength={255}
            onInput={(event) => { setName(event.currentTarget.value); setError(""); }} />
        </label>
        <div role="status" style={{ color: "var(--color-error, var(--text-primary))", "min-height": "1.5em" }}>{error()}</div>
        <div class="dialog-buttons">
          <button type="button" class="dialog-btn btn-cancel" onClick={props.onClose}>キャンセル</button>
          <button type="button" class="dialog-btn btn-ok" onClick={submit}>{creating ? "作成" : "展開"}</button>
        </div>
      </div>
    </div>
  );
}
