/**
 * components/StatusLine.jsx — the vendored mixdog L1/L2 statusline footer.
 *
 * renderStatusline() (src/ui/statusline.mjs) is async (it awaits the vendored
 * statusline-lib that may query the gateway). We recompute it whenever the
 * stats/model change and tone-map the vendored ANSI string into the React TUI
 * palette before printing it through ink's <Text>.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme, surfaceBackground } from '../theme.mjs';
import { workflowModeLabel } from './status-line/local-line.mjs';
import { useStatusLineText } from './status-line/use-statusline-text.mjs';

function StatusLineView({
  sessionId,
  clientHostPid,
  provider,
  model,
  effort,
  fast,
  ultra = false,
  cwd,
  stats,
  contextWindow,
  displayContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  rawContextWindow,
  resizeEpoch,
  agentRevision = '',
  agentWorkers = [],
  agentJobs = [],
  activeTools = null,
  initialLine = '',
  workflow = null,
  themeEpoch = 0,
}) {
  const line = useStatusLineText({
    sessionId,
    clientHostPid,
    provider,
    model,
    effort,
    fast,
    ultra,
    cwd,
    stats,
    contextWindow,
    displayContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    rawContextWindow,
    resizeEpoch,
    agentRevision,
    agentWorkers,
    agentJobs,
    activeTools,
    initialLine,
    themeEpoch,
  });

  const lines = line ? line.split('\n').slice(0, 2) : [' ', ' '];
  const workflowLabel = workflowModeLabel(workflow);
  // Footer footprint is exactly 2 rows (L1 + L2) so the statusline sits tight
  // under the prompt box — the old third "breathing" row left a dead band at
  // the terminal bottom. Left/right insets match the prompt box's text column
  // (1 border + 1 padding) so both edges line up vertically with the input.
  return (
    <Box
      flexDirection="column"
      width="100%"
      height={2}
      overflow="hidden"
      justifyContent="flex-start"
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={surfaceBackground()}
    >
      <Box flexDirection="row" width="100%" overflow="hidden">
        <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
          <Text wrap="truncate">{lines[0] || ' '}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={theme.statusText} wrap="truncate">
            {workflowLabel}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="row" width="100%" overflow="hidden">
        <Box flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
          <Text wrap="truncate">{lines[1] || ' '}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineView);
