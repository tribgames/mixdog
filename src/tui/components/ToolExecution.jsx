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
import React from 'react';
import { Box, Text } from 'ink';
import { useSharedTick } from '../hooks/useSharedTick.mjs';
import stringWidth from 'string-width';
import { theme, TURN_MARKER, AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER } from '../theme.mjs';
import { formatElapsed } from '../time-format.mjs';
import { BULLET_OPERATOR } from '../figures.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  formatAggregateHeader,
} from '../../runtime/shared/tool-surface.mjs';
import { deriveToolCardModel } from '../../runtime/shared/tool-card-model.mjs';
import {
  MIN_RESULT_LINE_CHARS,
  RESULT_LINE_HARD_MAX,
  SUMMARY_MAX_CHARS,
  HEADER_FAILURE_STATUS_MAX,
  safeInlineText,
  normalizeCountMap,
  truncateToWidth,
  resultTerminalStatus,
  stripLeadingStatusMarkerLines,
  stripLeadingStatusMarkerFromText,
} from './tool-execution/text-format.mjs';
import {
  SKILL_SURFACE_NAMES,
  isAgentTool,
  clampFailureCount,
  toolStatusColor,
} from './tool-execution/surface-detail.mjs';
import { ResultBody } from './tool-execution/ResultBody.jsx';

export function displayToolName(name, args) {
  return surfaceDisplayToolName(name, args);
}

const TOOL_BLINK_MS = 500;
const TOOL_PENDING_SHOW_DELAY_MS = 1000;
// One shared-tick cadence covers both the 500ms blink and per-second elapsed;
// finer than either boundary so both stay crisp off a single timer.
const TOOL_ANIM_TICK_MS = TOOL_BLINK_MS;
export function ToolExecution({ name, args, result, rawResult, isError, errorCount, callErrorCount, exitErrorCount, expanded, columns = 80, attached = false, count = 1, completedCount = 0, startedAt = 0, completedAt = 0, aggregate = false, categories = {}, doneCategories = null, headerFinalized = true, deferredDisplayReady = false, agentResponseAggregate = false }) {
  const rowWidth = Math.max(1, Number(columns || 80));
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const nowMs = Date.now();
  // Single shared tick drives the blink + elapsed re-renders while pending; all
  // phase/elapsed values below are derived from nowMs, so no per-card timers.
  useSharedTick(TOOL_ANIM_TICK_MS, pending);
  const pendingAgeMs = pending && startedAtMs ? Math.max(0, nowMs - startedAtMs) : 0;
  // Derived (was a per-card setTimeout): the pending-show delay has elapsed.
  const pendingDelayElapsed = pending
    ? (!startedAtMs || pendingAgeMs >= TOOL_PENDING_SHOW_DELAY_MS)
    : false;
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
  const pendingDisplayReady = !pending || !startedAtMs || pendingDelayElapsed || pendingAgeMs >= TOOL_PENDING_SHOW_DELAY_MS || hasVisibleProgress || deferredDisplayReady;
  // Derived blink (was two per-card setIntervals + a setTimeout): while pending,
  // the dot keeps blinking until the tool resolves. Phase comes from Date.now()
  // so the cadence is identical to the old interval without owning a timer.
  const blinkActive = pending && pendingDisplayReady;
  const blinkOn = !blinkActive
    ? true
    : Math.floor(nowMs / TOOL_BLINK_MS) % 2 === 0;
  // Keep the action verb in its active form until the engine explicitly seals
  // the tool block. Fast tool batches often complete before the next provider
  // iteration decides whether to call more tools or emit assistant text; flipping
  // "Finding" -> "Found" -> "Finding" during that gap makes the transcript jump.
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const elapsedMs = startedAtMs ? Math.max(0, (pending ? nowMs : (completedAtMs || nowMs)) - startedAtMs) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  // Real tool-call failures only (backend isError / error toolKind). Drives the
  // ● dot color; command/result failures (shell exit, failed status) are counted
  // in `failedCount`/L2 detail but never in `callFailedCount`, so they never
  // paint the dot red. Fall back to 0 (never `isError`) when the engine did not
  // supply a call-error count so a result failure can't leak into the dot.
  const callFailedCount = clampFailureCount(callErrorCount, groupCount, false);
  // Shell command-exits (ran, non-zero exit). Counted separately so the dot
  // paints the neutral warning "Exit" color instead of red or green success.
  const exitFailedCount = clampFailureCount(exitErrorCount, groupCount, false);
  const displayGroupCount = groupCount;
  const displayCategories = normalizeCountMap(categories || {});
  // In the DONE state the engine-supplied doneCategories map counts ATTEMPTS
  // (failures included) so the header total matches the 'N Ok · N Failed'
  // detail. The pending/in-flight header keeps the raw call-time counts.
  const normalizedDoneCategories = doneCategories ? normalizeCountMap(doneCategories) : displayCategories;
  // All-failed aggregate collapses doneCategories to zero counts, which would
  // render a blank header. Fall back to the raw call-time counts so the done
  // header is never empty; the 'N Failed' detail still marks the failure.
  const hasDoneCounts = Object.values(normalizedDoneCategories || {}).some(
    (v) => (v && typeof v === 'object' ? Number(v.count || 0) : Number(v || 0)) > 0,
  );
  const displayDoneCategories = hasDoneCounts ? normalizedDoneCategories : displayCategories;

  // While a freshly-started tool is still inside its pending-show delay we used
  // to `return null` (0 rendered rows). But estimateTranscriptItemRows() in
  // App.jsx counts a collapsed tool item from the moment it is pushed (1 row for
  // a skill surface, 2 rows otherwise), so the scroll/window math reserved that
  // height while the component painted 0. The moment the delay elapsed (or the
  // tool completed) the real card popped in, the rendered transcript grew and
  // shoved the content above it — the "new tool card jumps up/down as it
  // settles" bug. Reserve the SAME height the estimator predicts with blank
  // content instead, so the card occupies a constant height for its whole
  // lifecycle and nothing reflows when the real header/detail fill in place.
  if (pending && !pendingDisplayReady) {
    // Mirror estimateTranscriptItemRows: a non-aggregate skill surface collapses
    // to a single header row; everything else reserves header + one detail row.
    const placeholderNormalizedName = String(formatToolSurface(name, args)?.normalizedName || '').toLowerCase();
    // Skill AND agent surfaces collapse to a single header row when collapsed
    // (see estimateTranscriptItemRows); reserve one row for both.
    const placeholderSingleRow = !aggregate
      && (SKILL_SURFACE_NAMES.has(placeholderNormalizedName) || isAgentTool(placeholderNormalizedName));
    return (
      <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
        <Text> </Text>
        {placeholderSingleRow ? null : <Text> </Text>}
      </Box>
    );
  }

  // ── Aggregate card ──────────────────────────────────────────────
  if (aggregate) {
    // Pending aggregate headers omit counts so intermediate tool batches do not
    // bounce between "Reading 1 item" and "Reading 4 items". Final counts and
    // result summaries appear only after completion.
    const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
    // No stableVerbWidth: see statusCopy — the padding only left a mid-header
    // gap ("Searched  1 pattern, Read    1 file") since Ink trims trailing
    // spaces and never stabilized the flip.
    const headerText = safeInlineText(formatAggregateHeader((headerPending ? displayCategories : displayDoneCategories) || {}, { pending: headerPending, order: headerOrder }));
    let detailText;
    if (hasResult) {
      // The aggregate card reserves EXACTLY ONE detail row when it is not
      // expanded-with-raw (App.jsx estimateTranscriptItemRows counts
      // margin + header + 1 detail row for the no-raw aggregate case). The
      // summary `rt` can be multiline; a single <Text> containing '\n' renders
      // MULTIPLE terminal rows, which desyncs the estimate and makes the card
      // "settle" taller than reserved. Collapse to a single logical line
      // (whitespace-normalized); fitResultLine below trims it to the column
      // width so it can never exceed one terminal row.
      detailText = safeInlineText(rt);
    } else {
      detailText = '';
    }

    // Resolve the aggregate's terminalStatus from the collapsed detail `rt`
    // (which carries a `[status: cancelled]`/`<status>` marker when the
    // aggregate was cancelled) plus isError/failedCount for failures. Pending
    // stays running; a clean completion stays success. toolStatusColor is the
    // single source of dot color for both aggregate and normal cards.
    const aggregateTerminalStatus = pending
      ? 'running'
      : (resultTerminalStatus(rt) || (isError || failedCount > 0 ? 'failed' : 'completed'));
    const dotColor = toolStatusColor({ pending, groupCount, callFailedCount, exitFailedCount, terminalStatus: aggregateTerminalStatus });
    const dotText = pending && !blinkOn ? ' ' : TURN_MARKER;
    const gutter = 2;
    const showHeaderExpandHint = hasRawResult;
    const hintLabel = `ctrl+o ${expanded ? 'collapse' : 'expand'}`;
    const hintText = ` ${BULLET_OPERATOR} ${hintLabel}`;
    // The header right-side trailing slot only ever shows the ctrl+o hint. The
    // pending elapsed meta was removed from the header — it lives on the detail
    // row now (`Running · 12s`) so a per-second digit change never reflows the
    // header. Still reserve the hint slot for the whole lifecycle so the body
    // clip point stays fixed when the hint appears on completion.
    const rightReserve = stringWidth(hintText);
    const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - rightReserve);
    const trailingText = showHeaderExpandHint ? hintText : '';
    const trailingColor = theme.subtle;
    const clippedHeader = stringWidth(headerText) > avail
      ? truncateToWidth(headerText, avail)
      : headerText;
    // Trailing content (ctrl+o hint only; pending elapsed lives on the detail
    // row) sits immediately after the header body — no fixed right-edge pin — so
    // it never jumps to the right edge and snaps back on the pending→done flip.
    // Keep the aggregate card at a fixed height (header + one detail row) for
    // its whole lifecycle. Pending cards have no result yet, so reserve the
    // detail row up front instead of growing from 1→2 rows when the summary
    // lands on completion — that late row push is the "line-jump" jump. The empty
    // placeholder renders as a blank line under the ⎿ gutter; the final summary
    // simply fills it in place. This matches estimateTranscriptItemRows (always
    // 2 + resultRows), so windowing/scroll stay in lockstep too.
    // When there is no summary yet (pending) or none could be derived, fill the
    // reserved detail row with a status word instead of a blank line so the area
    // under the ⎿ gutter never looks empty. Real summaries keep the normal text
    // color; the status placeholder is rendered dim.
    const isPlaceholderDetail = !(expanded && hasRawResult) && !detailText;
    const showRawAggregate = expanded && hasRawResult;
    // Aggregate cards intentionally omit elapsed time once grouped. A brief
    // `Running · 1s` tick during the grouped→finished handoff reads as visual
    // noise, and the grouped header already communicates that work is active.
    // The placeholder tracks `pending` (real completion), NOT headerPending:
    // the header verb stays active until the block seals, but the detail row
    // must not keep saying "Running" after every call already resolved.
    const pendingPlaceholder = pending
      ? 'Running'
      : 'Finished';
    const detailLines = showRawAggregate
      ? rawRt.split('\n')
      : (detailText ? [detailText] : [pendingPlaceholder]);
    const aggregateDetailColor = isPlaceholderDetail ? theme.subtle : theme.text;
    return (
      <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
        <Box flexDirection="row" width={rowWidth} overflow="hidden">
          <Box flexShrink={0} minWidth={2}>
            <Text color={dotColor}>{dotText}</Text>
          </Box>
          <Text wrap="truncate">
            <Text bold color={theme.text}>{clippedHeader}</Text>
            {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
          </Text>
        </Box>
        <ResultBody
          lines={detailLines}
          rawText={rawRt || ''}
          columns={columns}
          color={aggregateDetailColor}
          raw={showRawAggregate}
        />
      </Box>
    );
  }

  // ── Normal (non-aggregate) tool card ────────────────────────────
  // Single source: the shared collapsed-card derivation (labels, casing,
  // status merging, detail row) consumed by BOTH the TUI and the desktop
  // renderer (apps/desktop TranscriptView ToolCard). Width fitting, theme
  // colors, blink, and expansion handling stay TUI-side below.
  const maxResultChars = Math.min(RESULT_LINE_HARD_MAX, Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7));
  const model = deriveToolCardModel({
    name,
    args,
    result,
    rawResult,
    isError,
    errorCount,
    callErrorCount,
    exitErrorCount,
    count: displayGroupCount,
    completedCount: doneCount,
    startedAt,
    completedAt,
    headerFinalized,
    nowMs,
  }, { truncate: truncateToWidth, maxResultChars });
  const {
    labelText,
    summaryText,
    headerFailureText: headerFailureStatus,
    detailLine: collapsedDetailLine,
    detailIsPlaceholder,
    terminalStatus,
    normalizedName,
    isShellSurface,
    isAgentSurfaceCard,
    isAgentResponse,
    isBackgroundMetadataResult,
    hasDisplayResult,
    hasDisplayBody,
    displayedResultBodyText,
    firstResultLine,
    totalLines,
    resultSummary,
    shellCollapsedSummary,
    toolArgPath,
  } = model;
  const lines = displayedResultBodyText ? displayedResultBodyText.split('\n') : [];
  const resultColor = theme.text;
  const firstResultLineClipped = hasDisplayBody && stringWidth(firstResultLine) > maxResultChars;
  const hasHiddenDetail = !pending && hasDisplayBody && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));
  const backgroundMetadataExpandable = isBackgroundMetadataResult && hasRawResult && !pending;
  const showRawResult = expanded && (hasDisplayBody || hasRawResult)
    && (!isBackgroundMetadataResult || hasRawResult);
  const detailLines = showRawResult
    ? (agentResponseAggregate && hasRawResult
      ? stripLeadingStatusMarkerLines(rawRt.split('\n'))
      : (hasDisplayBody ? lines : (rawRt ? stripLeadingStatusMarkerLines(rawRt.split('\n')) : [])))
    : (collapsedDetailLine ? [collapsedDetailLine] : []);
  const isPendingPlaceholderDetail = !showRawResult && detailIsPlaceholder;
  const detailColor = isPendingPlaceholderDetail ? theme.subtle : theme.text;
  // Skill/agent collapsed gating lives in the shared model (detailLine).
  const visibleDetailLines = detailLines;
  const finalStatusColor = toolStatusColor({ pending, groupCount, callFailedCount, exitFailedCount, terminalStatus });
  const dotColor = finalStatusColor;
  // Agent surface cards use directional markers: `←` for requests going OUT
  // (spawn/send/etc.) and `→` for the response coming back IN. Background
  // task cards (shell async / explore / search / task) and every other tool
  // keep the BLACK_CIRCLE turn marker. Blink behavior is shared.
  const markerGlyph = isAgentResponse
    ? AGENT_RESPONSE_MARKER
    : (isAgentSurfaceCard ? AGENT_CALL_MARKER : TURN_MARKER);
  // Directional arrow markers (`←` spawn/send out, `→` response back) render 2
  // cells wide in some terminals (Windows Terminal / Cascadia) while our width
  // math counts them as 1, so the `Box minWidth={2}` gutter padding gets
  // overdrawn and the label glues to the arrow ("←Spawn"). Carry an explicit
  // trailing space in the marker string so the gap is a real character that
  // survives regardless of how wide the terminal actually draws the glyph. The
  // `●` turn marker is a true 1-cell glyph and keeps the padding-only gutter.
  const isDirectionalMarker = isAgentResponse || isAgentSurfaceCard;
  const markerText = isDirectionalMarker ? `${markerGlyph} ` : markerGlyph;
  const dotText = pending && !blinkOn ? ' ' : markerText;
  // Agent cards hide their collapsed body but still expose ctrl+o expand only
  // when expanding would actually reveal something: an agent response body, or a
  // multiline / clipped raw result (e.g. the "agents: N …" worker list). A
  // status-only single-line metadata result has nothing extra to show, so it
  // gets no hint.
  const agentHasExpandableBody = isAgentSurfaceCard && !pending && hasResult
    && (isAgentResponse || totalLines > 1 || firstResultLineClipped);
  // Agent cards gate the hint solely on agentHasExpandableBody — never on
  // hasHiddenDetail, which goes true for any single-line resultSummary and would
  // wrongly show ctrl+o on a status-only one-liner that has nothing to expand.
  const shellHasExpandableBody = isShellSurface && !pending && hasDisplayResult
    && hasDisplayBody
    && (totalLines > 1 || firstResultLineClipped || Boolean(shellCollapsedSummary && shellCollapsedSummary !== firstResultLine));
  const showHeaderExpandHint = (isShellSurface ? shellHasExpandableBody : (isAgentSurfaceCard ? agentHasExpandableBody : (hasHiddenDetail || backgroundMetadataExpandable)))
    && normalizedName !== 'load_tool';
  const expandHintColor = theme.subtle;

  // Build a single-line header that never wraps: reserve width for the fixed
  // trailing expand hint plus the dot gutter and a 1-col Windows last-column
  // safety margin, then truncate label/summary to fit. Pending state is already
  // shown by the verb (Running/Reading/etc.), the blinking dot, and the detail
  // row, so avoid an extra standalone ellipsis between parenthesized segments.
  const gutter = 2;
  const hintLabel = showHeaderExpandHint ? `ctrl+o ${expanded ? 'collapse' : 'expand'}` : '';
  const hintText = hintLabel ? ` ${BULLET_OPERATOR} ${hintLabel}` : '';
  // The header right-side trailing slot only ever shows the ctrl+o hint. The
  // pending elapsed meta was removed from the header — it lives on the detail
  // row now (`Running · 12s`) so a per-second digit change (9s→10s) or the
  // pending→done swap never reflows the header. The hint slot is reserved for
  // the whole lifecycle (even while pending) so its later appearance on
  // completion does not push the body clip point.
  const hintReserveLabel = `ctrl+o ${expanded ? 'collapse' : 'expand'}`;
  const hintReserveText = ` ${BULLET_OPERATOR} ${hintReserveLabel}`;
  const headerFailureText = headerFailureStatus
    ? truncateToWidth(headerFailureStatus, HEADER_FAILURE_STATUS_MAX)
    : '';
  const inlineFailureText = headerFailureText ? ` ${BULLET_OPERATOR} ${headerFailureText}` : '';
  const rightReserve = stringWidth(hintReserveText) + stringWidth(inlineFailureText);
  const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - rightReserve);
  const trailingText = showHeaderExpandHint ? hintText : '';
  const trailingColor = expandHintColor;
  let labelOut;
  let summaryOut;
  if (stringWidth(labelText) >= avail) {
    labelOut = truncateToWidth(labelText, avail);
    summaryOut = '';
  } else {
    labelOut = labelText;
    const summaryBudget = avail - stringWidth(labelText) - (summaryText ? stringWidth(' ()') : 0);
    // Cap by both the remaining header width and a fixed max so long
    // paths/queries get an ellipsis instead of dominating the line.
    const summaryWidth = Math.max(0, Math.min(summaryBudget, SUMMARY_MAX_CHARS));
    const truncatedSummary = summaryText && summaryWidth > 0
      ? truncateToWidth(summaryText, summaryWidth)
      : '';
    summaryOut = truncatedSummary ? ` (${truncatedSummary})` : '';
  }
  // Keep trailing content (ctrl+o hint only; pending elapsed lives on the detail
  // row) attached directly after the body for the whole lifecycle. The
  // fixed-column pin previously used for elapsed is what made the trailing text
  // jump to the right edge and snap back on the pending→done flip, so there is no
  // pad. `avail` stays reserved (rightReserve) so the body clip point never reflows.
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1} overflow="hidden" minWidth={0}>
          <Box flexDirection="row">
            <Box flexShrink={0} minWidth={2}>
              <Text color={dotColor}>{dotText}</Text>
            </Box>
            <Text wrap="truncate">
              <Text bold color={theme.text}>{labelOut}</Text>
              {summaryOut ? <Text color={theme.text}>{summaryOut}</Text> : null}
              {inlineFailureText ? <Text color={theme.error}>{inlineFailureText}</Text> : null}
              {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
            </Text>
          </Box>
        </Box>
      </Box>

      <ResultBody
        lines={visibleDetailLines}
        rawText={hasDisplayBody ? displayedResultBodyText : stripLeadingStatusMarkerFromText(rawRt || '')}
        pathArg={toolArgPath}
        isShell={isShellSurface}
        columns={columns}
        color={showRawResult ? resultColor : detailColor}
        raw={showRawResult}
      />
    </Box>
  );
}
