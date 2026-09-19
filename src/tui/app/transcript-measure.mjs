/**
 * transcript-measure.mjs — the per-commit Yoga height harvest behind
 * transcriptMeasuredRowsCache: the mounted-element maps, the callback-ref
 * factory, the harvest gate and its oscillation breaker.
 *
 * The state object is owned by one useTranscriptWindow instance; nothing here
 * touches React, so the hook decides WHEN the harvest runs (a deps-less layout
 * effect, before the anchor sync).
 */
import {
  TRANSCRIPT_MEASURED_ROWS,
  transcriptMeasuredRowsCache,
  pruneStreamingMeasuredRowsById,
  hasStreamingRowStateToPrune,
  transcriptItemVariantKey,
  estimateTranscriptItemRowsCached,
  transcriptHarvestInputsEqual,
} from './transcript-window.mjs';
import { shouldSuppressFullyFailedToolItem } from '../transcript-tool-failures.mjs';
import { TUI_DEBUG } from '../session/transcript-spill.mjs';

// ── Harvest circuit breaker ────────────────────────────────────────────────
// The harvest is a deps-less layout effect: every measuredRowsVersion bump
// re-renders SYNCHRONOUSLY and re-runs the harvest in the same task. If a
// measurement fails to converge (Yoga height oscillating with the window/offset
// it just changed), React kills the process at >50 nested sync updates
// (minified error #185). Cap consecutive same-task bumps well above the normal
// 1-2-frame settle; past the cap, skip the bump (the caches keep the latest
// heights, the next external render consumes them) and trace the culprits.
const HARVEST_BUMP_STREAK_LIMIT = 10;
let harvestBreakerLogged = false;
function traceHarvestBreaker(changedKeys) {
  // Always report the FIRST trip per process (one stderr line beats a crash);
  // repeat trips only under MIXDOG_TUI_DEBUG=1 to avoid tearing the screen.
  if (harvestBreakerLogged && !TUI_DEBUG) return;
  harvestBreakerLogged = true;
  try {
    process.stderr.write(
      `[tui] measured-rows harvest breaker tripped (oscillating heights): ${changedKeys.slice(0, 8).join(' ')}\n`
    );
  } catch {}
}

function freshGate() {
  return { inputs: null, skippedForDrag: false, forceNext: false };
}

/**
 * Measurement bookkeeping for one transcript window: mounted item id → ink
 * element, id → stable callback ref, id → latest item object, the harvest gate
 * and the same-task bump streak (reset by a 0ms macrotask, which can never fire
 * inside the synchronous layout-effect cascade — so the count is a faithful
 * cascade depth).
 */
export function createMeasureState() {
  return {
    els: new Map(),
    refCache: new Map(),
    items: new Map(),
    gate: freshGate(),
    streak: { count: 0, timer: null },
  };
}

/** A resumed session replaces the transcript atomically; drop every map so the
 *  outgoing session's elements never feed the incoming session's first frame. */
export function resetMeasureState(state) {
  state.els.clear();
  state.refCache.clear();
  state.items.clear();
  state.gate = freshGate();
  state.streak = { count: 0, timer: null };
  if (hasStreamingRowStateToPrune()) pruneStreamingMeasuredRowsById(new Set());
}

/**
 * Stable per-item callback ref. The element is stored under the item id and
 * the live item object is resolved from `state.items` at harvest time, so a
 * reused callback never serves a stale item and React sees no ref churn. The
 * ref(null) path drops the element: an unmounted row simply stops contributing
 * (its last measurement stays cached on the item object).
 */
export function measureRefFor(state, item) {
  if (!TRANSCRIPT_MEASURED_ROWS || !item || item.id == null) return undefined;
  if (shouldSuppressFullyFailedToolItem(item)) {
    transcriptMeasuredRowsCache.delete(item);
    state.els.delete(item.id);
    state.items.delete(item.id);
    return undefined;
  }
  const key = item.id;
  state.items.set(key, item);
  let fn = state.refCache.get(key);
  if (!fn) {
    fn = (el) => {
      if (el) {
        state.els.set(key, el);
      } else {
        state.els.delete(key);
      }
    };
    state.refCache.set(key, fn);
  }
  return fn;
}

function measurementMatches(entry, { columns, toolExpanded, variantKey }) {
  return !!entry && entry.columns === columns && entry.toolExpanded === toolExpanded && entry.variantKey === variantKey;
}

/**
 * True when a row in the mounted slice still lacks a measurement VALID FOR THIS
 * geometry: a just-mounted row has no cache entry until the post-commit harvest
 * records its real height, and an entry left over from a prior
 * columns/tool-expanded/variant is stale. Assistant rows are exact-model owned
 * and never wait for a Yoga commit.
 */
export function mountedSliceAwaitingMeasure(mountedSlice, frameColumns, toolOutputExpanded) {
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  for (const item of mountedSlice) {
    if (!item || shouldSuppressFullyFailedToolItem(item) || item.kind === 'assistant') continue;
    const entry = transcriptMeasuredRowsCache.get(item);
    if (!measurementMatches(entry, { columns: frameColumns, toolExpanded, variantKey: transcriptItemVariantKey(item) })) {
      return true;
    }
  }
  return false;
}

/**
 * Fold one mounted row's real Yoga height into the cache. Returns the change
 * tag for the breaker trace (`del` / the new height) or null when nothing
 * changed. Streaming assistant rows are skipped: their geometry is owned by the
 * deterministic row model, and a second post-commit authority reintroduces the
 * estimate→measure correction jitter.
 */
function measureMountedRow(item, yoga, { frameColumns, toolOutputExpanded }) {
  if (shouldSuppressFullyFailedToolItem(item)) return transcriptMeasuredRowsCache.delete(item) ? 'del' : null;
  // Width 0 = Yoga has not laid this node out yet this frame; skip so a
  // transient 0 never poisons the cache.
  if (typeof yoga.getComputedWidth === 'function' && yoga.getComputedWidth() <= 0) return null;
  const rawMeasured = Math.round(Number(yoga.getComputedHeight?.()) || 0);
  if (rawMeasured <= 0) return transcriptMeasuredRowsCache.delete(item) ? 'del' : null;
  if (item.kind === 'assistant') {
    transcriptMeasuredRowsCache.delete(item);
    return null;
  }
  const measured = Math.max(1, rawMeasured);
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const variantKey = transcriptItemVariantKey(item);
  const prev = transcriptMeasuredRowsCache.get(item);
  if (prev?.rows === measured && measurementMatches(prev, { columns: frameColumns, toolExpanded, variantKey })) return null;
  transcriptMeasuredRowsCache.set(item, { rows: measured, columns: frameColumns, toolExpanded, variantKey });
  // First mount (no prior entry): this frame's row index already used the
  // estimate. Only report a change when Yoga actually corrects it.
  const estimateRows = prev ? -1 : estimateTranscriptItemRowsCached(item, frameColumns, toolOutputExpanded);
  return prev || measured !== estimateRows ? measured : null;
}

/**
 * A measurement that OSCILLATES with the geometry its own bump changes never
 * settles, and the sync cascade would crash with React #185 — the streak
 * breaker caps that. Pinned renders must still consume new measurements, or
 * streaming re-slice growth never reaches the row-index/window memos while
 * following (the newline-jump bug).
 */
function bumpAfterMeasurementChange(state, changedKeys, bumpMeasuredRowsVersion) {
  const streak = state.streak;
  if (streak.count >= HARVEST_BUMP_STREAK_LIMIT) {
    traceHarvestBreaker(changedKeys);
    return;
  }
  streak.count += 1;
  if (!streak.timer) {
    streak.timer = setTimeout(() => {
      streak.timer = null;
      streak.count = 0;
    }, 0);
    if (typeof streak.timer?.unref === 'function') streak.timer.unref();
  }
  // A measurement-driven render gets one confirmation harvest even when no
  // external layout input changed. Stable rows stop there; a real oscillation
  // continues until the breaker trips.
  state.gate.forceNext = true;
  bumpMeasuredRowsVersion();
}

/** Prune the id→item / id→callback maps to the currently-mounted set so they
 *  do not grow unbounded over a long session. */
function pruneMeasureMaps(state) {
  const { els, items, refCache } = state;
  if (items.size > els.size) {
    for (const key of items.keys()) {
      if (!els.has(key)) items.delete(key);
    }
  }
  if (refCache.size > els.size) {
    for (const key of refCache.keys()) {
      if (!els.has(key)) refCache.delete(key);
    }
  }
  if (hasStreamingRowStateToPrune()) pruneStreamingMeasuredRowsById(new Set(items.keys()));
}

/**
 * Post-commit harvest: Yoga has just laid out the mounted rows, so each tracked
 * Box's getComputedHeight() is its REAL terminal height. Fold those into
 * transcriptMeasuredRowsCache and bump measuredRowsVersion only when a height
 * actually changed, so the row-index/window memos recompute once and settle.
 *
 * Skipped while a drag is in progress: edge auto-scroll commits on every
 * pointer motion but the rows' heights do not change — a single re-measure is
 * forced on release. Otherwise skipped when the layout inputs are unchanged
 * since the last harvest, unless a bump asked for a confirmation pass.
 */
export function harvestMeasuredRows(state, { dragActive, inputs, frameColumns, toolOutputExpanded, bumpMeasuredRowsVersion }) {
  if (!TRANSCRIPT_MEASURED_ROWS) return;
  const gate = state.gate;
  if (dragActive) {
    gate.skippedForDrag = true;
    return;
  }
  if (!gate.skippedForDrag && !gate.forceNext && transcriptHarvestInputsEqual(gate.inputs, inputs)) return;
  const els = state.els;
  if (!els || els.size === 0) return;
  gate.inputs = inputs;
  gate.skippedForDrag = false;
  gate.forceNext = false;
  const changedKeys = [];
  for (const [key, el] of els.entries()) {
    const item = state.items.get(key);
    const yoga = el?.yogaNode;
    if (!item || !yoga) continue;
    const change = measureMountedRow(item, yoga, { frameColumns, toolOutputExpanded });
    if (change != null) changedKeys.push(`${key}=${change}`);
  }
  if (changedKeys.length > 0) bumpAfterMeasurementChange(state, changedKeys, bumpMeasuredRowsVersion);
  pruneMeasureMaps(state);
}
