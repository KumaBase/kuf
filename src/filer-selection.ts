import type { FileInfo } from "./types";

export type PatternSelectionMode = "replace" | "add" | "remove";
export type CompareMode = "missing" | "different" | "newer";

const selectable = (file: FileInfo | undefined) => !!file && file.name !== "..";

function wildcardMatches(name: string, pattern: string, caseSensitive: boolean): boolean {
  const letters = [...(caseSensitive ? name : name.toLowerCase())];
  const mask = [...(caseSensitive ? pattern : pattern.toLowerCase())];
  let letter = 0, token = 0, star = -1, retry = 0;
  while (letter < letters.length) {
    if (token < mask.length && (mask[token] === "?" || mask[token] === letters[letter])) { letter++; token++; }
    else if (mask[token] === "*") { star = token++; retry = letter; }
    else if (star >= 0) { token = star + 1; letter = ++retry; }
    else return false;
  }
  while (mask[token] === "*") token++;
  return token === mask.length;
}

export function rangeSelection(files: readonly FileInfo[], anchor: number, target: number): number[] {
  if (!files.length) return [];
  const start = Math.max(0, Math.min(anchor, target));
  const end = Math.min(files.length - 1, Math.max(anchor, target));
  const result: number[] = [];
  for (let index = start; index <= end; index++) if (selectable(files[index])) result.push(index);
  return result;
}

export function selectByKind(files: readonly FileInfo[], kind: "files" | "directories"): number[] {
  return files.flatMap((file, index) => selectable(file) && file.is_dir === (kind === "directories") ? [index] : []);
}

export function applyPatternSelection(
  files: readonly FileInfo[], selected: readonly number[], pattern: string,
  mode: PatternSelectionMode, caseSensitive: boolean,
): number[] {
  if (!pattern || pattern.length > 128) throw new Error("選択条件は1〜128文字で入力してください。");
  const marked = new Set(mode === "replace" ? [] : selected.filter((index) => selectable(files[index])));
  files.forEach((file, index) => {
    if (!selectable(file) || !wildcardMatches(file.name, pattern, caseSensitive)) return;
    if (mode === "remove") marked.delete(index);
    else marked.add(index);
  });
  return [...marked].sort((a, b) => a - b);
}

function timestamp(file: FileInfo): number | null {
  return typeof file.modified_timestamp === "number" && Number.isFinite(file.modified_timestamp)
    ? file.modified_timestamp : null;
}

// This compares visible file metadata only. It never reads file contents.
export function compareFilesForSelection(
  source: readonly FileInfo[], target: readonly FileInfo[], mode: CompareMode, caseSensitive: boolean,
): number[] {
  const key = (name: string) => caseSensitive ? name : name.toLowerCase();
  const other = new Map<string, FileInfo[]>();
  for (const file of target) {
    if (file.is_dir || !selectable(file)) continue;
    const normalized = key(file.name);
    const group = other.get(normalized);
    if (group) group.push(file);
    else other.set(normalized, [file]);
  }
  return source.flatMap((file, index) => {
    if (file.is_dir || !selectable(file)) return [];
    const candidates = other.get(key(file.name));
    if (mode === "missing") return candidates ? [] : [index];
    if (!candidates) return [];
    const time = timestamp(file);
    // When case folding yields multiple candidates, require the condition to
    // hold for every candidate rather than guessing which file is its peer.
    const matches = candidates.every((candidate) => {
      const otherTime = timestamp(candidate);
      if (mode === "newer") return time !== null && otherTime !== null && time > otherTime;
      return file.size !== candidate.size || time !== null && otherTime !== null && time !== otherTime;
    });
    return matches ? [index] : [];
  });
}
