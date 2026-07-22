import type { TranscriptItem } from "./desktop-types";

// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
export const MAX_IMAGE_PREVIEW_CACHE = 24;
export const imagePreviewCache = new Map<string, string>();
export function imagePreviewKey(id: number | null | undefined, bytes: number | undefined): string {
  return `${id ?? 'x'}:${bytes ?? 0}`;
}
export function registerImagePreview(id: number, bytes: number, dataUrl: string) {
  const key = imagePreviewKey(id, bytes);
  imagePreviewCache.delete(key);
  imagePreviewCache.set(key, dataUrl);
  while (imagePreviewCache.size > MAX_IMAGE_PREVIEW_CACHE) {
    const oldest = imagePreviewCache.keys().next().value;
    if (oldest === undefined) break;
    imagePreviewCache.delete(oldest);
  }
}

// Perf: main-process timings show session switches settle in <80ms; the
// perceived lag is the renderer mounting every markdown/tool row at once.
// Virtualize much earlier so long sessions paint a window, not the world.
export const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 32;
// Keep the entry window tight: Markdown/tool mounts dominate perceived session
// open latency, while four rows still cover a fast first upward wheel.
export const TRANSCRIPT_VIRTUAL_OVERSCAN = 4;

export function lastVisibleTranscriptItemIndex(
  itemCount: number,
  isHidden: (index: number) => boolean,
): number {
  let index = itemCount - 1;
  while (index >= 0 && isHidden(index)) index -= 1;
  return index;
}

export const transcriptRowHeightEstimateCache = new WeakMap<object, number>();
export const transcriptStableRowHeightEstimateCache = new Map<string, { signature: string; estimate: number }>();
export const TRANSCRIPT_HEIGHT_SAMPLE_CHARS = 768;
export const TRANSCRIPT_STABLE_HEIGHT_CACHE_LIMIT = 4_096;

export function estimatedWrappedTextRows(text: string, columns = 70): number {
  if (!text) return 1;
  const sampledRows = (value: string): number => {
    let rows = 1;
    let column = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 10) {
        rows += 1;
        column = 0;
        continue;
      }
      if (code === 13) continue;
      column += 1;
      if (column > columns) {
        rows += 1;
        column = 1;
      }
    }
    return rows;
  };
  if (text.length <= TRANSCRIPT_HEIGHT_SAMPLE_CHARS * 2) return sampledRows(text);
  // Height estimation runs for every virtual row during the first render.
  // Scan a fixed-size head/tail sample instead of multi-megabyte historical
  // outputs; mounted rows replace the estimate with their measured height.
  const head = text.slice(0, TRANSCRIPT_HEIGHT_SAMPLE_CHARS);
  const tail = text.slice(-TRANSCRIPT_HEIGHT_SAMPLE_CHARS);
  const sampledLength = head.length + tail.length;
  const sampledIncrements = Math.max(1, sampledRows(head) + sampledRows(tail) - 2);
  return Math.max(1, Math.round(sampledIncrements * (text.length / sampledLength)) + 1);
}

export function stableTranscriptHeightKey(item: TranscriptItem): { key: string; signature: string } | null {
  if (item.id === undefined || item.id === null) return null;
  const text = String(item.text || "");
  return {
    key: String(item.id),
    signature: [
      item.kind || "",
      item.streaming ? "1" : "0",
      item.expanded ? "1" : "0",
      text.length,
      text.slice(0, 48),
      text.slice(-48),
    ].join("|"),
  };
}

export function rememberStableTranscriptHeight(key: string, signature: string, estimate: number): void {
  transcriptStableRowHeightEstimateCache.delete(key);
  transcriptStableRowHeightEstimateCache.set(key, { signature, estimate });
  while (transcriptStableRowHeightEstimateCache.size > TRANSCRIPT_STABLE_HEIGHT_CACHE_LIMIT) {
    const oldest = transcriptStableRowHeightEstimateCache.keys().next().value;
    if (oldest === undefined) break;
    transcriptStableRowHeightEstimateCache.delete(oldest);
  }
}

export function cachedStableTranscriptHeight(item: TranscriptItem): number | undefined {
  const stable = stableTranscriptHeightKey(item);
  if (!stable) return undefined;
  const cached = transcriptStableRowHeightEstimateCache.get(stable.key);
  if (!cached || cached.signature !== stable.signature) return undefined;
  transcriptStableRowHeightEstimateCache.delete(stable.key);
  transcriptStableRowHeightEstimateCache.set(stable.key, cached);
  return cached.estimate;
}

export function cacheStableTranscriptHeight(item: TranscriptItem, estimate: number): void {
  const stable = stableTranscriptHeightKey(item);
  if (stable) rememberStableTranscriptHeight(stable.key, stable.signature, estimate);
}

export function estimatedTranscriptRowHeight(item: TranscriptItem | undefined): number {
  if (!item) return 40;
  const cached = transcriptRowHeightEstimateCache.get(item);
  if (cached !== undefined) return cached;
  const stableCached = cachedStableTranscriptHeight(item);
  if (stableCached !== undefined) {
    transcriptRowHeightEstimateCache.set(item, stableCached);
    return stableCached;
  }
  const text = String(item.text || "");
  const textRows = estimatedWrappedTextRows(text);
  let estimate: number;
  if (item.kind === "assistant") {
    // A live code/script response can already be thousands of pixels tall when
    // the session is entered. The former 160px live cap forced one huge
    // post-mount correction; estimate the current shape without that cap.
    estimate = text ? Math.min(24_000, 34 + textRows * 23) : 28;
  } else if (item.kind === "user") {
    estimate = Math.min(8_000, Math.max(72, 34 + textRows * 23));
  } else if (item.kind === "tool") {
    estimate = item.expanded ? 180 : 56;
  } else {
    estimate = 40;
  }
  transcriptRowHeightEstimateCache.set(item, estimate);
  cacheStableTranscriptHeight(item, estimate);
  return estimate;
}
