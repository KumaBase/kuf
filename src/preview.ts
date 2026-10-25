export type PreviewEncoding = "auto" | "utf-8" | "shift_jis" | "euc-jp" | "utf-16le" | "utf-16be";
export const PREVIEW_ENCODINGS: Record<PreviewEncoding, string> = {
  auto: "自動判別", "utf-8": "UTF-8", shift_jis: "Shift_JIS", "euc-jp": "EUC-JP", "utf-16le": "UTF-16 LE", "utf-16be": "UTF-16 BE",
};
export interface PreviewBytes { data_base64: string; size: number; }
export interface DecodedPreview {
  text: string;
  encoding: Exclude<PreviewEncoding, "auto">;
  estimated: boolean;
  binary: boolean;
  hadErrors: boolean;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function strictText(bytes: Uint8Array, encoding: string): string | null {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { return null; }
}
function hasBinaryControls(text: string): boolean {
  const sample = text.slice(0, 8192);
  if (sample.includes("\0")) return true;
  let controls = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) controls++;
  }
  return controls > sample.length * 0.02;
}
function japaneseScore(text: string): number {
  let score = 0;
  for (const character of text.slice(0, 8192)) {
    const code = character.charCodeAt(0);
    if (code >= 0x3040 && code <= 0x30ff) score += 3;
    else if (code >= 0x4e00 && code <= 0x9fff) score++;
    else if (code >= 0xff61 && code <= 0xff9f) score -= 2;
  }
  return score;
}

export function decodePreview(bytes: Uint8Array, requested: PreviewEncoding = "auto"): DecodedPreview {
  let encoding: Exclude<PreviewEncoding, "auto"> = requested === "auto" ? "utf-8" : requested;
  let estimated = false;
  let binary = false;
  if (requested === "auto") {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
    else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
      const sample = bytes.subarray(0, 512);
      let evenZero = 0, oddZero = 0;
      for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
      const pairs = Math.floor(sample.length / 2);
      if (pairs >= 4 && oddZero / pairs > 0.3 && evenZero / pairs < 0.1) { encoding = "utf-16le"; estimated = true; }
      else if (pairs >= 4 && evenZero / pairs > 0.3 && oddZero / pairs < 0.1) { encoding = "utf-16be"; estimated = true; }
      else if (strictText(bytes, "utf-8") === null) {
        const sjis = strictText(bytes, "shift_jis");
        const euc = strictText(bytes, "euc-jp");
        estimated = true;
        if (sjis !== null && (euc === null || japaneseScore(sjis) >= japaneseScore(euc))) encoding = "shift_jis";
        else if (euc !== null) encoding = "euc-jp";
        else binary = true;
      }
    }
  }
  const strict = strictText(bytes, encoding);
  const text = strict ?? new TextDecoder(encoding).decode(bytes);
  if (requested === "auto" && hasBinaryControls(text)) binary = true;
  return { text, encoding, estimated, binary, hadErrors: strict === null };
}

export interface TextMatch { start: number; end: number; }
export function findTextMatches(text: string, query: string, maximum = 2000): { matches: TextMatch[]; limited: boolean } {
  if (!query) return { matches: [], limited: false };
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escaped, "giu");
  const matches: TextMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    if (matches.length >= maximum) return { matches, limited: true };
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return { matches, limited: false };
}

export function formatHexPage(bytes: Uint8Array, offset = 0, pageSize = 16 * 1024): string {
  const end = Math.min(bytes.length, offset + pageSize);
  const lines: string[] = [];
  for (let start = offset; start < end; start += 16) {
    const row = bytes.subarray(start, Math.min(start + 16, end));
    const hex = Array.from(row, (value) => value.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = Array.from(row, (value) => value >= 32 && value <= 126 ? String.fromCharCode(value) : ".").join("");
    lines.push(`${start.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines.join("\n");
}

export const PREVIEW_IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
};
