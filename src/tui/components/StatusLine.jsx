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
let statuslineModulePromise = null;

function loadStatuslineModule() {
  if (!statuslineModulePromise) statuslineModulePromise = import(STATUSLINE_MODULE);
  return statuslineModulePromise;
}

const RESET = '\x1b[0m';
const STATUSLINE_RENDER_DEBOUNCE_MS = 150;
const STATUSLINE_REFRESH_MS = 2000;
const STATUSLINE_ACTIVE_REFRESH_MS = 250;

function isTerminalStatus(statusText) {
  return /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/.test(String(statusText || '').toLowerCase());
}

function hasRunningStatuslineWorkers(agentWorkers = [], agentJobs = []) {
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.role || worker?.name || '').trim();
    if (tag && !isTerminalStatus(worker?.stage || worker?.status)) return true;
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (/running/i.test(String(job?.status || job?.stage || ''))) return true;
  }
  return false;
}

function ansiRgb(value, fallback) {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(value || '').replace(/\s+/g, ''));
  if (!match) return fallback;
  return `\x1b[38;2;${match[1]};${match[2]};${match[3]}m`;
}

const STATUS = ansiRgb(theme.statusText, '\x1b[38;2;198;198;198m');
const SUBTLE = ansiRgb(theme.statusSubtle, '\x1b[38;2;136;136;136m');
const SUCCESS = ansiRgb(theme.success, '\x1b[38;2;0;170;75m');
const WARNING = ansiRgb(theme.warning, '\x1b[38;2;255;193;7m');
const ERROR = ansiRgb(theme.error, '\x1b[38;2;220;70;88m');

function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

function localContextSegment() {
  const cols = terminalColumns();
  const cells = cols >= 120 ? 14 : cols >= 80 ? 8 : 0;
  if (!cells) return `${SUCCESS}0%${RESET}`;
  return `${SUBTLE}${'░'.repeat(cells)}${RESET} ${STATUS}0%${RESET}`;
}

function localFallbackStatusLine({ model = '', effort = '', fast = false } = {}) {
  const display = String(model || 'model')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^gpt-/i, 'GPT-')
    .replace(/(?:^|-)([a-z])/g, (m) => m.toUpperCase());
  const flags = [effort ? String(effort).toUpperCase() : '', fast === true ? 'FAST' : ''].filter(Boolean);
  const modelBits = [display, ...flags].join(` ${SUBTLE}·${RESET} `);
  return `${STATUS}◆${RESET} ${STATUS}${modelBits}${RESET} ${SUBTLE}│${RESET} ${localContextSegment()}`;
}

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

function StatusLineView({ sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, agentRevision = '', agentWorkers = [], agentJobs = [], initialLine = '' }) {
  const [line, setLine] = useState(() => normalizeStatusLine(initialLine || localFallbackStatusLine({ provider, model, effort, fast })));
  const [refreshTick, setRefreshTick] = useState(0);

  const statuslineArgs = { sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, agentWorkers, agentJobs };
  const refreshMs = hasRunningStatuslineWorkers(agentWorkers, agentJobs) ? STATUSLINE_ACTIVE_REFRESH_MS : STATUSLINE_REFRESH_MS;

  useEffect(() => {
    const timer = setInterval(() => {
      setRefreshTick((tick) => (tick + 1) % 1_000_000);
    }, refreshMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    let alive = true;
    if (!line) {
      loadStatuslineModule()
        .then((m) => {
          if (!alive || typeof m.fallbackStatusline !== 'function') return;
          const next = normalizeStatusLine(m.fallbackStatusline(statuslineArgs));
          if (next) setLine((prev) => (prev || next));
        })
        .catch(() => {});
    }
    const timer = setTimeout(() => {
      loadStatuslineModule()
        .then((m) => m.renderStatusline(statuslineArgs))
        .then((s) => {
          if (!alive) return;
          const next = normalizeStatusLine(s);
          if (next) setLine((prev) => (prev === next ? prev : next));
        })
        .catch(() => {
          // Keep the previous/minimal line. Boot-time gateway/cache races should
          // never blank the reserved footer and make the statusline flicker.
        });
    }, STATUSLINE_RENDER_DEBOUNCE_MS);
    timer.unref?.();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, agentRevision, agentWorkers, agentJobs, refreshTick]);

  const lines = line ? line.split('\n').slice(0, 2) : [' ', ' '];
  // Footer footprint stays 3 rows total, but L2 sits directly under L1 without
  // an internal spacer; the remaining row is kept as outer breathing room.
  return (
    <Box flexDirection="column" width="100%" height={3} overflow="hidden" paddingLeft={2} backgroundColor={theme.background}>
      <Text wrap="truncate">{lines[0] || ' '}</Text>
      <Text wrap="truncate">{lines[1] || ' '}</Text>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineView);
