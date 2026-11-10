/*
 * components/tool-execution/aggregate-card.jsx — the grouped (aggregate) tool card.
 */
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, TURN_MARKER } from '../../theme.mjs';
import { BULLET_OPERATOR } from '../../figures.mjs';
import { formatAggregateHeader } from '../../../runtime/shared/tool-surface.mjs';
import { safeInlineText, truncateToWidth, resultTerminalStatus, displayTerminalStatus } from './text-format.mjs';
import { toolStatusColor } from './surface-detail.mjs';
import { ResultBody } from './ResultBody.jsx';
import { aggregateRawResultForDisplay } from '../../session/tool-result-status.mjs';

export function renderAggregateToolCard(card) {
  const {
    args,
    isError,
    expanded,
    columns,
    attached,
    rowWidth,
    groupCount,
    rt,
    rawRt,
    pending,
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
  } = card;
  // Pending aggregate headers omit counts so intermediate tool batches do not
  // bounce between "Reading 1 item" and "Reading 4 items". Final counts and
  // result summaries appear only after completion.
  const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
  // No stableVerbWidth: see statusCopy — the padding only left a mid-header
  // gap ("Searched  1 pattern, Read    1 file") since Ink trims trailing
  // spaces and never stabilized the flip.
  const headerText = safeInlineText(
    formatAggregateHeader((headerPending ? displayCategories : displayDoneCategories) || {}, {
      pending: headerPending,
      order: headerOrder,
      failed: failedCount > 0 && failedCount >= groupCount,
    })
  );
  // The aggregate card reserves EXACTLY ONE detail row when it is not
  // expanded-with-raw (estimateTranscriptItemRows counts
  // margin + header + 1 detail row for the no-raw aggregate case). The
  // summary `rt` can be multiline; a single <Text> containing '\n' renders
  // MULTIPLE terminal rows, which desyncs the estimate and makes the card
  // "settle" taller than reserved. Collapse to a single logical line
  // (whitespace-normalized); ResultBody trims it to the column width.
  const detailText = hasResult ? safeInlineText(rt) : '';

  // Resolve the aggregate's terminalStatus from the collapsed detail `rt`
  // (which carries a `[status: cancelled]`/`<status>` marker when the
  // aggregate was cancelled) plus isError/failedCount for failures. Pending
  // stays running; a clean completion stays success. toolStatusColor is the
  // single source of dot color for both aggregate and normal cards.
  let aggregateTerminalStatus = 'running';
  if (!pending) {
    aggregateTerminalStatus = resultTerminalStatus(rt);
    if (!aggregateTerminalStatus) {
      aggregateTerminalStatus = isError || failedCount > 0 ? 'failed' : 'completed';
    }
  }
  const dotColor = toolStatusColor({
    pending,
    groupCount,
    callFailedCount,
    exitFailedCount,
    terminalStatus: aggregateTerminalStatus,
    partialMutation,
  });
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
  const clippedHeader = stringWidth(headerText) > avail ? truncateToWidth(headerText, avail) : headerText;
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
  // The placeholder states the real outcome: a failed batch never says Finished.
  const pendingPlaceholder = pending ? 'Running' : displayTerminalStatus(aggregateTerminalStatus) || 'Finished';
  const detailLines = showRawAggregate ? [] : [detailText || pendingPlaceholder];
  const aggregateDetailColor = isPlaceholderDetail ? theme.subtle : theme.text;
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width={rowWidth} overflow="hidden">
        <Box flexShrink={0} minWidth={2}>
          <Text color={dotColor}>{dotText}</Text>
        </Box>
        <Text wrap="truncate">
          <Text bold color={theme.text}>
            {clippedHeader}
          </Text>
          {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
        </Text>
      </Box>
      <ResultBody
        lines={detailLines}
        rawText={showRawAggregate ? aggregateRawResultForDisplay(rawRt) : ''}
        columns={columns}
        color={aggregateDetailColor}
        raw={showRawAggregate}
      />
    </Box>
  );
}
