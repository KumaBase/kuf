export type FilterMode = "smart" | "literal";

export interface FilterMatch {
  score: number;
  /** Matched UTF-16 positions in the original, unnormalized filename. */
  positions: number[];
}

export interface PreparedName {
  readonly name: string;
  readonly normalized: string;
  readonly characters: readonly string[];
  readonly offsets: readonly number[];
  readonly ranges: readonly (readonly [number, number])[];
  readonly boundaries: readonly boolean[];
}

type Segment = { segment: string; index: number };
type SegmenterConstructor = new (
  locales?: string | string[], options?: { granularity: "grapheme" },
) => { segment(value: string): Iterable<Segment> };
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : undefined;
const isWord = (value: string) => /[\p{L}\p{N}]/u.test(value);
const isDigit = (value: string) => /\p{N}/u.test(value);
const isUpper = (value: string) => value.toLowerCase() !== value && value.toUpperCase() === value;
const isLower = (value: string) => value.toUpperCase() !== value && value.toLowerCase() === value;

/** Width, case and kana differences do not require a separate search mode. */
export function normalizeFileFilter(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/ς/g, "σ").replace(/[\u30a1-\u30fa\u30fd\u30fe]/g, (character) => {
    const code = character.charCodeAt(0);
    if (code >= 0x30f7 && code <= 0x30fa) return String.fromCharCode(code - 0x68) + "\u3099";
    return String.fromCharCode(code - 0x60);
  }).normalize("NFC");
}

function segments(value: string): Segment[] {
  if (segmenter) return Array.from(segmenter.segment(value));
  // Older webviews still retain a correct source range for combining marks,
  // halfwidth voiced kana and joined emoji when Intl.Segmenter is unavailable.
  const result: Segment[] = [];
  let index = 0;
  for (const character of value) {
    const previous = result[result.length - 1];
    if (previous && (/\p{M}/u.test(character) || /[\uff9e\uff9f\u200d]/u.test(character) || previous.segment.endsWith("\u200d"))) {
      previous.segment += character;
    } else result.push({ segment: character, index });
    index += character.length;
  }
  return result;
}

function prepareAsciiFileName(name: string): PreparedName {
  const normalized = name.toLowerCase();
  const characters = normalized.split("");
  const offsets: number[] = [], ranges: [number, number][] = [], boundaries: boolean[] = [];
  const upper = (code: number) => code >= 65 && code <= 90;
  const lower = (code: number) => code >= 97 && code <= 122;
  const digit = (code: number) => code >= 48 && code <= 57;
  const word = (code: number) => upper(code) || lower(code) || digit(code);
  for (let index = 0; index < name.length; index++) {
    const current = name.charCodeAt(index);
    const previous = name.charCodeAt(index - 1);
    const next = name.charCodeAt(index + 1);
    offsets.push(index);
    ranges.push([index, index + 1]);
    boundaries.push(index === 0 || !word(previous)
      || (lower(previous) && upper(current))
      || (upper(previous) && upper(current) && lower(next))
      || (word(previous) && word(current) && digit(previous) !== digit(current)));
  }
  offsets.push(name.length);
  return { name, normalized, characters, offsets, ranges, boundaries };
}

/** Prepare once per directory listing, rather than normalizing on each keypress. */
export function prepareFileName(name: string): PreparedName {
  // CRLF is the only ASCII grapheme spanning two code units.
  if (/^[\x00-\x7f]*$/.test(name) && !name.includes("\r\n")) return prepareAsciiFileName(name);
  const chunks = segments(name);
  const compatible = chunks.map(({ segment }) => [...segment.normalize("NFKC")]);
  const characters: string[] = [], offsets: number[] = [];
  const ranges: [number, number][] = [], boundaries: boolean[] = [];
  let normalized = "";
  chunks.forEach((chunk, index) => {
    const current = compatible[index][0] ?? "";
    const previousCharacters = compatible[index - 1];
    const previous = previousCharacters?.[previousCharacters.length - 1] ?? "";
    const next = compatible[index + 1]?.[0] ?? "";
    const boundary = index === 0 || !isWord(previous)
      || (isLower(previous) && isUpper(current))
      || (isUpper(previous) && isUpper(current) && isLower(next))
      || (isWord(previous) && isWord(current) && isDigit(previous) !== isDigit(current));
    const chunkCharacters = [...normalizeFileFilter(chunk.segment)];
    chunkCharacters.forEach((character, withinChunk) => {
      offsets.push(normalized.length);
      normalized += character;
      characters.push(character);
      ranges.push([chunk.index, chunk.index + chunk.segment.length]);
      boundaries.push(withinChunk === 0 && boundary);
    });
  });
  offsets.push(normalized.length);
  return { name, normalized, characters, offsets, ranges, boundaries };
}

function sourcePositions(candidate: PreparedName, indices: Iterable<number>): number[] {
  const positions = new Set<number>();
  for (const index of indices) {
    const range = candidate.ranges[index];
    if (range) for (let position = range[0]; position < range[1]; position++) positions.add(position);
  }
  return [...positions].sort((a, b) => a - b);
}

function spanIndices(candidate: PreparedName, start: number, end: number): number[] {
  const indices: number[] = [];
  for (let index = 0; index < candidate.characters.length; index++) {
    if (candidate.offsets[index] >= end) break;
    if (candidate.offsets[index + 1] > start) indices.push(index);
  }
  return indices;
}

function contiguousMatch(candidate: PreparedName, term: string): FilterMatch | null {
  const value = candidate.normalized;
  const first = value.indexOf(term);
  if (first < 0) return null;
  const extra = Math.min(1000, value.length - term.length);
  if (value === term) return { score: 1_000_000, positions: sourcePositions(candidate, candidate.characters.keys()) };
  if (first === 0) return { score: 900_000 - extra, positions: sourcePositions(candidate, spanIndices(candidate, 0, term.length)) };
  let bestScore = -Infinity, bestStart = first;
  for (let start = first; start >= 0; start = value.indexOf(term, start + 1)) {
    const unit = candidate.offsets.indexOf(start);
    const score = 800_000 + (candidate.boundaries[unit] ? 4000 : 0) - Math.min(2000, start * 4) - extra;
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  return { score: bestScore, positions: sourcePositions(candidate, spanIndices(candidate, bestStart, bestStart + term.length)) };
}

function subsequenceMatch(candidate: PreparedName, term: readonly string[]): FilterMatch | null {
  const value = candidate.characters;
  if (term.length > value.length) return null;
  // Most nonmatches can be rejected without allocating a scoring matrix.
  let matched = 0;
  for (const character of value) if (character === term[matched]) matched++;
  if (matched !== term.length) return null;

  const width = value.length;
  const parents = new Int32Array(width * term.length).fill(-1);
  let previous = new Float64Array(width).fill(-Infinity);
  for (let queryIndex = 0; queryIndex < term.length; queryIndex++) {
    const current = new Float64Array(width).fill(-Infinity);
    let bestPrevious = -Infinity, bestPreviousIndex = -1;
    for (let index = 0; index < width; index++) {
      if (value[index] === term[queryIndex]) {
        const bonus = 10 + (candidate.boundaries[index] ? 32 : 0);
        if (queryIndex === 0) current[index] = bonus - index * 1.5;
        else {
          let score = bestPrevious - (index - 1) * 4;
          let parent = bestPreviousIndex;
          const adjacent = index > 0 ? previous[index - 1] + 28 : -Infinity;
          if (adjacent > score) { score = adjacent; parent = index - 1; }
          if (Number.isFinite(score)) {
            current[index] = score + bonus;
            parents[queryIndex * width + index] = parent;
          }
        }
      }
      const precedingScore = previous[index] + index * 4;
      if (precedingScore > bestPrevious) { bestPrevious = precedingScore; bestPreviousIndex = index; }
    }
    previous = current;
  }
  let best = -Infinity, end = -1;
  for (let index = 0; index < width; index++) if (previous[index] > best) { best = previous[index]; end = index; }
  const indices = new Array<number>(term.length);
  for (let queryIndex = term.length - 1; queryIndex >= 0; queryIndex--) {
    indices[queryIndex] = end;
    end = parents[queryIndex * width + end];
  }
  // Keep this score strictly below continuous matches, regardless of length.
  const quality = Math.max(-1000, Math.min(1000, best / term.length));
  return {
    score: 600_000 + quality * 100 - Math.min(1000, width - term.length),
    positions: sourcePositions(candidate, indices),
  };
}

function expandedMatch(candidate: PreparedName, expression: RegExp): FilterMatch | null {
  expression.lastIndex = 0;
  let best: FilterMatch | null = null;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(candidate.normalized))) {
    if (!match[0].length) {
      // Optional dictionary expansions must never turn an empty regex into a hit.
      expression.lastIndex = match.index + (candidate.normalized.codePointAt(match.index)! > 0xffff ? 2 : 1);
      continue;
    }
    const indices = spanIndices(candidate, match.index, match.index + match[0].length);
    const boundary = candidate.boundaries[indices[0]];
    const score = 600_000 + (match.index === 0 ? 8000 : boundary ? 4000 : 0)
      - Math.min(2000, match.index * 4) - Math.min(1000, candidate.normalized.length - match[0].length);
    if (!best || score > best.score) best = { score, positions: sourcePositions(candidate, indices) };
  }
  return best;
}

function globFilter(pattern: string): (candidate: PreparedName) => FilterMatch | null {
  const tokens = [...pattern];
  return (candidate) => {
    const value = candidate.characters;
    let p = 0, n = 0, star = -1, retry = 0, starHits = 0;
    const hits: number[] = [];
    while (n < value.length) {
      if (tokens[p] === "?" || tokens[p] === value[n]) { hits.push(n); p++; n++; }
      else if (tokens[p] === "*") { star = p++; retry = n; starHits = hits.length; }
      else if (star >= 0) { p = star + 1; n = ++retry; hits.length = starHits; }
      else return null;
    }
    while (tokens[p] === "*") p++;
    // Glob mode retains the directory's normal ordering through equal scores.
    return p === tokens.length ? { score: 0, positions: sourcePositions(candidate, hits) } : null;
  };
}

export function compileFileFilter(
  query: string,
  options: { mode?: FilterMode; expandTerm?: (term: string) => RegExp | null } = {},
): (candidate: PreparedName) => FilterMatch | null {
  const pattern = normalizeFileFilter(query).trim();
  if (!pattern) return () => ({ score: 0, positions: [] });
  if (pattern.includes("*") || pattern.includes("?")) return globFilter(pattern);
  if (options.mode === "literal") return (candidate) => contiguousMatch(candidate, pattern);

  const terms = [...new Set(pattern.split(/\s+/u))].map((value) => {
    const expansion = /^[a-z][a-z'-]*$/.test(value) ? options.expandTerm?.(value) : null;
    return {
      value,
      characters: [...value],
      // Own the regex state and force a full scan when a dictionary returns g/y.
      expansion: expansion ? new RegExp(expansion.source, expansion.flags.replace(/[gy]/g, "") + "g") : null,
    };
  });
  return (candidate) => {
    const whole = contiguousMatch(candidate, pattern);
    if (whole) return { ...whole, score: whole.score + 1_000_000 };
    let score = 0;
    const positions = new Set<number>();
    for (const term of terms) {
      let match = contiguousMatch(candidate, term.value);
      if (!match) {
        match = subsequenceMatch(candidate, term.characters);
        const expanded = term.expansion && expandedMatch(candidate, term.expansion);
        if (expanded && (!match || expanded.score > match.score)) match = expanded;
      }
      if (!match) return null;
      score += match.score;
      for (const position of match.positions) positions.add(position);
    }
    return { score: score / terms.length, positions: [...positions].sort((a, b) => a - b) };
  };
}

/** Compatibility helper for callers that only need the hit/no-hit result. */
export function fileMatcher(query: string): (name: string) => boolean {
  const match = compileFileFilter(query);
  return (name) => match(prepareFileName(name)) !== null;
}
