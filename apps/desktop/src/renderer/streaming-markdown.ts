import remarkParse from "remark-parse";
import { unified } from "unified";
// @ts-expect-error Shared runtime ESM intentionally has no separate declaration file.
import { healStreamingMarkdownTail } from "../../../../src/ui/streaming-markdown-heal.mjs";
export { healStreamingMarkdownTail };

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
