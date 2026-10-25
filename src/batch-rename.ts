import type { FileInfo } from "./types";

export interface RenamePlanItem { from: string; to: string; }
export interface BatchRenameResult {
  completed: RenamePlanItem[]; pending: RenamePlanItem[]; unchanged: RenamePlanItem[];
  error: string | null; cancelled: boolean;
}
export interface RenameOptions {
  mode: "replace" | "affix" | "sequence";
  find: string; replacement: string; prefix: string; suffix: string;
  start: number; step: number; padding: number;
}
export const DEFAULT_RENAME_OPTIONS: RenameOptions = {
  mode: "replace", find: "", replacement: "", prefix: "", suffix: "", start: 1, step: 1, padding: 3,
};
export interface RenamePreviewRow extends RenamePlanItem { changed: boolean; error: string; }
export interface RenamePreview { rows: RenamePreviewRow[]; plan: RenamePlanItem[]; errors: string[]; }

function splitName(file: FileInfo): [string, string] {
  if (file.is_dir) return [file.name, ""];
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && dot < file.name.length - 1 ? [file.name.slice(0, dot), file.name.slice(dot)] : [file.name, ""];
}

function invalidName(name: string, windowsNames: boolean): string {
  if (!name.trim() || name.trim() === "." || name.trim() === ".." || /[/\\\0]/.test(name)) return "名前に空欄・親フォルダー・パス区切りは指定できません。";
  if ((windowsNames ? name.length : new TextEncoder().encode(name).length) > 255) return "名前が長すぎます。";
  const stem = name.split(".")[0].trimEnd();
  if (windowsNames && (/[<>:"|?*\x00-\x1f]/.test(name) || /[ .]$/.test(name)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(stem))) return "Windowsで使えない名前です。";
  return "";
}

export function buildRenamePreview(
  files: readonly FileInfo[], existingFiles: readonly FileInfo[], options: RenameOptions, windowsNames = false,
): RenamePreview {
  const errors: string[] = [];
  if (!files.length || files.length > 10_000) errors.push("対象は1〜10,000件にしてください。");
  if (options.mode === "replace" && !options.find) errors.push("置換する文字列を入力してください。");
  if (options.mode === "sequence" && (!Number.isSafeInteger(options.start) || options.start < 0
    || !Number.isSafeInteger(options.step) || options.step < 1 || !Number.isInteger(options.padding) || options.padding < 1 || options.padding > 12
    || !Number.isSafeInteger(options.start + Math.max(0, files.length - 1) * options.step))) errors.push("連番は開始0以上・増分1以上の整数、桁数は1〜12で指定してください。");
  const rows = files.map((file, index): RenamePreviewRow => {
    const [stem, extension] = splitName(file);
    let next = stem;
    if (options.mode === "replace" && options.find) next = stem.split(options.find).join(options.replacement);
    else if (options.mode === "affix") next = `${options.prefix}${stem}${options.suffix}`;
    else if (options.mode === "sequence") next = `${options.prefix}${String(options.start + index * options.step).padStart(Math.max(1, Math.min(12, options.padding || 1)), "0")}${options.suffix}`;
    const to = next + extension;
    return { from: file.name, to, changed: file.name !== to, error: invalidName(file.name, windowsNames) || invalidName(to, windowsNames) };
  });
  // Match backend's conservative duplicate rule on all platforms. It avoids
  // guessing whether this directory's volume supports case-distinct names.
  const key = (name: string) => name.toLowerCase();
  const sources = new Map<string, number>();
  const targets = new Map<string, number>();
  const existing = new Map<string, FileInfo[]>();
  for (const file of existingFiles) {
    if (file.name === "..") continue;
    const existingKey = windowsNames ? key(file.name) : file.name;
    const group = existing.get(existingKey);
    if (group) group.push(file); else existing.set(existingKey, [file]);
  }
  for (const [index, row] of rows.entries()) {
    if (sources.has(key(row.from))) row.error ||= "大文字・小文字だけが異なる対象の同時処理には対応していません。";
    sources.set(key(row.from), index);
    const duplicate = targets.get(key(row.to));
    if (duplicate !== undefined) {
      row.error ||= "変更後の名前が重複します。";
      rows[duplicate].error ||= "変更後の名前が重複します。";
    }
    targets.set(key(row.to), index);
    if (!row.changed) continue;
    const collision = existing.get(windowsNames ? key(row.to) : row.to)?.some((file) =>
      !(windowsNames && key(row.from) === key(row.to) && file.name === row.from));
    if (collision) row.error ||= "既存の項目と衝突します。入れ替え・循環リネームには対応していません。";
  }
  for (const row of rows) if (row.error) errors.push(`${row.from}: ${row.error}`);
  return { rows, plan: rows.map(({ from, to }) => ({ from, to })), errors };
}
