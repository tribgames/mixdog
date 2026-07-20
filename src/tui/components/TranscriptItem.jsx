/**
 * TranscriptItem.jsx — per-item transcript renderer (Item) + the hook-denial
 * tool card. Extracted verbatim from App.jsx.
 */
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { theme, TURN_MARKER, RESULT_GUTTER } from '../theme.mjs';
import { AssistantMessage, UserMessage, NoticeMessage } from './Message.jsx';
import { ToolExecution } from './ToolExecution.jsx';
import { StatusDone, TurnDone } from './TurnDone.jsx';
import { ItemRightHintOverprint } from './ItemRightHintOverprint.jsx';
import { formatToolSurface } from '../../runtime/shared/tool-surface.mjs';
import {
  formatHookDenialDetail,
  isHookApprovalDenialToolItem,
  shouldSuppressFullyFailedToolItem,
  toolItemResultText,
} from '../transcript-tool-failures.mjs';

export function ToolHookDenialCard({ item, columns = 80 }) {
  const { label, summary } = formatToolSurface(item.name, item.args);
  const detail = formatHookDenialDetail(toolItemResultText(item));
  const safeLabel = stripAnsi(String(label || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const safeSummary = stripAnsi(String(summary || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const safeDetail = stripAnsi(String(detail || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const summaryText = safeSummary ? ` (${safeSummary})` : '';
  const rowWidth = Math.max(1, Number(columns || 80));
  const detailWidth = Math.max(1, rowWidth - stringWidth(RESULT_GUTTER));
  return (
    <Box flexDirection="column" marginTop={1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width={rowWidth} overflow="hidden">
        <Box flexShrink={0} minWidth={2}>
          <Text color={theme.error}>{TURN_MARKER}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden" minWidth={0}>
          <Text wrap="truncate">
            <Text bold color={theme.text}>{safeLabel}</Text>
            {summaryText ? <Text color={theme.text}>{summaryText}</Text> : null}
            <Text color={theme.error}> · Denied</Text>
          </Text>
        </Box>
      </Box>
      {safeDetail ? (
        <Box flexDirection="row" width={rowWidth} overflow="hidden">
          <Box flexShrink={0} width={stringWidth(RESULT_GUTTER)}>
            <Text color={theme.subtle}>{RESULT_GUTTER}</Text>
          </Box>
          <Box flexShrink={0} width={detailWidth} overflow="hidden">
            <Text color={theme.error} wrap="truncate">{safeDetail}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

// `themeEpoch` is read but not used in the body: it is a memo-busting prop. The
// active theme mutates `theme` in-place, so a switch must force every mounted
// transcript row (which reads theme.* directly) to re-render. Threading the
// epoch through Item → AssistantMessage/UserMessage/ToolExecution breaks
// React.memo's shallow equality on a theme change without a broad refactor.
export const Item = React.memo(function Item({ item, prevKind, columns, toolOutputExpanded, rightMessage = '', rightTone = 'info', rightMessageWidth = 24, themeEpoch = 0, streamingWindowRows = 0 }) {
  const hintOnTurnDoneRow = item.kind === 'turndone' || item.kind === 'statusdone';
  let node = null;
  switch (item.kind) {
    case 'user':
      node = <UserMessage text={item.text} attached={prevKind === 'user'} columns={columns} themeEpoch={themeEpoch} />;
      break;
    case 'assistant':
      node = <AssistantMessage text={item.text} streaming={item.streaming} columns={columns} themeEpoch={themeEpoch} assistantId={item.id} streamingWindowRows={streamingWindowRows} />;
      break;
    case 'tool': {
      if (shouldSuppressFullyFailedToolItem(item)) return null;
      if (isHookApprovalDenialToolItem(item)) {
        node = <ToolHookDenialCard item={item} columns={columns} />;
        break;
      }
      // Every tool card keeps its one-row gap above (user reverted the earlier
      // "stack consecutive cards flush" experiment: attached rows read broken).
      // Keep transcript-window.mjs row estimation in sync (attachedTool=false).
      node = <ToolExecution name={item.name} args={item.args} result={item.result} rawResult={item.rawResult} isError={item.isError} errorCount={item.errorCount} callErrorCount={item.callErrorCount} exitErrorCount={item.exitErrorCount} expanded={toolOutputExpanded || item.expanded} columns={columns} attached={false} count={item.count} completedCount={item.completedCount} startedAt={item.startedAt} completedAt={item.completedAt} aggregate={item.aggregate} categories={item.categories} doneCategories={item.doneCategories} headerFinalized={item.headerFinalized} deferredDisplayReady={item.deferredDisplayReady} agentResponseAggregate={item.agentResponseAggregate} />;
      break;
    }
    case 'notice':
      node = <NoticeMessage text={item.text} tone={item.tone} columns={columns} />;
      break;
    case 'turndone':
      node = <TurnDone elapsedMs={item.elapsedMs} status={item.status} outputTokens={item.outputTokens} thinkingElapsedMs={item.thinkingElapsedMs} verb={item.verb} rightMessage={rightMessage} rightTone={rightTone} rightMessageWidth={rightMessageWidth} />;
      break;
    case 'statusdone':
      node = <StatusDone label={item.label} detail={item.detail} rightMessage={rightMessage} rightTone={rightTone} rightMessageWidth={rightMessageWidth} />;
      break;
    default:
      return null;
  }
  if (!node || hintOnTurnDoneRow || !rightMessage) return node;
  return (
    <ItemRightHintOverprint
      rightMessage={rightMessage}
      rightTone={rightTone}
      rightMessageWidth={rightMessageWidth}
    >
      {node}
    </ItemRightHintOverprint>
  );
});
