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
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, TURN_MARKER, AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER } from '../theme.mjs';
import { formatElapsed } from '../time-format.mjs';
import { BULLET_OPERATOR } from '../figures.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  summarizeToolResult as surfaceSummarizeToolResult,
  formatAggregateHeader,
  formatToolActionHeader,
  summarizeAgentSurfaceBrief,
  AGENT_SURFACE_BRIEF_MAX,
} from '../../runtime/shared/tool-surface.mjs';
import { isBackgroundErrorOnlyBody, backgroundTaskFailureStatusLabel } from '../../runtime/shared/err-text.mjs';
import {
  MIN_RESULT_LINE_CHARS,
  RESULT_LINE_HARD_MAX,
  SUMMARY_MAX_CHARS,
  HEADER_FAILURE_STATUS_MAX,
  safeInlineText,
  normalizeCountMap,
  truncateToWidth,
  shellResultElapsed,
  normalizeTerminalStatus,
  resultTerminalStatus,
  stripLeadingStatusMarkerLines,
  stripLeadingStatusMarkerFromText,
} from './tool-execution/text-format.mjs';
import {
  SKILL_SURFACE_NAMES,
  isShellTool,
  shellDisplayStatus,
  shellHeader,
  isAgentTool,
  isBackgroundTaskTool,
  agentResponseTitle,
  agentActionTitle,
  agentActionSummary,
  hasAgentResponseResult,
  resolveBackgroundTaskMeta,
  backgroundTaskElapsed,
  prefixElapsed,
  mergeTerminalDetail,
  shouldPrefixSyncElapsed,
  backgroundTaskResultTitle,
  backgroundTaskActionTitle,
  backgroundTaskFailureDetail,
  backgroundTaskDetail,
  isBackgroundTaskResponseArgs,
  genericCompletedDetail,
  toolSearchLoadedSummary,
  agentTerminalDetail,
  clampFailureCount,
  toolStatusColor,
} from './tool-execution/surface-detail.mjs';
import { ResultBody } from './tool-execution/ResultBody.jsx';

export function displayToolName(name, args) {
  return surfaceDisplayToolName(name, args);
}

const TOOL_BLINK_MS = 500;
const TOOL_BLINK_LIMIT_MS = 3000;
const TOOL_PENDING_SHOW_DELAY_MS = 1000;
function statusCopy(name, label, count, doneCount, pending, isError, args = {}) {
  // No stableVerbWidth padding: it padded the done verb to the active ("-ing")
  // width, which Ink trims at the line END (vendor output trimEnd) so it never
  // stabilized the pending→done flip — it only left an UGLY mid-header gap
  // ("Searched  1 pattern", "Read    1 file"). The header is wrap="truncate"
  // behind a fixed gutter and the fullscreen full-clear repaints the row, so
  // dropping the pad just normalizes the spacing.
  return formatToolActionHeader(name, args, { pending, count });
}
export function ToolExecution({ name, args, result, rawResult, isError, errorCount, expanded, columns = 80, attached = false, count = 1, completedCount = 0, startedAt = 0, completedAt = 0, aggregate = false, categories = {}, headerFinalized = true, deferredDisplayReady = false }) {
  const rowWidth = Math.max(1, Number(columns || 80));
  const [blinkOn, setBlinkOn] = useState(true);
  const [blinkExpired, setBlinkExpired] = useState(false);
  const [pendingDelayElapsed, setPendingDelayElapsed] = useState(false);
  const [, setElapsedTick] = useState(0);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const pendingAgeMs = pending && startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0;
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
  // Keep the action verb in its active form until the engine explicitly seals
  // the tool block. Fast tool batches often complete before the next provider
  // iteration decides whether to call more tools or emit assistant text; flipping
  // "Finding" -> "Found" -> "Finding" during that gap makes the transcript jump.
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const elapsedMs = startedAtMs ? Math.max(0, (pending ? Date.now() : (completedAtMs || Date.now())) - startedAtMs) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  const displayGroupCount = groupCount;
  const displayCategories = normalizeCountMap(categories || {});

  useEffect(() => {
    if (!pending) {
      setPendingDelayElapsed(false);
      return undefined;
    }
    const started = Number(startedAt || 0);
    if (!started) {
      setPendingDelayElapsed(true);
      return undefined;
    }
    const remaining = TOOL_PENDING_SHOW_DELAY_MS - Math.max(0, Date.now() - started);
    if (remaining <= 0) {
      setPendingDelayElapsed(true);
      return undefined;
    }
    setPendingDelayElapsed(false);
    const timer = setTimeout(() => setPendingDelayElapsed(true), remaining);
    return () => clearTimeout(timer);
  }, [pending, startedAt]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady || blinkExpired) {
      setBlinkOn(true);
      return undefined;
    }
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [pending, pendingDisplayReady, blinkExpired]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady) {
      setBlinkExpired(false);
      return undefined;
    }
    const started = Number(startedAt || 0);
    const remaining = TOOL_BLINK_LIMIT_MS - (started ? Math.max(0, Date.now() - started) : 0);
    if (remaining <= 0) {
      setBlinkExpired(true);
      return undefined;
    }
    setBlinkExpired(false);
    const timer = setTimeout(() => setBlinkExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [pending, pendingDisplayReady, startedAt]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady || !startedAtMs) return undefined;
    const timer = setInterval(() => setElapsedTick((tick) => (tick + 1) % 1000000), 1000);
    return () => clearInterval(timer);
  }, [pending, pendingDisplayReady, startedAtMs]);

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
    // Skill surfaces collapse to a single header row; agent surfaces reserve
    // header + one brief detail row (see estimateTranscriptItemRows).
    const placeholderSingleRow = !aggregate && SKILL_SURFACE_NAMES.has(placeholderNormalizedName);
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
    const headerText = safeInlineText(formatAggregateHeader(displayCategories || {}, { pending: headerPending, order: headerOrder }));
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
    const dotColor = toolStatusColor({ pending, groupCount, failedCount, terminalStatus: aggregateTerminalStatus });
    const dotText = pending && !blinkExpired && !blinkOn ? ' ' : TURN_MARKER;
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
  const { label, summary, normalizedName, args: parsedArgs } = formatToolSurface(name, args);
  const isShellSurface = isShellTool(normalizedName, label);
  const isSkillSurface = SKILL_SURFACE_NAMES.has(String(normalizedName || '').toLowerCase());
  const backgroundMeta = !pending && isBackgroundTaskTool(normalizedName)
    ? resolveBackgroundTaskMeta(parsedArgs, rt || '')
    : null;
  const backgroundError = backgroundMeta?.error || parsedArgs?.error || '';
  const errorOnlyResult = Boolean(rt) && isBackgroundErrorOnlyBody(rt, backgroundError);
  const backgroundResultText = backgroundMeta?.hasResponse ? backgroundMeta.body : '';
  const displayedResultText = backgroundResultText || (errorOnlyResult ? '' : (rt || ''));
  const hasDisplayResult = Boolean(String(displayedResultText || '').trim());
  const displayedResultBodyText = stripLeadingStatusMarkerFromText(displayedResultText);
  const hasDisplayBody = Boolean(String(displayedResultBodyText || '').trim());
  const lines = displayedResultBodyText ? displayedResultBodyText.split('\n') : [];
  const totalLines = lines.length;
  // Semantic one-line summary derived purely from name/args/result text.
  // Shown in the collapsed, non-error view in place of the raw result block.
  // Grouped cards ("Searched N files" / "Read N files") get the same treatment
  // as single calls: a one-line semantic summary stands in for the raw block.
  const resultSummary = !pending && hasDisplayBody
    ? surfaceSummarizeToolResult(name, args, displayedResultBodyText, isError)
    : null;
  // Same fit budget fitResultLine() uses, to detect a line that will be clipped.
  const maxResultChars = Math.min(RESULT_LINE_HARD_MAX, Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7));
  const resultColor = theme.text;
  const firstResultLine = hasDisplayResult ? String(lines[0] ?? '') : '';
  const firstResultLineClipped = hasDisplayBody && stringWidth(firstResultLine) > maxResultChars;
  const hasHiddenDetail = !pending && hasDisplayBody && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));
  const shellStatus = isShellSurface ? shellDisplayStatus({ pending, failedCount, isError, result: displayedResultText }) : '';
  const shellElapsed = isShellSurface ? (shellResultElapsed(displayedResultText) || elapsed) : '';
  const backgroundElapsed = backgroundMeta
    ? backgroundTaskElapsed(backgroundMeta, elapsed)
    : (isBackgroundTaskTool(normalizedName) ? backgroundTaskElapsed(parsedArgs, elapsed) : '');

  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  // Audit HIGH: on a FAILED view_image the path detail used to win over the
  // error cause (nonShellDetail order puts imageDetail before genericDetail),
  // so the card showed the filename instead of why it failed. Suppress the
  // path detail on error; the error-cause summary/first line takes the row.
  const imageDetail = normalizedName === 'view_image' && toolArgPath && !isError ? String(toolArgPath) : '';
  const isBackgroundResult = !pending && isBackgroundTaskTool(normalizedName) && Boolean(backgroundMeta);
  const isBackgroundResponse = isBackgroundResult && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
  const isBackgroundMetadataResult = isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta);
  const backgroundMetadataFailureLabel = isBackgroundMetadataResult
    ? backgroundTaskFailureDetail(backgroundMeta, parsedArgs)
    : '';
  const backgroundMetadataHeaderFailure = Boolean(backgroundMetadataFailureLabel) && !hasDisplayResult
    ? backgroundMetadataFailureLabel
    : '';
  const agentHeaderFailure = !pending && isAgentTool(normalizedName) && isError && parsedArgs?.error && !hasDisplayResult
    ? backgroundTaskFailureStatusLabel(parsedArgs?.status, parsedArgs?.error, { surface: 'agent' })
    : '';
  const headerFailureStatus = backgroundMetadataHeaderFailure || agentHeaderFailure || '';
  const agentCompletionDetail = !pending && isAgentTool(normalizedName) && !agentHeaderFailure
    ? agentTerminalDetail(parsedArgs?.status, isError, elapsed, parsedArgs?.error)
    : '';
  const agentDetail = !pending && isAgentTool(normalizedName) && !hasDisplayResult
    ? agentCompletionDetail
    : '';
  const genericDetail = !pending && !isShellSurface && !agentDetail && !imageDetail && !resultSummary
    ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
    : '';
  const terminalStatus = pending
    ? 'running'
    : (shellStatus || normalizeTerminalStatus(backgroundMeta?.status) || normalizeTerminalStatus(parsedArgs?.status) || resultTerminalStatus(displayedResultText) || (isError || failedCount > 0 ? 'failed' : 'completed'));
  const backgroundMetadataDetail = isBackgroundMetadataResult && !backgroundMetadataHeaderFailure
    ? backgroundTaskDetail(backgroundMeta, backgroundElapsed, parsedArgs)
    : '';
  const backgroundResponseDetail = isBackgroundResponse && resultSummary
    ? prefixElapsed(resultSummary, backgroundElapsed)
    : resultSummary;
  const syncElapsedDetail = !isBackgroundResponse && shouldPrefixSyncElapsed(normalizedName, label)
    ? prefixElapsed(backgroundResponseDetail, elapsed)
    : backgroundResponseDetail;
  const nonShellDetail = backgroundMetadataDetail || (/^(Cancelled|Failed|Finished)$/i.test(resultSummary || '') && agentCompletionDetail
    ? agentCompletionDetail
    : syncElapsedDetail) || agentDetail || imageDetail || genericDetail;
  // A pending non-aggregate tool used to drop its detail row entirely
  // (collapsedDetail = ''), so the card rendered as a single header row. But
  // estimateTranscriptItemRows() in App.jsx reserves 2 rows for a collapsed
  // non-aggregate tool (1 only for skill surfaces). That left a 1-row gap that
    // closed the instant the result landed — the surviving "line-jump". Reserve the same
  // dim placeholder detail row the aggregate card uses (`Running`) for the whole
  // pending lifecycle so the height stays fixed at header + one detail row and
  // the final summary just fills in place. Skill surfaces collapse to a single
  // row in BOTH the estimate and the render (visibleDetailLines drops the row
  // for isSkillSurface below), so they get no placeholder.
  const pendingDetailPlaceholder = pending && !isSkillSurface
    ? (elapsed ? `Running · ${elapsed}` : 'Running')
    : '';
  const shellCollapsedSummary = isShellSurface && !pending && hasDisplayResult
    ? (resultSummary || truncateToWidth(firstResultLine, Math.min(120, maxResultChars)))
    : resultSummary;
  const collapsedDetail = pending
    ? pendingDetailPlaceholder
    : isShellSurface
      ? prefixElapsed(mergeTerminalDetail(shellStatus, shellCollapsedSummary), shellElapsed)
      : mergeTerminalDetail(terminalStatus, nonShellDetail);
  const backgroundMetadataExpandable = isBackgroundMetadataResult && hasRawResult && !pending;
  const showRawResult = expanded && (hasDisplayBody || hasRawResult)
    && (!isBackgroundMetadataResult || hasRawResult);
  const detailLines = showRawResult
    ? (hasDisplayBody ? lines : (rawRt ? stripLeadingStatusMarkerLines(rawRt.split('\n')) : []))
    : (collapsedDetail ? [collapsedDetail] : []);
  const isPendingPlaceholderDetail = !showRawResult && Boolean(pendingDetailPlaceholder);
  const detailColor = isPendingPlaceholderDetail ? theme.subtle : theme.text;

  const isAgentResult = !isBackgroundResult && !pending && isAgentTool(normalizedName) && hasDisplayResult;
  const isAgentResponse = isAgentResult && hasAgentResponseResult(rt);
  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard && !showRawResult
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || '', { isError, isResponse: isAgentResponse })
    : '';
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncateToWidth(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : '';
  // Skill loads carry the skill name in the header already
  // ("Loaded 1 skill (name)"); the collapsed detail row just repeats it, so
  // drop it and keep the card a single line. Expanding (ctrl+o) still shows the
  // full skill body via the raw-result path.
  // Agent spawn/send/response cards show a tight brief under the ⎿ gutter when
  // collapsed; ctrl+o expand still surfaces the full body.
  let visibleDetailLines = detailLines;
  if (isSkillSurface && !showRawResult) {
    // Audit HIGH: a FAILED skill load used to drop its detail row with the
    // success path, hiding the one-line cause entirely. Keep the detail row
    // when the call errored; only the redundant success repeat is dropped.
    visibleDetailLines = isError && collapsedDetail ? [collapsedDetail] : [];
  } else if (isBackgroundMetadataResult && backgroundMetadataHeaderFailure && !showRawResult) {
    visibleDetailLines = [];
  } else if (isAgentSurfaceCard && !showRawResult) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || 'Running') : 'Finished');
    const agentDetailLine = agentSurfaceBrief
      || truncateToWidth(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    visibleDetailLines = agentHeaderFailure && !agentSurfaceBrief ? [] : [agentDetailLine];
  }
  const finalStatusColor = toolStatusColor({ pending, groupCount, failedCount, terminalStatus });
  const dotColor = finalStatusColor;
  // Agent surface cards use directional markers: `←` for requests going OUT
  // (spawn/send/etc.) and `→` for the response coming back IN. Background
  // task cards (shell async / explore / search / task) and every other tool
  // keep the BLACK_CIRCLE turn marker. Blink behavior is shared.
  const markerGlyph = isAgentResponse
    ? AGENT_RESPONSE_MARKER
    : (isAgentSurfaceCard ? AGENT_CALL_MARKER : TURN_MARKER);
  const dotText = pending && !blinkExpired && !blinkOn ? ' ' : markerGlyph;
  let labelText;
  if (isAgentResponse) labelText = agentResponseTitle(parsedArgs);
  else if (isBackgroundResponse) labelText = backgroundTaskResultTitle(normalizedName, backgroundMeta || parsedArgs);
  else if (isBackgroundMetadataResult) labelText = backgroundTaskActionTitle(normalizedName, backgroundMeta);
  else if (isShellSurface) labelText = shellHeader(shellStatus, displayGroupCount);
  else labelText = (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '') || statusCopy(name, label, displayGroupCount, doneCount, headerPending, isError, parsedArgs);
  labelText = safeInlineText(labelText);
  // Show the parenthesized arg summary for grouped cards too, matching single
  // calls so the header carries the same context.
  const toolSearchSummary = !pending && normalizedName === 'tool_search' && hasResult
    ? toolSearchLoadedSummary(displayedResultText)
    : '';
  const rawSummaryText = safeInlineText(isAgentResponse || isBackgroundResponse
    ? ''
    : toolSearchSummary || (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary));
  // Drop the parenthesized arg summary when it is a bare "<n> <unit>" count
  // that the header verb already spells out (e.g. header "Searching 6 patterns"
  // + summary "6 patterns"). Multi-arg array calls hit this; single calls keep
  // their descriptive summary ("pattern: \"foo\"") since it never matches the
  // header tail. Channel surfaces are unaffected — they build the summary from
  // summarizeToolArgs directly and never render this header verb.
  const summaryIsHeaderCount = rawSummaryText
    && /^\d+\s+\S+$/.test(rawSummaryText)
    && labelText.endsWith(rawSummaryText);
  const summaryText = summaryIsHeaderCount ? '' : rawSummaryText;
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
    && normalizedName !== 'tool_search';
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
