import type { TranscriptItem } from "./desktop-types";

// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
const MAX_IMAGE_PREVIEW_CACHE = 24;
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
// Keep one fixed, tight window for the whole session. Delayed overscan warmup
// changed virtual geometry several seconds after entry and visibly shook the
// transcript; user-driven scroll measurement is anchor-compensated instead.
export const TRANSCRIPT_VIRTUAL_OVERSCAN = 4;

export function shouldCompensateTranscriptRowMeasurement({
  end,
  scrollOffset,
  now,
  toggleHoldUntil,
  scrollIntentUntil,
  pointerScrollIntent,
  widthReflowing,
  following,
}: {
  end: number;
  scrollOffset: number;
  now: number;
  toggleHoldUntil: number;
  scrollIntentUntil: number;
  pointerScrollIntent: boolean;
  widthReflowing: boolean;
  following: boolean;
}): boolean {
  // Compensation is valid only for a row that is completely above the
  // viewport. A tall script can start above scrollTop while still crossing the
  // whole viewport; compensating its late measurement moves the script the
  // user is actively reading (most visibly after switching tasks).
  return end <= scrollOffset
    && now >= toggleHoldUntil
    && now >= scrollIntentUntil
    && !pointerScrollIntent
    && !widthReflowing
    && !following;
}

export function lastVisibleTranscriptItemIndex(
  itemCount: number,
  isHidden: (index: number) => boolean,
): number {
  let index = itemCount - 1;
  while (index >= 0 && isHidden(index)) index -= 1;
  return index;
}

export interface TranscriptHeightScope {
  sessionKey?: string;
  width?: number;
}

const transcriptRowHeightEstimateCache = new WeakMap<object, Map<string, number>>();
const transcriptStableRowHeightEstimateCache = new Map<string, { signature: string; estimate: number }>();
const TRANSCRIPT_HEIGHT_SAMPLE_CHARS = 768;
const TRANSCRIPT_STABLE_HEIGHT_CACHE_LIMIT = 4_096;

// Sub-bucket width jitter must not invalidate measured heights: the scope key
// used to embed the EXACT pixel width, so a 1px row-width fluctuation (pane
// focus chrome, scrollbar, fractional layout) cold-started the entire
// session's estimate cache — the virtual total flapped between the measured
// sum (~17k) and the raw-estimate sum (~28k) and the transcript visibly
// jumped while scrolling or alternating pane focus (user report, measured).
// Real pane resizes cross a bucket and still re-estimate for the new width.
const TRANSCRIPT_WIDTH_BUCKET = 24;

function transcriptHeightScopeKey(scope?: TranscriptHeightScope): string {
  const sessionKey = String(scope?.sessionKey || "global");
  const width = Number(scope?.width);
  const bucketedWidth = Number.isFinite(width) && width > 0
    ? Math.round(width / TRANSCRIPT_WIDTH_BUCKET) * TRANSCRIPT_WIDTH_BUCKET
    : 0;
  return `${sessionKey}\u0000${bucketedWidth}`;
}

function estimatedWrappedTextRows(text: string, columns = 70): number {
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

function stableTranscriptHeightKey(
  item: TranscriptItem,
  scope?: TranscriptHeightScope,
): { key: string; signature: string } | null {
  if (item.id === undefined || item.id === null) return null;
  const text = String(item.text || "");
  return {
    key: `${transcriptHeightScopeKey(scope)}\u0000${String(item.id)}`,
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

function rememberStableTranscriptHeight(key: string, signature: string, estimate: number): void {
  transcriptStableRowHeightEstimateCache.delete(key);
  transcriptStableRowHeightEstimateCache.set(key, { signature, estimate });
  while (transcriptStableRowHeightEstimateCache.size > TRANSCRIPT_STABLE_HEIGHT_CACHE_LIMIT) {
    const oldest = transcriptStableRowHeightEstimateCache.keys().next().value;
    if (oldest === undefined) break;
    transcriptStableRowHeightEstimateCache.delete(oldest);
  }
}

function cachedStableTranscriptHeight(
  item: TranscriptItem,
  scope?: TranscriptHeightScope,
): number | undefined {
  const stable = stableTranscriptHeightKey(item, scope);
  if (!stable) return undefined;
  const cached = transcriptStableRowHeightEstimateCache.get(stable.key);
  if (!cached || cached.signature !== stable.signature) return undefined;
  transcriptStableRowHeightEstimateCache.delete(stable.key);
  transcriptStableRowHeightEstimateCache.set(stable.key, cached);
  return cached.estimate;
}

function cacheStableTranscriptHeight(
  item: TranscriptItem,
  estimate: number,
  scope?: TranscriptHeightScope,
): void {
  const stable = stableTranscriptHeightKey(item, scope);
  if (stable) rememberStableTranscriptHeight(stable.key, stable.signature, estimate);
}

/** Feed the virtualizer's real mounted height back into both session caches.
 * Re-entering a measured session must not replay its estimate corrections. */
export function rememberMeasuredTranscriptRowHeight(
  item: TranscriptItem | undefined,
  measuredHeight: number,
  scope?: TranscriptHeightScope,
): boolean {
  if (!item || !Number.isFinite(measuredHeight) || measuredHeight <= 0) return false;
  const height = Math.max(1, Math.round(measuredHeight));
  const scopeKey = transcriptHeightScopeKey(scope);
  const scoped = transcriptRowHeightEstimateCache.get(item) || new Map<string, number>();
  if (scoped.get(scopeKey) === height) return false;
  scoped.set(scopeKey, height);
  transcriptRowHeightEstimateCache.set(item, scoped);
  cacheStableTranscriptHeight(item, height, scope);
  return true;
}

export function estimatedTranscriptRowHeight(
  item: TranscriptItem | undefined,
  scope?: TranscriptHeightScope,
): number {
  if (!item) return 40;
  const scopeKey = transcriptHeightScopeKey(scope);
  const cached = transcriptRowHeightEstimateCache.get(item)?.get(scopeKey);
  if (cached !== undefined) return cached;
  const stableCached = cachedStableTranscriptHeight(item, scope);
  if (stableCached !== undefined) {
    const scoped = transcriptRowHeightEstimateCache.get(item) || new Map<string, number>();
    scoped.set(scopeKey, stableCached);
    transcriptRowHeightEstimateCache.set(item, scoped);
    return stableCached;
  }
  const text = String(item.text || "");
  const textRows = estimatedWrappedTextRows(text);
  let estimate: number;
  if (item.kind === "assistant") {
    // A live code/script response can already be thousands of pixels tall when
    // the session is entered. The former 160px live cap forced one huge
    // post-mount correction; estimate the current shape without that cap.
    // Measured desktop Markdown: a one-line response is 44px when very short
    // and 68px with the normal metadata rhythm. Multi-line blocks average
    // ~35px per sampled wrapped row once paragraph/list/code spacing is
    // included; the old 23px text-only multiplier undershot long rows by up
    // to 240px and forced a visible bottom-anchor correction on entry.
    estimate = !text ? 28
      : textRows === 1 ? (text.length < 36 ? 44 : 68)
        : Math.min(24_000, 40 + textRows * 35);
  } else if (item.kind === "user") {
    estimate = Math.min(8_000, Math.max(72, 34 + textRows * 23));
  } else if (item.kind === "tool") {
    // Desktop tool cards are one header row by default in every lifecycle
    // state. User expansion is measured after mount.
    estimate = item.expanded ? 56 : 48;
  } else {
    estimate = 40;
  }
  const scoped = transcriptRowHeightEstimateCache.get(item) || new Map<string, number>();
  scoped.set(scopeKey, estimate);
  transcriptRowHeightEstimateCache.set(item, scoped);
  cacheStableTranscriptHeight(item, estimate, scope);
  return estimate;
}
