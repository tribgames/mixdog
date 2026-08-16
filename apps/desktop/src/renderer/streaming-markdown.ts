import remarkParse from "remark-parse";
import { unified } from "unified";

export interface StreamingMarkdownCache {
  stableText: string;
  stableChunks: string[];
  stableChunkKeys: string[];
  sourceText: string;
  scanOffset: number;
  fenceMarker: string;
  fenceLength: number;
  boundaries: number[];
  scannedCharacters: number;
}

export interface StreamingMarkdownParts {
  stableChunks: readonly string[];
  stableChunkKeys: readonly string[];
  unstableText: string;
  unstableKey: string;
  parseUnstable: boolean;
}

/* Safety valve, not a rendering mode. The streaming projection normally has
 * no size cap: every projection
 * re-lexes the whole response, freezes all but the last token, and heals that
 * last token so it is always parsed. Our 8 KiB cap fired on ordinary output —
 * one long list or an open fence has no stable boundary, so the whole tail
 * crossed it mid-stream and the reader watched raw `**`/`##` markers appear
 * (user: 스크립트 완성되기 전에 원문이 나온다). 64 KiB only guards against a
 * pathological unbounded tail; below it the tail always parses, and above it
 * the renderer now holds the last completed parse instead of dropping to
 * source (StreamingMarkdownBody). */
export const MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS = 64 * 1024;
const STREAM_APPEND_PROBE_CHARS = 128;
const nonPlainTextMarkdownSyntax = /[\\`*_[\]<>|&$]/;
const gfmAutolink = /\b(?:https?:\/\/|www\.)/i;
const gfmStrikethrough = /~~/;
const blockMarkdownSyntax = /(^|\n)\s{0,3}(?:#{1,6}\s|>\s?|[-+]\s|\d+[.)]\s|---+\s*$)/;
const streamingBlockParser = unified().use(remarkParse);
const healableMarkdownSyntax = /[`*_~[]/;
const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fencedBlock = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm;
const inlineCodeSpan = /`+[^`\n]*`+/g;
const emphasisMarkers = new Set(["*", "_", "~"]);
const markdownPunctuation = /[!-/:-@[-`{-~\u00A1-\u00BF\u2010-\u2027\u2030-\u205E]/;

function hasOpenFence(text: string): boolean {
  let marker = "";
  let length = 0;
  for (const rawLine of text.split("\n")) {
    const fence = fenceLine.exec(rawLine.replace(/\r$/, ""));
    if (!fence) continue;
    const marks = fence[1];
    if (!marker) {
      marker = marks[0];
      length = marks.length;
    } else if (marks[0] === marker && marks.length >= length && !fence[2].trim()) {
      marker = "";
      length = 0;
    }
  }
  return Boolean(marker);
}

function closeInlineCode(text: string): string {
  let open = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character !== "`") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && text[end] === "`") end += 1;
    const run = end - index;
    if (!open) open = run;
    else if (run === open) open = 0;
    index = end;
  }
  return open > 0 ? `${text}${"`".repeat(open)}` : text;
}

// Delimiter counting must ignore code, where "**" and "__" are ordinary
// characters. Masking preserves length, so it stays a pure counting aid.
function maskCode(text: string): string {
  fencedBlock.lastIndex = 0;
  return text
    .replace(fencedBlock, (block) => block.replace(/[^\n]/g, " "))
    .replace(inlineCodeSpan, (span) => " ".repeat(span.length));
}

interface EmphasisRun {
  marker: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
}

function isMarkdownSpace(character: string): boolean {
  return !character || /\s/.test(character);
}

function isMarkdownPunctuation(character: string): boolean {
  return Boolean(character) && markdownPunctuation.test(character);
}

// CommonMark flanking rules, so a literal "2 * 3", a "* item" bullet, or an
// intraword snake_case never counts as an unfinished emphasis delimiter.
// Plain parity counting healed all three into visible junk markers.
function scanEmphasisRuns(masked: string): EmphasisRun[] {
  const runs: EmphasisRun[] = [];
  for (let index = 0; index < masked.length;) {
    const marker = masked[index];
    if (marker === "\\") {
      index += 2;
      continue;
    }
    if (!emphasisMarkers.has(marker)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (masked[end] === marker) end += 1;
    const length = end - index;
    const before = index > 0 ? masked[index - 1] : "";
    const after = end < masked.length ? masked[end] : "";
    const beforeSpace = isMarkdownSpace(before);
    const afterSpace = isMarkdownSpace(after);
    const beforePunctuation = isMarkdownPunctuation(before);
    const afterPunctuation = isMarkdownPunctuation(after);
    const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    if (marker === "~") {
      // GFM strikethrough only exists as a pair.
      if (length >= 2) runs.push({ marker, length: 2, canOpen: left, canClose: right });
    } else if (marker === "_") {
      runs.push({
        marker,
        length,
        canOpen: left && (!right || beforePunctuation),
        canClose: right && (!left || afterPunctuation),
      });
    } else {
      runs.push({ marker, length, canOpen: left, canClose: right });
    }
    index = end;
  }
  return runs;
}

function closeEmphasis(text: string): string {
  const open: { marker: string; length: number }[] = [];
  for (const run of scanEmphasisRuns(maskCode(text))) {
    let length = run.length;
    while (run.canClose && length > 0) {
      let match = -1;
      for (let index = open.length - 1; index >= 0; index -= 1) {
        if (open[index].marker === run.marker) {
          match = index;
          break;
        }
      }
      if (match < 0) break;
      const opener = open[match];
      const used = Math.min(opener.length, length);
      opener.length -= used;
      length -= used;
      // Delimiters opened INSIDE the span this closer terminates can never be
      // closed any more, so they leave with it.
      open.length = opener.length > 0 ? match + 1 : match;
    }
    if (length > 0 && run.canOpen) open.push({ marker: run.marker, length });
  }
  let healed = text;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    healed += open[index].marker.repeat(Math.min(open[index].length, 3));
  }
  return healed;
}

// "Text-only" link healing: an unfinished link or image renders as its
// label until the destination closes, instead of leaving "[docs](https://exa"
// on screen and then snapping into an anchor.
function healIncompleteLink(text: string): string {
  const masked = maskCode(text);
  const open = masked.lastIndexOf("[");
  if (open < 0) return text;
  const start = open > 0 && masked[open - 1] === "!" ? open - 1 : open;
  const label = masked.indexOf("]", open);
  if (label < 0) return `${text.slice(0, start)}${text.slice(open + 1)}`;
  // A reference use ("[docs][1]") or a task-list box stays exactly as typed.
  if (masked[label + 1] !== "(") return text;
  if (masked.indexOf(")", label + 1) >= 0) return text;
  return `${text.slice(0, start)}${text.slice(open + 1, label)}`;
}

/**
 * Close the inline markers the model has not finished typing yet.
 * The live tail is healed before parsing, so "**계획" renders as
 * bold WHILE it streams; without healing the raw markers stayed visible until
 * the closing token arrived and the line snapped. The result feeds the PARSER
 * only: emphasis and code gain their closers, and an unfinished link keeps its
 * label as prose (text-only healing). The source fallback still shows
 * exactly what the model emitted.
 */
export function healStreamingMarkdownTail(text: string): string {
  const value = String(text ?? "");
  if (!value || !healableMarkdownSyntax.test(value)) return value;
  if (hasOpenFence(value)) return value;
  return closeEmphasis(healIncompleteLink(closeInlineCode(value)));
}

export function createStreamingMarkdownCache(): StreamingMarkdownCache {
  return {
    stableText: "",
    stableChunks: [],
    stableChunkKeys: [],
    sourceText: "",
    scanOffset: 0,
    fenceMarker: "",
    fenceLength: 0,
    boundaries: [],
    scannedCharacters: 0,
  };
}

function resetCache(cache: StreamingMarkdownCache): void {
  cache.stableText = "";
  cache.stableChunks = [];
  cache.stableChunkKeys = [];
  cache.sourceText = "";
  cache.scanOffset = 0;
  cache.fenceMarker = "";
  cache.fenceLength = 0;
  cache.boundaries = [];
  cache.scannedCharacters = 0;
}

function markdownChunkKey(offset: number): string {
  return `chunk-${Math.max(0, Math.round(offset))}`;
}

/** One literal line needs no GFM parser. */
export function isPlainTextMarkdown(text: string): boolean {
  const value = String(text ?? "");
  return Boolean(value)
    && !value.includes("\n")
    && !nonPlainTextMarkdownSyntax.test(value)
    && !gfmAutolink.test(value)
    && !gfmStrikethrough.test(value)
    && !blockMarkdownSyntax.test(value);
}

// Engine streaming tails are append-only in normal operation. Bounded probes
// still detect truncation/replacement without comparing an ever-growing
// response from byte zero on every token flush.
function continuesStreamingText(previous: string, next: string): boolean {
  if (!previous || previous === next) return true;
  if (next.length < previous.length) return false;
  const headLength = Math.min(STREAM_APPEND_PROBE_CHARS, previous.length);
  if (next.slice(0, headLength) !== previous.slice(0, headLength)) return false;
  const tailStart = Math.max(headLength, previous.length - STREAM_APPEND_PROBE_CHARS);
  return next.slice(tailStart, previous.length) === previous.slice(tailStart);
}

// Incrementally track fence state and complete-line scan cost. Open fences use
// this cheap path so a multi-thousand-line code stream is never reparsed from
// byte zero on every renderer frame.
function scanStreamingMarkdownLines(text: string, cache: StreamingMarkdownCache): void {
  let lineStart = cache.scanOffset;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) break;
    const rawLine = text.slice(lineStart, newline).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence) {
      const marker = fence[1][0];
      if (!cache.fenceMarker) {
        cache.fenceMarker = marker;
        cache.fenceLength = fence[1].length;
      } else if (
        marker === cache.fenceMarker
        && fence[1].length >= cache.fenceLength
        && !fence[2].trim()
      ) {
        cache.fenceMarker = "";
        cache.fenceLength = 0;
      }
    } else if (!cache.fenceMarker && !rawLine.trim()) {
      cache.boundaries.push(newline + 1);
      if (cache.boundaries.length > 2) cache.boundaries.shift();
    }
    cache.scannedCharacters += newline + 1 - lineStart;
    lineStart = newline + 1;
  }
  cache.scanOffset = lineStart;
}

// Projection model: every complete top-level block except the final block
// becomes immutable. The remaining block is the sole mutable tail.
function stableMarkdownBoundaries(text: string, cache: StreamingMarkdownCache): number[] {
  scanStreamingMarkdownLines(text, cache);
  const base = cache.stableText.length;
  if (cache.fenceMarker) {
    let beforeFence: number | undefined;
    for (let index = cache.boundaries.length - 1; index >= 0; index -= 1) {
      const position = cache.boundaries[index];
      if (position > base) {
        beforeFence = position;
        break;
      }
    }
    return beforeFence === undefined ? [] : [beforeFence];
  }
  try {
    const root = streamingBlockParser.parse(text.slice(base));
    const starts = root.children
      .map((child) => Number(child.position?.start.offset))
      .filter((offset) => Number.isFinite(offset) && offset >= 0);
    return starts.slice(1).map((offset) => base + offset);
  } catch {
    return [];
  }
}

export function resolveStreamingMarkdownChunks(
  text: string,
  streaming: boolean,
  cache: StreamingMarkdownCache,
): StreamingMarkdownParts {
  const value = String(text ?? "");
  if (!continuesStreamingText(cache.sourceText, value)) resetCache(cache);
  if (!streaming) {
    // Keep already-parsed blocks mounted when the stream settles. Resetting
    // here used to make the final token reparse the complete response in one
    // renderer task, even though most blocks had already been frozen.
    if (cache.stableText && value.startsWith(cache.stableText)) {
      cache.sourceText = value;
      return {
        stableChunks: cache.stableChunks,
        stableChunkKeys: cache.stableChunkKeys,
        unstableText: value.slice(cache.stableText.length),
        unstableKey: markdownChunkKey(cache.stableText.length),
        parseUnstable: true,
      };
    }
    resetCache(cache);
    cache.sourceText = value;
    return {
      stableChunks: [],
      stableChunkKeys: [],
      unstableText: value,
      unstableKey: markdownChunkKey(0),
      parseUnstable: true,
    };
  }

  const stableBoundaries = stableMarkdownBoundaries(value, cache);
  for (const boundary of stableBoundaries) {
    if (boundary <= cache.stableText.length || boundary > value.length) continue;
    const chunk = value.slice(cache.stableText.length, boundary);
    if (!chunk) continue;
    const chunkKey = markdownChunkKey(cache.stableText.length);
    cache.stableText += chunk;
    cache.stableChunks = [...cache.stableChunks, chunk];
    cache.stableChunkKeys = [...cache.stableChunkKeys, chunkKey];
  }
  cache.boundaries = cache.boundaries.filter((position) => position > cache.stableText.length);

  cache.sourceText = value;
  const unstableText = value.slice(cache.stableText.length);
  return {
    stableChunks: cache.stableChunks,
    stableChunkKeys: cache.stableChunkKeys,
    unstableText,
    unstableKey: markdownChunkKey(cache.stableText.length),
    // An open fence, table, list, or very long paragraph may have no safe
    // boundary for many kilobytes. Re-running the full GFM parser for that
    // growing tail every 80ms blocks Chromium's renderer thread. Preserve the
    // live text as plain DOM until settlement instead; completed older blocks
    // remain parsed and memoized above.
    parseUnstable: unstableText.length <= MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS,
  };
}
