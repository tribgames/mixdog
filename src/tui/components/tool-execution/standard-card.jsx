/*
 * components/tool-execution/standard-card.jsx — the normal (non-aggregate) tool card.
 */
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme, TURN_MARKER, AGENT_CALL_MARKER, AGENT_RESPONSE_MARKER } from '../../theme.mjs';
import { BULLET_OPERATOR } from '../../figures.mjs';
import { deriveToolCardModel } from '../../../runtime/shared/tool-card-model.mjs';
import {
  resultLineMaxChars,
  SUMMARY_MAX_CHARS,
  HEADER_FAILURE_STATUS_MAX,
  truncateToWidth,
  stripLeadingStatusMarkerFromText,
} from './text-format.mjs';
import { toolStatusColor } from './surface-detail.mjs';
import { ResultBody } from './ResultBody.jsx';

export function renderStandardToolCard(card) {
  const {
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
    headerFinalized,
    rowWidth,
    groupCount,
    doneCount,
    rawRt,
    pending,
    nowMs,
    blinkOn,
    hasResult,
    hasRawResult,
    callFailedCount,
    exitFailedCount,
    partialMutation,
  } = card;
  // ── Normal (non-aggregate) tool card ────────────────────────────
  // Single source: the shared collapsed-card derivation (labels, casing,
  // status merging, detail row) consumed by BOTH the TUI and the desktop
  // renderer (apps/desktop TranscriptView ToolCard). Width fitting, theme
  // colors, blink, and expansion handling stay TUI-side below.
  const maxResultChars = resultLineMaxChars(columns);
  const model = deriveToolCardModel(
    {
      name,
      args,
      result,
      rawResult,
      isError,
      errorCount,
      callErrorCount,
      exitErrorCount,
      count: groupCount,
      completedCount: doneCount,
      startedAt,
      completedAt,
      headerFinalized,
      nowMs,
    },
    { truncate: truncateToWidth, maxResultChars }
  );
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
  const resultColor = theme.text;
  const firstResultLineClipped = hasDisplayBody && stringWidth(firstResultLine) > maxResultChars;
  const hasHiddenDetail =
    !pending && hasDisplayBody && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));
  const backgroundMetadataExpandable = isBackgroundMetadataResult && hasRawResult && !pending;
  const showRawResult = expanded && (hasDisplayBody || hasRawResult) && (!isBackgroundMetadataResult || hasRawResult);
  // Skill/agent collapsed gating lives in the shared model (detailLine).
  const detailLines = !showRawResult && collapsedDetailLine ? [collapsedDetailLine] : [];
  const isPendingPlaceholderDetail = !showRawResult && detailIsPlaceholder;
  const detailColor = isPendingPlaceholderDetail ? theme.subtle : theme.text;
  const dotColor = toolStatusColor({
    pending,
    groupCount,
    callFailedCount,
    exitFailedCount,
    terminalStatus,
    partialMutation,
  });
  // Agent surface cards use directional markers: `←` for requests going OUT
  // (spawn/send/etc.) and `→` for the response coming back IN. Background
  // task cards (shell async / explore / search / task) and every other tool
  // keep the BLACK_CIRCLE turn marker. Blink behavior is shared.
  let markerGlyph = TURN_MARKER;
  if (isAgentResponse) markerGlyph = AGENT_RESPONSE_MARKER;
  else if (isAgentSurfaceCard) markerGlyph = AGENT_CALL_MARKER;
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
  const agentHasExpandableBody =
    isAgentSurfaceCard && !pending && hasResult && (isAgentResponse || totalLines > 1 || firstResultLineClipped);
  // Agent cards gate the hint solely on agentHasExpandableBody — never on
  // hasHiddenDetail, which goes true for any single-line resultSummary and would
  // wrongly show ctrl+o on a status-only one-liner that has nothing to expand.
  const shellHasExpandableBody =
    isShellSurface &&
    !pending &&
    hasDisplayResult &&
    hasDisplayBody &&
    (totalLines > 1 ||
      firstResultLineClipped ||
      Boolean(shellCollapsedSummary && shellCollapsedSummary !== firstResultLine));
  let hasExpandableBody;
  if (isShellSurface) hasExpandableBody = shellHasExpandableBody;
  else if (isAgentSurfaceCard) hasExpandableBody = agentHasExpandableBody;
  else hasExpandableBody = hasHiddenDetail || backgroundMetadataExpandable;
  const showHeaderExpandHint = hasExpandableBody && normalizedName !== 'load_tool';
  const expandHintColor = theme.subtle;

  // Build a single-line header that never wraps: reserve width for the fixed
  // trailing expand hint plus the dot gutter and a 1-col Windows last-column
  // safety margin, then truncate label/summary to fit. Pending state is already
  // shown by the verb (Running/Reading/etc.), the blinking dot, and the detail
  // row, so avoid an extra standalone ellipsis between parenthesized segments.
  const gutter = 2;
  const hintReserveLabel = `ctrl+o ${expanded ? 'collapse' : 'expand'}`;
  const hintReserveText = ` ${BULLET_OPERATOR} ${hintReserveLabel}`;
  const trailingText = showHeaderExpandHint ? hintReserveText : '';
  // The header right-side trailing slot only ever shows the ctrl+o hint. The
  // pending elapsed meta was removed from the header — it lives on the detail
  // row now (`Running · 12s`) so a per-second digit change (9s→10s) or the
  // pending→done swap never reflows the header. The hint slot is reserved for
  // the whole lifecycle (even while pending) so its later appearance on
  // completion does not push the body clip point.
  const headerFailureText = headerFailureStatus ? truncateToWidth(headerFailureStatus, HEADER_FAILURE_STATUS_MAX) : '';
  const inlineFailureText = headerFailureText ? ` ${BULLET_OPERATOR} ${headerFailureText}` : '';
  const rightReserve = stringWidth(hintReserveText) + stringWidth(inlineFailureText);
  const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - rightReserve);
  const trailingColor = expandHintColor;
  let labelOut;
  let summaryOut;
  // Shell headers stay label-only ("Ran 1 command") on every surface —
  // the desktop card contract: the raw command line never rides inline in
  // the header; it stays in the expanded detail body.
  const headerSummaryText = isShellSurface ? '' : summaryText;
  if (stringWidth(labelText) >= avail) {
    labelOut = truncateToWidth(labelText, avail);
    summaryOut = '';
  } else {
    labelOut = labelText;
    const summaryBudget = avail - stringWidth(labelText) - (headerSummaryText ? stringWidth(' ()') : 0);
    // Cap by both the remaining header width and a fixed max so long
    // paths/queries get an ellipsis instead of dominating the line.
    const summaryWidth = Math.max(0, Math.min(summaryBudget, SUMMARY_MAX_CHARS));
    const truncatedSummary =
      headerSummaryText && summaryWidth > 0 ? truncateToWidth(headerSummaryText, summaryWidth) : '';
    summaryOut = truncatedSummary ? ` (${truncatedSummary})` : '';
  }
  // Keep trailing content (ctrl+o hint only; pending elapsed lives on the detail
  // row) attached directly after the body for the whole lifecycle. A
  // fixed-column pin would make the trailing text jump to the right edge and
  // snap back on the pending→done flip, so there is no pad. `avail` stays reserved (rightReserve) so the body clip point never reflows.
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1} overflow="hidden" minWidth={0}>
          <Box flexDirection="row">
            <Box flexShrink={0} minWidth={2}>
              <Text color={dotColor}>{dotText}</Text>
            </Box>
            <Text wrap="truncate">
              <Text bold color={theme.text}>
                {labelOut}
              </Text>
              {summaryOut ? <Text color={theme.text}>{summaryOut}</Text> : null}
              {inlineFailureText ? <Text color={theme.error}>{inlineFailureText}</Text> : null}
              {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
            </Text>
          </Box>
        </Box>
      </Box>

      <ResultBody
        lines={detailLines}
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
