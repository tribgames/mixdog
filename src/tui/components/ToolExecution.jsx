/**
 * components/ToolExecution.jsx — a tool call + its result.
 *
 * Tool call + result layout:
 *   - The call line: `● Tool Name(summary)` where the dot is BLACK_CIRCLE
 *     (2-wide gutter), the tool name is the user-facing label and the argument
 *     summary sits in muted parentheses. NOT raw MCP/internal names.
 *   - The result hangs under a single dim `  ⎿  ` gutter — the gutter is placed
 *     once, not repeated per wrapped line.
 */
import { useSharedTick } from '../hooks/useSharedTick.mjs';
import { normalizeCountMap } from './tool-execution/text-format.mjs';
import { clampFailureCount } from './tool-execution/surface-detail.mjs';
import { renderAggregateToolCard } from './tool-execution/aggregate-card.jsx';
import { renderPendingPlaceholder } from './tool-execution/pending-placeholder.jsx';
import { renderStandardToolCard } from './tool-execution/standard-card.jsx';

const TOOL_BLINK_MS = 500;
const TOOL_PENDING_SHOW_DELAY_MS = 1000;
// One shared-tick cadence covers both the 500ms blink and per-second elapsed;
// finer than either boundary so both stay crisp off a single timer.
const TOOL_ANIM_TICK_MS = TOOL_BLINK_MS;
export function ToolExecution({
  name,
  args,
  result,
  rawResult,
  uiDiff,
  isError,
  errorCount,
  callErrorCount,
  exitErrorCount,
  expanded,
  columns = 80,
  attached = false,
  count = 1,
  completedCount = 0,
  startedAt = 0,
  completedAt = 0,
  aggregate = false,
  categories = {},
  doneCategories = null,
  headerFinalized = true,
  deferredDisplayReady = false,
  // Retain the public prop; ResultBody selects expanded content from rawText.
  agentResponseAggregate: _agentResponseAggregate = false,
}) {
  const rowWidth = Math.max(1, Number(columns || 80));
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const nowMs = Date.now();
  // Single shared tick drives the blink + elapsed re-renders while pending; all
  // phase/elapsed values below are derived from nowMs, so no per-card timers.
  useSharedTick(TOOL_ANIM_TICK_MS, pending);
  const pendingAgeMs = pending && startedAtMs ? Math.max(0, nowMs - startedAtMs) : 0;
  // Derived (was a per-card setTimeout): the pending-show delay has elapsed.
  const pendingDelayElapsed = pending ? !startedAtMs || pendingAgeMs >= TOOL_PENDING_SHOW_DELAY_MS : false;
  // A card that is still pending but already has something to paint (a result
  // landed, or at least one of an aggregate's parallel calls completed) must
  // SKIP the blank placeholder: it was pushed early (engine ensureVisible on a
  // result before the push-delay) so its startedAt is recent and pendingAgeMs <
  // delay, but it has real header counts + a summary to show. Rendering the
  // placeholder instead made an empty card scroll up first and only fill in as
  // each parallel result arrived. Treating "has visible content" as ready lets
  // the card appear already populated and simply grow taller as more results
  // land — no empty band.
  const hasVisibleProgress = doneCount > 0 || Boolean(String(rt || '').trim());
  const pendingDisplayReady = !pending || pendingDelayElapsed || hasVisibleProgress || deferredDisplayReady;
  // Derived blink (was two per-card setIntervals + a setTimeout): while pending,
  // the dot keeps blinking until the tool resolves. Phase comes from Date.now()
  // so the cadence is identical to the old interval without owning a timer.
  const blinkActive = pending && pendingDisplayReady;
  const blinkOn = !blinkActive ? true : Math.floor(nowMs / TOOL_BLINK_MS) % 2 === 0;
  // Keep the action verb in its active form until the engine explicitly seals
  // the tool block. Fast tool batches often complete before the next provider
  // iteration decides whether to call more tools or emit assistant text; flipping
  // "Finding" -> "Found" -> "Finding" during that gap makes the transcript jump.
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  // Real tool-call failures only (provider isError / error toolKind). Drives the
  // ● dot color; command/result failures (shell exit, failed status) are counted
  // in `failedCount`/L2 detail but never in `callFailedCount`, so they never
  // paint the dot red. Fall back to 0 (never `isError`) when the engine did not
  // supply a call-error count so a result failure can't leak into the dot.
  const callFailedCount = clampFailureCount(callErrorCount, groupCount, false);
  // Shell command-exits (ran, non-zero exit). Counted separately so the dot
  // paints the neutral warning "Exit" color instead of red or green success.
  const exitFailedCount = clampFailureCount(exitErrorCount, groupCount, false);
  // apply_patch can commit an ordered prefix before a later section fails.
  // The runtime-provided uiDiff is authoritative evidence of that partial
  // mutation; an empty/missing diff means the invocation failed completely.
  const partialMutation = callFailedCount > 0 && typeof uiDiff === 'string' && Boolean(uiDiff.trim());
  const displayCategories = normalizeCountMap(categories || {});
  // In the DONE state the engine-supplied doneCategories map counts ATTEMPTS
  // (failures included) so the header total matches the 'N Ok · N Failed'
  // detail. The pending/in-flight header keeps the raw call-time counts.
  const normalizedDoneCategories = doneCategories ? normalizeCountMap(doneCategories) : displayCategories;
  // All-failed aggregate collapses doneCategories to zero counts, which would
  // render a blank header. Fall back to the raw call-time counts so the done
  // header is never empty; the 'N Failed' detail still marks the failure.
  const hasDoneCounts = Object.values(normalizedDoneCategories || {}).some(
    (v) => (v && typeof v === 'object' ? Number(v.count || 0) : Number(v || 0)) > 0
  );
  const displayDoneCategories = hasDoneCounts ? normalizedDoneCategories : displayCategories;

  const card = {
    name,
    args,
    result,
    rawResult,
    isError,
    errorCount,
    callErrorCount,
    exitErrorCount,
    expanded,
    columns,
    attached,
    startedAt,
    completedAt,
    aggregate,
    headerFinalized,
    rowWidth,
    groupCount,
    doneCount,
    rt,
    rawRt,
    pending,
    nowMs,
    blinkOn,
    headerPending,
    hasResult,
    hasRawResult,
    failedCount,
    callFailedCount,
    exitFailedCount,
    partialMutation,
    displayCategories,
    displayDoneCategories,
  };

  // While a freshly-started tool is still inside its pending-show delay we used
  // to `return null` (0 rendered rows). But estimateTranscriptItemRows() in
  // app/transcript-row-estimate.mjs counts a collapsed tool item from the moment it is pushed (1 row for
  // a skill surface, 2 rows otherwise), so the scroll/window math reserved that
  // height while the component painted 0. The moment the delay elapsed (or the
  // tool completed) the real card popped in, the rendered transcript grew and
  // shoved the content above it — the "new tool card jumps up/down as it
  // settles" bug. Reserve the SAME height the estimator predicts with blank
  // content instead, so the card occupies a constant height for its whole
  // lifecycle and nothing reflows when the real header/detail fill in place.
  if (pending && !pendingDisplayReady) {
    return renderPendingPlaceholder(card);
  }

  // ── Aggregate card ──────────────────────────────────────────────
  if (aggregate) {
    return renderAggregateToolCard(card);
  }

  return renderStandardToolCard(card);
}
