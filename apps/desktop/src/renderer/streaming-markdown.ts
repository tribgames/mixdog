export interface StreamingMarkdownCache {
  stableText: string;
  stableChunks: string[];
}

export interface StreamingMarkdownParts {
  stableChunks: readonly string[];
  unstableText: string;
}

const MIN_STABLE_CHUNK_CHARS = 256;

export function createStreamingMarkdownCache(): StreamingMarkdownCache {
  return { stableText: "", stableChunks: [] };
}

function resetCache(cache: StreamingMarkdownCache): void {
  cache.stableText = "";
  cache.stableChunks = [];
}

// Keep the newest two Markdown blocks mutable. That one-block look-behind
// prevents a partial list/table/setext construct from being frozen merely
// because its first blank separator arrived. Closed older blocks can then be
// parsed once and retained as memoized React subtrees.
export function stableStreamingMarkdownBoundary(text: string): number {
  const boundaries: number[] = [];
  let lineStart = 0;
  let fenceMarker = "";
  let fenceLength = 0;

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) break;
    const rawLine = text.slice(lineStart, newline).replace(/\r$/, "");
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(rawLine);
    if (fence) {
      const marker = fence[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceLength = fence[1].length;
      } else if (
        marker === fenceMarker
        && fence[1].length >= fenceLength
        && !fence[2].trim()
      ) {
        fenceMarker = "";
        fenceLength = 0;
      }
    } else if (!fenceMarker && !rawLine.trim()) {
      boundaries.push(newline + 1);
    }
    lineStart = newline + 1;
  }

  return boundaries.length >= 2 ? boundaries[boundaries.length - 2] : 0;
}

export function resolveStreamingMarkdownChunks(
  text: string,
  streaming: boolean,
  cache: StreamingMarkdownCache,
): StreamingMarkdownParts {
  const value = String(text ?? "");
  if (!streaming) {
    resetCache(cache);
    return { stableChunks: [], unstableText: value };
  }
  if (!value.startsWith(cache.stableText)) resetCache(cache);

  const suffix = value.slice(cache.stableText.length);
  const boundary = stableStreamingMarkdownBoundary(suffix);
  if (boundary >= MIN_STABLE_CHUNK_CHARS) {
    const chunk = suffix.slice(0, boundary);
    cache.stableText += chunk;
    cache.stableChunks = [...cache.stableChunks, chunk];
  }

  return {
    stableChunks: cache.stableChunks,
    unstableText: value.slice(cache.stableText.length),
  };
}
