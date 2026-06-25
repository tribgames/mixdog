/**
 * components/StatusLine.jsx — the vendored mixdog L1/L2 statusline footer.
 *
 * renderStatusline() (src/ui/statusline.mjs) is async (it awaits the vendored
 * statusline-lib that may query the gateway). We recompute it whenever the
 * stats/model change and tone-map the vendored ANSI string into the React TUI
 * palette before printing it through ink's <Text>.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

// Loaded at RUNTIME (not bundled) so its vendored statusline-lib relative
// imports resolve from the real src/ui location, not the dist/ bundle dir.
// esbuild leaves dynamic-import string specifiers alone.
const STATUSLINE_MODULE = '../../ui/statusline.mjs';

const RESET = '\x1b[0m';

function ansiRgb(value, fallback) {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(value || '').replace(/\s+/g, ''));
  if (!match) return fallback;
  return `\x1b[38;2;${match[1]};${match[2]};${match[3]}m`;
}

const STATUS = ansiRgb(theme.statusText, '\x1b[38;2;198;198;198m');
const SUBTLE = ansiRgb(theme.statusSubtle, '\x1b[38;2;136;136;136m');
const SUCCESS = ansiRgb(theme.success, '\x1b[38;2;0;200;83m');
const WARNING = ansiRgb(theme.warning, '\x1b[38;2;255;193;7m');
const ERROR = ansiRgb(theme.error, '\x1b[38;2;255;82;104m');

export function normalizeStatusLine(text) {
  return String(text || '')
    .replace(/\n+$/, '')
    .replace(/\x1b\[1m/g, STATUS)
    .replace(/\x1b\[2m/g, SUBTLE)
    .replace(/\x1b\[31m/g, ERROR)
    .replace(/\x1b\[32m/g, SUCCESS)
    .replace(/\x1b\[33m/g, WARNING)
    .replace(/\x1b\[36m/g, SUBTLE)
    .replace(/\x1b\[90m/g, SUBTLE)
    .replace(/^(?:\x1b\[[0-9;]*m)*◆(?:\x1b\[[0-9;]*m)*\s?/, STATUS)
    .replace(/(\x1b\[0m )(\d+(?:\.\d+)?%)(?= |$)/g, `$1${STATUS}$2${RESET}`)
    .replaceAll(`${RESET} ${SUBTLE}│${RESET} `, ` ${SUBTLE}│${RESET} `);
}

export function StatusLine({ sessionId, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, bridgeRevision = '', bridgeWorkers = [], bridgeJobs = [], initialLine = '' }) {
  const [line, setLine] = useState(() => normalizeStatusLine(initialLine));

  useEffect(() => {
    let alive = true;
    import(STATUSLINE_MODULE)
      .then((m) => m.renderStatusline({ sessionId, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, bridgeWorkers, bridgeJobs }))
      .then((s) => {
        if (!alive) return;
        setLine(normalizeStatusLine(s));
      })
      .catch(() => {
        if (alive) setLine('');
      });
    return () => { alive = false; };
  }, [sessionId, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, bridgeRevision]);

  return (
    <Box flexDirection="column" width="100%" height={2} paddingLeft={2} marginBottom={1} backgroundColor={theme.background}>
      {line ? line.split('\n').slice(0, 2).map((l, i) => (
        <Text key={i}>{l}</Text>
      )) : null}
    </Box>
  );
}
