/**
 * components/tool-execution/ResultBody.jsx — the multi-line result body under
 * the ⎿ gutter (COLLAPSED fitted summary or EXPANDED raw). Extracted verbatim
 * from ToolExecution.jsx — behavior unchanged.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme, RESULT_GUTTER, RESULT_GUTTER_CONT } from '../../theme.mjs';
import { formatExpandedResult, wrapExpandedResultLines } from '../tool-output-format.mjs';
import { deltaTextParts, fitResultLine } from './text-format.mjs';

export function renderDeltaText(text) {
  return deltaTextParts(text).map((part, index) => (
    part.color ? <Text key={index} color={part.color}>{part.text}</Text> : part.text
  ));
}

// Shared multi-line result body: `└` on the first row, `│` continuation rail on
// every following row, body text in one flex column so wrapping stays aligned
// under the head gutter.
//
// Two render paths:
//   - COLLAPSED (raw=false): a single fitted summary line, diff(+/-) colored via
//     renderDeltaText.
//   - EXPANDED (raw=true): formatExpandedResult then wrapExpandedResultLines so
//     each physical row fits the body width before render (rail rows stay 1:1;
//     ink does not re-wrap). Physical row mount cap: MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES
//     (default 600; 0 disables). Shell/script bodies keep the newest tail when capped.
export function ResultBody({ lines, rawText, pathArg = '', isShell = false, columns, color, raw }) {
  const renderLines = raw
    ? wrapExpandedResultLines(
      formatExpandedResult(rawText, { pathArg, isShell }),
      columns,
      { isShell },
    )
    : (lines || []);
  if (!renderLines || renderLines.length === 0) return null;
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} flexDirection="column">
        {renderLines.map((_, i) => (
          <Text key={i} color={theme.subtle}>{i === 0 ? RESULT_GUTTER : RESULT_GUTTER_CONT}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {renderLines.map((line, i) => (
          <Text key={i} color={raw ? undefined : color} wrap="truncate">
            {raw
              ? (line || ' ')
              : renderDeltaText(fitResultLine(line || ' ', columns))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
