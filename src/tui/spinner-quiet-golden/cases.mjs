// The liveness snapshots whose quiet state and byline are recorded from Node (record.mjs) and replayed by
// spinner-quiet.test.mjs. The core publishes `spinner.quiet`; the TUI shows it.
export const NOW = 50_000_000;
export const WARN_MS = 300_000;
export const CASES = [
  { name: 'a streaming turn silent for 6m 40s', liveness: { stage: 'streaming', lastProgressAt: NOW - 400_000 } },
  {
    name: 'a sent request still waiting for its headers',
    liveness: { stage: 'requesting', requestSentAt: NOW - 200_000, lastTransportAt: 0, lastProgressAt: NOW - 200_000 },
  },
  { name: 'a turn inside the cue window', liveness: { stage: 'streaming', lastProgressAt: NOW - 1_000 } },
  { name: 'a running tool, silent', liveness: { stage: 'tool_running', currentTool: 'shell', lastProgressAt: NOW - 120_000 } },
  { name: 'a wire-only liveness answer', liveness: null },
];
