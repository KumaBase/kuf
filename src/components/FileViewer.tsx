import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
]);

function isImage(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

export default function FileViewer(props: {
  path: string;
  fileName: string;
  extension: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [textContent, setTextContent] = createSignal("");
  const imageMode = isImage(props.extension);
  const [imageSrc, setImageSrc] = createSignal("");

  onMount(async () => {
    if (imageMode) {
      try {
        const src = convertFileSrc(props.path);
        setImageSrc(src);
      } catch (e) {
        setError(String(e));
      }
      setLoading(false);
    } else {
      try {
        const content = await invoke<string>("read_file_text", {
          path: props.path,
        });
        setTextContent(content);
      } catch (e) {
        setError(String(e));
      }
      setLoading(false);
    }
  });

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div
        class="file-viewer"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="file-viewer-header">
          <span class="file-viewer-title">{props.fileName}</span>
          <button class="file-viewer-close" onClick={props.onClose}>
            Esc
          </button>
        </div>
        <div class="file-viewer-body">
          <Show when={loading()}>
            <div class="file-viewer-loading">Loading...</div>
          </Show>
          <Show when={!loading() && error()}>
            <div class="file-viewer-error">{error()}</div>
          </Show>
          <Show when={!loading() && !error() && !imageMode}>
            <pre class="file-viewer-text">{textContent()}</pre>
          </Show>
          <Show when={!loading() && !error() && imageMode}>
            <img class="file-viewer-image" src={imageSrc()} alt={props.fileName} />
          </Show>
        </div>
      </div>
    </div>
  );
}
