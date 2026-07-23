/**
 * transcript-window.mjs — the transcript row-estimate + virtual-window engine,
 * extracted verbatim from App.jsx. Owns ALL module-level caches for this
 * cluster (variant-key, estimated-rows, measured-rows, sig-part). Pure module:
 * no React, no App closures. The App imports the functions and (for the
 * measured-height cache it writes from a layout effect) the shared cache +
 * variant-key helper by name.
 *
 * Behavior is byte-for-byte the same as when these lived in App.jsx; only the
 * home moved. The env-tunable constants and their comments are preserved.
 */
import {
  measureMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRows,
} from '../markdown/measure-rendered-rows.mjs';
import { streamingLayoutText } from '../markdown/streaming-markdown.mjs';
import { displayWidth } from '../display-width.mjs';
import { formatToolSurface, normalizeToolName, parseToolArgs, summarizeAgentSurfaceBrief } from '../../runtime/shared/tool-surface.mjs';
import { isBackgroundErrorOnlyBody } from '../../runtime/shared/err-text.mjs';
import { formatExpandedResult, wrapExpandedResultLines } from '../components/tool-output-format.mjs';
import {
  formatHookDenialDetail,
  isHookApprovalDenialToolItem,
  shouldSuppressFullyFailedToolItem,
  toolItemResultText,
} from '../transcript-tool-failures.mjs';
import { backgroundArgsForRows, estimateTranscriptItemRows } from './transcript-row-estimate.mjs';

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Per-keystroke render cost is proportional to the number of MOUNTED transcript
// items: ink's renderNodeToOutput still serializes (squashTextNodes/wrapText/
// output.write) every child even when an overflow:hidden viewport clips it
// off-screen — clipping only trims write coordinates, not the serialization. So
// the only lever for typing latency on a tall transcript is mounting fewer
// rows. The window keeps a small ITEM floor (so a few items stay mounted for
// stable scroll/overscan) but is otherwise driven by the viewport+overscan ROW
// span, not a large fixed item count. All three are env-tunable for A/B / revert.
export const TRANSCRIPT_WINDOW_MIN_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS', 12);
export const TRANSCRIPT_WINDOW_OVERSCAN_ROWS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS', 16);

// Hard cap on simultaneously MOUNTED transcript items. Every mounted child is
// fully serialized by ink each frame (clipping only trims write coords, not the
// serialize pass), so this cap is the dominant lever for per-frame render cost
// on a tall transcript. The viewport+overscan ROW span already drives the
// window; this cap only bounds the worst case (many short rows). 180 mounted
// rows is far more than any viewport needs and made each frame serialize a long
// tail of off-screen rows, so lower it to a value that still comfortably covers
// viewport + overscan on a large terminal. Env-tunable for A/B / revert.
export const TRANSCRIPT_WINDOW_MAX_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS', 80);
// When the transcript is anchored to the bottom (live tail / streaming view,
// effectiveScrollOffset === 0), everything above the viewport is off-screen and
// cannot be revealed without a scroll action — which sets scrollOffset > 0 and
// re-renders through the FULL overscan/cap constants above, i.e. scrolled-up
// history is byte-for-byte unchanged. So in the at-bottom case we mount only
// viewport + a small overscan, sharply cutting ink's per-frame serialize cost
// during streaming (bench: 80→20 mounted rows ≈ 4.07ms/render, 109 CPU-ms/s).
// Env-tunable for A/B / revert.
export const TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_TAIL_OVERSCAN_ROWS', 4);
const TRANSCRIPT_WINDOW_TAIL_MAX_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_TAIL_ITEMS', 20);
export const SELECTION_PAINT_INTERVAL_MS = positiveIntEnv('MIXDOG_TUI_SELECTION_PAINT_MS', 24);
// Frame-coalesce edge-drag auto-scroll + wheel scroll: both paths accumulate
// deltas into one pending total and flush via a single scrollTranscriptRows
// call per this interval, instead of firing the (expensive: anchor recompute +
// selection repaint) scrollTranscriptRows on every mousemove/wheel tick.
export const SCROLL_COALESCE_MS = positiveIntEnv('MIXDOG_TUI_SCROLL_COALESCE_MS', 16);
export const PROMPT_HISTORY_LIMIT = 50;

// Parse a boolean env var that DEFAULTS ON. Any of 0/false/off/no (case-
// insensitive, trimmed) disables it; everything else (including unset) leaves it
// on. Used as the kill switch for the app-level measured-height feature below.
function boolEnvDefaultTrue(name) {
  const raw = process.env[name];
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export const TRANSCRIPT_MEASURED_ROWS = boolEnvDefaultTrue('MIXDOG_TUI_TRANSCRIPT_MEASURED');

export function selectionRectsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode
    && a.x1 === b.x1
    && a.y1 === b.y1
    && a.x2 === b.x2
    && a.y2 === b.y2
    && a.clipY1 === b.clipY1
    && a.clipY2 === b.clipY2
    && a.captureText === b.captureText;
}

export function shiftSelectionRectY(rect, deltaY) {
  const dy = Math.round(Number(deltaY) || 0);
  if (!rect || dy === 0) return rect || null;
  return { ...rect, y1: rect.y1 + dy, y2: rect.y2 + dy };
}

// Reading-order compare (row then col): -1 if a<b, 1 if a>b, 0 equal.
export function comparePoints(a, b) {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  return 0;
}


function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (transcriptRowAt(values, mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (transcriptRowAt(values, mid) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Resolve the absolute scroll offset that keeps a captured reading anchor at the
// same screen position for the CURRENT prefix table. Pure so it can run during
// render AND in the post-commit layout effect.
export function resolveAnchorScrollOffset({ anchor, items, curPrefix, totalRows, viewRows, maxRows }) {
  if (!anchor || anchor.id == null) return null;
  if (!curPrefix || curPrefix.length <= 1) return null;
  const list = Array.isArray(items) ? items : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].id === anchor.id) { idx = i; break; }
  }
  if (idx < 0 || idx > curPrefix.length - 2) return null;
  const itemHeight = Math.max(0, transcriptRowAt(curPrefix, idx + 1) - transcriptRowAt(curPrefix, idx));
  const clampedOffset = Math.max(0, Math.min(Number(anchor.offset) || 0, itemHeight));
  const anchorRowCur = transcriptRowAt(curPrefix, idx) + clampedOffset;
  return Math.max(0, Math.min(maxRows, totalRows - viewRows - anchorRowCur));
}

// Cheap, stable height fingerprint for a text blob (length + newline count +
// FNV-1a hash), so a same-length edit that changes wrap/newline shape still
// invalidates the row/signature caches.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Two INDEPENDENT 32-bit rolling-hash steps folded into a 64-bit signature.
// fnvStepA is plain FNV-1a; fnvStepB uses a distinct seed/prime + xorshift
// finalizer so the two chains are decorrelated (see the App.jsx history note).
function fnvStepA(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function fnvStepB(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x85ebca77) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

function textShapeFingerprint(value) {
  if (value == null) return 'z';
  const text = String(value);
  const len = text.length;
  if (len === 0) return 'e';
  let newlines = 0;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return `${len}.${newlines}.${fnv1a32(text).toString(36)}`;
}

// Identity-keyed memo for the variant key. Exported: the App's measured-height
// layout effect validates its cache writes on the SAME variant key.
const transcriptVariantKeyCache = new WeakMap();

export function transcriptItemVariantKey(item) {
  if (item && typeof item === 'object') {
    const cached = transcriptVariantKeyCache.get(item);
    if (cached !== undefined) return cached;
    const key = computeTranscriptItemVariantKey(item);
    transcriptVariantKeyCache.set(item, key);
    return key;
  }
  return computeTranscriptItemVariantKey(item);
}

function computeTranscriptItemVariantKey(item) {
  const expanded = item.expanded ? 1 : 0;
  if (item.kind === 'tool') {
    const resultShape = textShapeFingerprint(item.result);
    const rawShape = textShapeFingerprint(item.rawResult);
    const count = Number(item.count ?? 0);
    const completed = item.completedCount === undefined ? 'u' : Number(item.completedCount);
    const errors = item.errorCount === undefined ? 'u' : Number(item.errorCount);
    const callErrors = item.callErrorCount === undefined ? 'u' : Number(item.callErrorCount);
    const isError = item.isError ? 1 : 0;
    const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
    const aggregate = item.aggregate ? 1 : 0;
    const bgArgs = backgroundArgsForRows(item.args);
    const bgType = String(bgArgs.type || bgArgs.action || '');
    const bgStatus = String(bgArgs.status || '');
    const bgTaskId = bgArgs.task_id ? 1 : 0;
    const bgPrompt = textShapeFingerprint(bgArgs.prompt);
    const bgMessage = textShapeFingerprint(bgArgs.message);
    const bgError = textShapeFingerprint(bgArgs.error);
    return `x${expanded}:n${normalizedName}:g${aggregate}:r${resultShape}:R${rawShape}:c${count}:d${completed}:e${errors}:ce${callErrors}:E${isError}:bt${bgType}:bs${bgStatus}:bk${bgTaskId}:bp${bgPrompt}:bm${bgMessage}:be${bgError}`;
  }
  return `x${expanded}:s${textShapeFingerprint(item.text ?? item.result ?? '')}`;
}

// Per-item ESTIMATED ROW COUNT cache for buildTranscriptRowIndex.
const transcriptRowsCache = new WeakMap();

// App-level MEASURED row heights (real per-item height cache). Exported so the
// App's per-commit layout effect can write/read/prune it; validated on the same
// (variantKey + columns + toolExpanded) tuple as the estimate caches.
export const transcriptMeasuredRowsCache = new WeakMap();

// Streaming assistant items are REPLACED (new object) on every token flush
// (see engine.mjs `{ ...current, text, streaming: true }`), so a WeakMap keyed
// on the item object is orphaned by the very next frame and can never observe
// live re-slice growth. Key streaming measurements by item id instead — they
// survive the per-token object swap. Cleared once the item stops streaming
// (its final settled height is then captured by the normal WeakMap path).
export const streamingMeasuredRowsById = new Map();

// High-water clamp for the STREAMING row ESTIMATE, keyed by stream item id.
// measureStreamingMarkdownRenderedRows (measure-rendered-rows.mjs) adds a +1
// gap row only while childCount===2 (stablePrefix box + unstableSuffix box).
// As the stable/unstable split moves per token — and when the suffix is
// momentarily whitespace-only, stablePrefix empties — childCount flips 1↔2
// frame-to-frame, so the estimate oscillates ±1. Streaming text only ever
// GROWS, so any per-frame DECREASE is spurious. Hold the max estimate seen this
// streaming run so streamingEstimateRows is NON-DECREASING, killing the -1 dip
// that shifts the transcript when a newline settles. Entry stores columns/
// toolExpanded so a real layout-basis change resets the water line (row count
// legitimately changes with width). Lifecycle mirrors streamingMeasuredRowsById
// exactly: pruned by pruneStreamingMeasuredRowsById and cleared at the same
// settle / invalidate delete sites in estimateTranscriptItemRowsCached.
const streamingEstimateHighWaterById = new Map();

// The App asks for the live-tail estimate on every render, including renders
// caused only by prompt typing. Keep exactly the latest estimate per stream id
// so unchanged text never reaches markdown/plain row measurement. The key
// includes every App-level input that selects this rendering path or geometry.
const streamingTailEstimateById = new Map();
const STREAMING_TAIL_ESTIMATE_LRU_MAX = 8;

function cacheStreamingTailEstimate(id, entry) {
  if (id == null) return;
  if (streamingTailEstimateById.has(id)) streamingTailEstimateById.delete(id);
  streamingTailEstimateById.set(id, entry);
  while (streamingTailEstimateById.size > STREAMING_TAIL_ESTIMATE_LRU_MAX) {
    const oldest = streamingTailEstimateById.keys().next().value;
    if (oldest === undefined) break;
    streamingTailEstimateById.delete(oldest);
    // The high-water entry belongs to the same latest-estimate lifecycle.
    // Leaving it behind both grows without bound and lets a later reuse of an
    // evicted id inherit geometry from an unrelated completed/aborted stream.
    streamingEstimateHighWaterById.delete(oldest);
  }
}

/** Lifecycle visibility for focused cache-boundary tests. */
export function streamingRowEstimateStateForId(id) {
  return {
    tailEstimate: streamingTailEstimateById.has(id),
    highWater: streamingEstimateHighWaterById.has(id),
  };
}

/** True when either streaming id-keyed store holds entries, so the mount-prune
 * call site fires even when only the estimate high-water map is populated (an
 * item that never got a Yoga measurement but reached an estimate high-water,
 * then was bulk-replaced, must still be pruned). */
export function hasStreamingRowStateToPrune() {
  return streamingMeasuredRowsById.size > 0
    || streamingEstimateHighWaterById.size > 0
    || streamingTailEstimateById.size > 0;
}

export function transcriptHarvestInputsEqual(left, right) {
  return !!left && !!right
    && left.revision === right.revision
    && left.settledItems === right.settledItems
    && left.streamingTailItem === right.streamingTailItem
    && left.startIndex === right.startIndex
    && left.endIndex === right.endIndex
    && left.frameColumns === right.frameColumns
    && left.toolOutputExpanded === right.toolOutputExpanded
    && left.transcriptContentHeight === right.transcriptContentHeight
    && left.floatingPanelRows === right.floatingPanelRows
    && left.overlayHintRequested === right.overlayHintRequested
    && left.transcriptGuardRows === right.transcriptGuardRows
    && left.themeEpoch === right.themeEpoch;
}

/** Drop streamingMeasuredRowsById entries for ids no longer mounted, so the
 * store does not grow unbounded over a long session (mirrors the id→item /
 * id→callback map pruning already done for the mounted set). */
export function pruneStreamingMeasuredRowsById(liveIds) {
  if (!liveIds) return;
  if (streamingMeasuredRowsById.size > 0) {
    for (const id of streamingMeasuredRowsById.keys()) {
      if (!liveIds.has(id)) streamingMeasuredRowsById.delete(id);
    }
  }
  if (streamingEstimateHighWaterById.size > 0) {
    for (const id of streamingEstimateHighWaterById.keys()) {
      if (!liveIds.has(id)) streamingEstimateHighWaterById.delete(id);
    }
  }
  if (streamingTailEstimateById.size > 0) {
    for (const id of streamingTailEstimateById.keys()) {
      if (!liveIds.has(id)) streamingTailEstimateById.delete(id);
    }
  }
}

/** Copy a Yoga-measured row entry onto a replacement item object (e.g. patchItem). */
export function carryTranscriptMeasuredRowsCache(prevItem, nextItem) {
  if (!TRANSCRIPT_MEASURED_ROWS || !prevItem || !nextItem || prevItem === nextItem) return;
  const entry = transcriptMeasuredRowsCache.get(prevItem);
  if (!entry || entry.rows <= 0) return;
  const variantKey = transcriptItemVariantKey(nextItem);
  if (entry.variantKey !== variantKey) return;
  transcriptMeasuredRowsCache.set(nextItem, entry);
}

export function measuredTranscriptRows(item, columns, toolOutputExpanded) {
  if (!TRANSCRIPT_MEASURED_ROWS || !item) return null;
  if (shouldSuppressFullyFailedToolItemCached(item)) return 0;
  // Streaming height flows ONLY through estimateTranscriptItemRowsCached's
  // max(idStore, estimate) path — never straight from the WeakMap here, or
  // buildTranscriptRowIndex (which calls this first) and the sigPart (which
  // calls estimateTranscriptItemRowsCached) could resolve different values
  // for the same streaming item and diverge.
  if (item.kind === 'assistant' && item.streaming) return null;
  const entry = transcriptMeasuredRowsCache.get(item);
  if (!entry) return null;
  if (entry.rows <= 0) return null;
  if (entry.columns !== columns) return null;
  if (entry.toolExpanded !== (toolOutputExpanded ? 1 : 0)) return null;
  if (entry.variantKey !== transcriptItemVariantKey(item)) return null;
  return entry.rows;
}

const STREAMING_ROW_QUANTUM = 1;

// Bottom-pinned flag for the streaming-tail row estimate. Set once per hook
// render (use-transcript-window.mjs) BEFORE any tail resolution so every path
// that resolves the streaming tail height (tailSig, buildTranscriptRowIndex,
// incremental tail, transcriptStructureSignature) reads the same value and
// cannot diverge. Bottom-pinned → fold the live estimate in (geometry right on
// the first commit); away from bottom → d19cad1e defer-growth.
let streamingBottomPinned = false;
export function setStreamingBottomPinned(pinned) {
  streamingBottomPinned = !!pinned;
}

function assistantTextForStreamingRowEstimate(text) {
  return streamingLayoutText(text);
}

export function streamingEstimateRows(item, columns, toolOutputExpanded) {
  const id = item?.id;
  const exactText = String(item?.text ?? '');
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const renderMode = item?.kind === 'assistant' && item?.streaming
    ? 'assistant-streaming-markdown'
    : 'other';
  const cached = id == null ? null : streamingTailEstimateById.get(id);
  if (cached
    && cached.text === exactText
    && cached.columns === columns
    && cached.toolExpanded === toolExpanded
    && cached.renderMode === renderMode) {
    cacheStreamingTailEstimate(id, cached);
    return cached.rows;
  }
  const trimmedText = assistantTextForStreamingRowEstimate(item.text);
  const estimateItem = trimmedText === item.text ? item : { ...item, text: trimmedText };
  const raw = Math.max(1, Math.ceil(estimateTranscriptItemRows(estimateItem, columns, toolOutputExpanded)));
  const quantized = Math.ceil(raw / STREAMING_ROW_QUANTUM) * STREAMING_ROW_QUANTUM;
  // High-water clamp: streaming text only grows, so never report fewer rows than
  // this id already reached this run — absorbs the childCount 1↔2 gap flip that
  // otherwise dips the estimate ±1 frame-to-frame. A columns/expanded change
  // resets the water line (new width → legitimately new row count).
  if (id == null) return quantized;
  const prev = streamingEstimateHighWaterById.get(id);
  let rows;
  if (!prev
    || prev.columns !== columns
    || prev.toolExpanded !== toolExpanded
    || prev.renderMode !== renderMode) {
    streamingEstimateHighWaterById.set(id, {
      rows: quantized,
      columns,
      toolExpanded,
      renderMode,
    });
    rows = quantized;
  } else {
    if (quantized > prev.rows) prev.rows = quantized;
    rows = prev.rows;
  }
  cacheStreamingTailEstimate(id, {
    text: exactText,
    columns,
    toolExpanded,
    renderMode,
    rows,
  });
  return rows;
}

// ── Same-frame streaming-tail growth compensation (scrolled-up only) ────────
// Away from bottom, estimateTranscriptItemRowsCached freezes the trailing
// streaming item at its last Yoga-confirmed height (defer-growth), so the row
// index / totalRows this render still counts the OLD height even though the
// mounted Box lays out at the live-grown height NOW. That one-frame mismatch is
// the newline judder: the physical content grew but the scroll offset did not,
// so the visible window shifts up until measuredRowsVersion bumps next frame.
// Report how many rows the mounted tail has grown beyond the height the row
// index used so the caller can fold it into the scroll offset for the SAME
// render. Returns { tailRows, delta }:
//   tailRows — the height the row index used for the tail (for the in-slice gate)
//   delta    — live-estimate rows grown beyond that (0 when nothing to correct)
// Returns null when the tail is not a deferred streaming item (no confirmed
// measurement yet → the index already used the live estimate, so no mismatch).
export function streamingTailMountedGrowth(items, columns, toolOutputExpanded) {
  const list = Array.isArray(items) ? items : [];
  const tail = list.length > 0 ? list[list.length - 1] : null;
  if (!tail || tail.kind !== 'assistant' || !tail.streaming) return null;
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const idEntry = streamingMeasuredRowsById.get(tail.id);
  if (!idEntry || !(idEntry.rows > 0) || idEntry.columns !== columns || idEntry.toolExpanded !== toolExpanded) {
    return null;
  }
  const live = streamingEstimateRows(tail, columns, toolOutputExpanded);
  // Bottom-pinned already folds the live estimate into the row index, so there
  // is nothing to compensate (delta 0); the caller also only invokes this while
  // scrolled up, so this is a belt-and-suspenders guard.
  if (streamingBottomPinned) return { tailRows: Math.max(idEntry.rows, live), delta: 0 };
  // Away from bottom the row index used the real Yoga height (idEntry.rows). The
  // physical mismatch to compensate is real_now − real_measured, but `live` (an
  // estimate) vs idEntry.rows (measured) also carries the estimator's steady
  // bias, which would keep delta positive AFTER measuredRowsVersion has already
  // absorbed the real height — permanent over-compensation. Measure growth in
  // the SAME (estimate) metric instead: delta = live_now − estimateAtMeasure,
  // where estimateAtMeasure is the estimate for the exact text that was
  // measured. The estimator bias cancels, so an unchanged tail gives delta 0
  // (nothing left for the index to consume) and only genuine text growth since
  // the last measurement compensates.
  const baseline = idEntry.estimateRows > 0 ? idEntry.estimateRows : idEntry.rows;
  const delta = Math.max(0, live - baseline);
  return { tailRows: idEntry.rows, delta };
}

// Identity-keyed memo, same contract as transcriptVariantKeyCache: transcript
// items are replaced (never mutated) when their content changes, so the
// suppress decision — which re-parses tool args via isFullyFailedToolBatch —
// is stable per object identity.
const suppressFullyFailedCache = new WeakMap();
function shouldSuppressFullyFailedToolItemCached(item) {
  if (!item || typeof item !== 'object') return shouldSuppressFullyFailedToolItem(item);
  const cached = suppressFullyFailedCache.get(item);
  if (cached !== undefined) return cached;
  const value = shouldSuppressFullyFailedToolItem(item);
  suppressFullyFailedCache.set(item, value);
  return value;
}

export function estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded, attachedTool = false) {
  if (!item) return Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded)));
  if (shouldSuppressFullyFailedToolItemCached(item)) return 0;
  if (item.kind === 'assistant' && item.streaming) {
    const toolExpanded = toolOutputExpanded ? 1 : 0;
    const idEntry = streamingMeasuredRowsById.get(item.id);
    if (idEntry && idEntry.rows > 0 && idEntry.columns === columns && idEntry.toolExpanded === toolExpanded) {
      if (streamingBottomPinned) {
        // Bottom-pinned: the view follows the tail, so its geometry must be
        // correct on the FIRST commit. Fold the freshly-grown live estimate in
        // — max(measuredFloor, liveEstimate) — so totalRows/scrollOffset are
        // right this frame instead of committing the stale measured floor and
        // growing a frame later when the harvest bumps measuredRowsVersion
        // (the judder). The measured floor still guards against an estimate
        // that undercounts the real wrap. Away from bottom the defer-growth
        // path below is kept (its anchor-stability / perf intent).
        return Math.max(idEntry.rows, streamingEstimateRows(item, columns, toolOutputExpanded));
      }
      // Defer-growth: while a confirmed (post-commit Yoga) measurement exists
      // for this streaming id, THIS render keeps that value instead of
      // folding in the freshly-grown estimate. Combining
      // max(measuredFloor, liveEstimate) let per-flush row growth reach
      // totalRows/scrollOffset a full frame BEFORE Yoga confirmed the real
      // wrap — the estimate could over/undercount vs the real layout, and
      // the next commit's harvest then corrected it, bouncing an anchored or
      // bottom-pinned offset by the mismatch. Freezing at the last confirmed
      // height means growth only reaches the row index on the SAME frame the
      // harvest (use-transcript-window.mjs) writes the new measured value and
      // bumps measuredRowsVersion — the "measured frame" consumes it, not the
      // estimate frame.
      return idEntry.rows;
    }
    if (idEntry) {
      streamingMeasuredRowsById.delete(item.id);
      streamingEstimateHighWaterById.delete(item.id);
      streamingTailEstimateById.delete(item.id);
    }
    // No confirmed measurement yet for this id (item just started streaming):
    // nothing to defer against, so the first frame falls back to the estimate.
    return streamingEstimateRows(item, columns, toolOutputExpanded);
  }
  if (item.kind === 'assistant') {
    // Item settled (no longer streaming): the id-keyed floor and the estimate
    // high-water are no longer relevant — the normal WeakMap-measured path now
    // owns its height. Clear both so a later id reuse / this run cannot leak.
    if (streamingMeasuredRowsById.has(item.id)) streamingMeasuredRowsById.delete(item.id);
    if (streamingEstimateHighWaterById.has(item.id)) streamingEstimateHighWaterById.delete(item.id);
    if (streamingTailEstimateById.has(item.id)) streamingTailEstimateById.delete(item.id);
  }
  const variantKey = transcriptItemVariantKey(item);
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const attached = attachedTool ? 1 : 0;
  const cached = transcriptRowsCache.get(item);
  if (cached
    && cached.columns === columns
    && cached.toolExpanded === toolExpanded
    && cached.attached === attached
    && cached.variantKey === variantKey
    && cached.id === item.id
    && cached.kind === item.kind) {
    return cached.rows;
  }
  const rows = Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded, attachedTool)));
  transcriptRowsCache.set(item, { id: item.id, kind: item.kind, variantKey, columns, toolExpanded, attached, rows });
  return rows;
}

export function buildTranscriptRowIndex(items, {
  columns = 80,
  toolOutputExpanded = false,
  suppressMeasuredRowHeights = false,
  streamingTailItem = null,
} = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const rows = new Array(allItems.length);
  const prefixRows = new Array(allItems.length + 1);
  prefixRows[0] = 0;
  for (let i = 0; i < allItems.length; i++) {
    const item = streamingTailItem && i === allItems.length - 1
      ? streamingTailItem
      : allItems[i];
    const attachedTool = false; // gap restored: every tool card keeps marginTop 1 (see TranscriptItem)
    const measured = suppressMeasuredRowHeights
      ? null
      : measuredTranscriptRows(item, columns, toolOutputExpanded);
    const rowCount = measured != null
      ? measured
      : estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded, attachedTool);
    rows[i] = rowCount;
    prefixRows[i + 1] = prefixRows[i] + rowCount;
  }
  return { rows, prefixRows, totalRows: prefixRows[allItems.length] || 0 };
}

// ── Incremental streaming-tail row-index cache ─────────────────────────────
// On a streaming flush the engine swaps `items` for a fresh array in which
// ONLY the trailing assistant item's text has grown; every settled item ahead
// of it is byte-identical geometry. buildTranscriptRowIndex re-walks all N
// items each flush (O(n) per ~16ms frame) even though only the last row's
// height can change. This cache holds the SETTLED-PREFIX row-index (all items
// except the trailing streaming assistant item) keyed on a stable signature of
// that prefix + columns + expanded + suppress + measuredRowsVersion. When the
// only difference since last flush is the trailing streaming item, we recompute
// just that one tail row and append it to the cached prefixRows. Any structural
// change (item count, non-tail change, columns, expanded, suppress, version)
// invalidates the cache and falls back to a full buildTranscriptRowIndex.
// The cache is per-hook-instance now (passed in as `cacheRef`); there is no
// module-level mutable state to leak across hook instances.

/** True when `items` ends with a streaming assistant item (the growing tail). */
function trailingStreamingItem(allItems) {
  const last = allItems.length > 0 ? allItems[allItems.length - 1] : null;
  return last && last.kind === 'assistant' && last.streaming ? last : null;
}

export function buildTranscriptRowIndexIncremental(items, {
  columns = 80,
  toolOutputExpanded = false,
  suppressMeasuredRowHeights = false,
  measuredRowsVersion = 0,
  cacheRef = null,
  prefixRevision = null,
  streamingTailItem = null,
} = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const tail = streamingTailItem || trailingStreamingItem(allItems);
  // Per-hook-instance cache holder (useRef object). Fall back to a throwaway
  // holder if none supplied so the builder still works in isolation.
  const holder = cacheRef || { current: null };
  // No streaming tail → nothing incremental to exploit; drop any stale cache and
  // do the normal full build. (The memo layer already skips recompute when the
  // structure signature is unchanged, so a settled transcript pays this once.)
  if (!tail) {
    holder.current = null;
    return buildTranscriptRowIndex(allItems, {
      columns, toolOutputExpanded, suppressMeasuredRowHeights, streamingTailItem,
    });
  }
  const prefixLen = allItems.length - 1;
  const cache = holder.current;
  // Prefix identity is carried by the engine's monotonic structure revision.
  // Every settled-item mutation, including same-length middle tool-card patches,
  // bumps it without requiring a render-time walk over the transcript.
  // Fast path: same prefix length + tail id + revision, and columns/expanded/
  // suppress/version all match. Only the tail row can differ → recompute + append.
  if (cache
    && cache.columns === columns
    && cache.toolExpanded === (toolOutputExpanded ? 1 : 0)
    && cache.suppress === suppressMeasuredRowHeights
    && cache.version === measuredRowsVersion
    && cache.prefixLen === prefixLen
    && prefixRevision != null
    && cache.prefixRevision === prefixRevision
    && cache.tailId === tail.id) {
    // revision matches → prefix rows provably unchanged; NO prefix walk / no
    // re-estimation. Only the tail row can differ, recompute it.
    {
      const tailMeasured = suppressMeasuredRowHeights
        ? null
        : measuredTranscriptRows(tail, columns, toolOutputExpanded);
      const tailRows = tailMeasured != null
        ? tailMeasured
        : estimateTranscriptItemRowsCached(tail, columns, toolOutputExpanded);
      // Immutable segmented views append one virtual tail slot to the cached
      // settled prefix. No committed array is mutated and no prefix is copied.
      const totalRows = cache.prefixTotal + tailRows;
      return {
        rows: appendTranscriptRow(cache.prefixRowsArr, tailRows),
        prefixRows: appendTranscriptRow(cache.prefixPrefixRows, totalRows),
        totalRows,
      };
    }
  }
  // Cache miss: full build, then repopulate the settled-prefix cache so the NEXT
  // flush (only the tail grown) takes the fast path. The prefix arrays are the
  // full-build outputs truncated before the tail row — byte-identical to a
  // full rebuild's prefix by construction.
  const full = buildTranscriptRowIndex(allItems, {
    columns, toolOutputExpanded, suppressMeasuredRowHeights, streamingTailItem,
  });
  holder.current = {
    columns,
    toolExpanded: toolOutputExpanded ? 1 : 0,
    suppress: suppressMeasuredRowHeights,
    version: measuredRowsVersion,
    prefixLen,
    prefixRevision,
    tailId: tail.id,
    prefixRowsArr: full.rows.slice(0, prefixLen),
    prefixPrefixRows: full.prefixRows.slice(0, prefixLen + 1),
    prefixTotal: full.prefixRows[prefixLen] || 0,
  };
  return full;
}

// Stable O(1) signature for transcript row-index/window memos. The engine's
// monotonic prefixRevision proves settled-prefix identity; only the live tail
// needs resolving at render time.
export function transcriptStructureSignature(items, columns, toolOutputExpanded, prefixRevision = 0, streamingTailItem = null) {
  const list = Array.isArray(items) ? items : [];
  const tail = streamingTailItem || trailingStreamingItem(list);
  const tailRows = tail
    ? estimateTranscriptItemRowsCached(tail, columns, toolOutputExpanded)
    : 0;
  return `${Math.max(0, Number(prefixRevision) || 0)}|${list.length}|${columns}|${toolOutputExpanded ? 1 : 0}|${tail?.id ?? '_'}:${tailRows}`;
}

export function transcriptRowAt(values, index) {
  if (!values || index < 0 || index >= values.length) return 0;
  return typeof values.atIndex === 'function'
    ? values.atIndex(index)
    : (Number(values[index]) || 0);
}

function appendTranscriptRow(prefix, tailValue) {
  return Object.freeze({
    length: prefix.length + 1,
    atIndex: (index) => index === prefix.length
      ? tailValue
      : (Number(prefix[index]) || 0),
    slice: (start = 0, end = prefix.length + 1) => {
      const values = [];
      const lo = Math.max(0, start < 0 ? prefix.length + 1 + start : start);
      const hi = Math.min(prefix.length + 1, end < 0 ? prefix.length + 1 + end : end);
      for (let index = lo; index < hi; index++) {
        values.push(index === prefix.length ? tailValue : prefix[index]);
      }
      return values;
    },
  });
}

export function transcriptItemsWithStableTail(settledItems, streamingTailItem, cacheRef) {
  const settled = Array.isArray(settledItems) ? settledItems : [];
  if (!streamingTailItem) return settled;
  const previous = cacheRef?.current;
  if (previous
    && previous.settled === settled
    && previous.tailId === streamingTailItem.id) {
    return previous.items;
  }
  const items = [...settled, streamingTailItem];
  if (cacheRef) cacheRef.current = { settled, tailId: streamingTailItem.id, items };
  return items;
}

export function transcriptRenderWindow(items, { scrollOffset = 0, viewportHeight = 24, columns = 80, toolOutputExpanded = false, rowIndex = null } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const itemCount = allItems.length;
  const fallbackIndex = rowIndex?.prefixRows?.length === itemCount + 1
    ? rowIndex
    : buildTranscriptRowIndex(allItems, { columns, toolOutputExpanded });
  const totalRows = Math.max(0, fallbackIndex.totalRows || 0);
  const viewRows = Math.max(1, Number(viewportHeight) || 24);
  const maxScrollRows = Math.max(0, totalRows - viewRows);
  const effectiveScrollOffset = Math.min(
    maxScrollRows,
    Math.max(0, Math.ceil(Number(scrollOffset) || 0)),
  );

  const bypassRowBudget = viewRows + TRANSCRIPT_WINDOW_OVERSCAN_ROWS * 2;
  if (itemCount <= TRANSCRIPT_WINDOW_MIN_ITEMS || totalRows <= bypassRowBudget) {
    return { startIndex: 0, endIndex: itemCount, items: allItems, bottomSpacerRows: 0, totalRows, maxScrollRows, effectiveScrollOffset };
  }

  const minItems = Math.min(TRANSCRIPT_WINDOW_MIN_ITEMS, itemCount);
  // At-bottom (live tail) mounts only viewport + a small overscan; scrolled-up
  // views keep the full overscan/cap so history renders exactly as before.
  const atTail = effectiveScrollOffset === 0;
  const overscanRows = atTail ? TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS : TRANSCRIPT_WINDOW_OVERSCAN_ROWS;
  const maxItems = Math.max(minItems, atTail ? TRANSCRIPT_WINDOW_TAIL_MAX_ITEMS : TRANSCRIPT_WINDOW_MAX_ITEMS);
  const prefixRows = fallbackIndex.prefixRows;
  const visibleTop = Math.max(0, totalRows - effectiveScrollOffset - viewRows);
  const visibleBottom = Math.min(totalRows, totalRows - effectiveScrollOffset);
  const desiredTop = Math.max(0, visibleTop - overscanRows);
  const desiredBottom = Math.min(totalRows, visibleBottom + overscanRows);

  let startIndex = Math.max(0, upperBound(prefixRows, desiredTop) - 1);
  let endIndex = Math.min(itemCount, Math.max(startIndex + 1, lowerBound(prefixRows, Math.max(desiredBottom, desiredTop + 1))));

  while (endIndex - startIndex < minItems && startIndex > 0) startIndex--;
  while (endIndex - startIndex < minItems && endIndex < itemCount) endIndex++;

  if (endIndex - startIndex > maxItems) {
    const visibleStartIndex = Math.max(0, upperBound(prefixRows, visibleTop) - 1);
    const visibleEndIndex = Math.min(itemCount, Math.max(visibleStartIndex + 1, lowerBound(prefixRows, Math.max(visibleBottom, visibleTop + 1))));
    // The cap must never cut into rows needed to fill the viewport: floor it at
    // the item span the visible viewport actually covers, so a run of many short
    // (e.g. one-line) items can't leave the top of the viewport unmounted under
    // the small tail cap. Full-view (scrolled-up) behavior is unchanged: there
    // maxItems already exceeds the visible span, so the floor is a no-op.
    const effectiveMaxItems = Math.max(maxItems, visibleEndIndex - visibleStartIndex);
    startIndex = Math.max(0, Math.min(visibleStartIndex, itemCount - effectiveMaxItems));
    endIndex = Math.min(itemCount, Math.max(visibleEndIndex, startIndex + effectiveMaxItems));
    if (endIndex - startIndex > effectiveMaxItems) startIndex = Math.max(0, endIndex - effectiveMaxItems);
  }

  const bottomSpacerRows = Math.max(0, totalRows - (transcriptRowAt(prefixRows, endIndex) || totalRows));
  return {
    startIndex,
    endIndex,
    items: allItems.slice(startIndex, endIndex),
    bottomSpacerRows,
    totalRows,
    maxScrollRows,
    effectiveScrollOffset,
  };
}
