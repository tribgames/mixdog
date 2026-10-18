// Opt-in (MIXDOG_NOTIFY_TRACE=1) completion-notification trace: off by
// default, so a normal install writes no line per delivery decision (it kept
// a multi-MB log growing in every data dir). The display path for
// background completions is event-time only and has repeatedly failed silently
// in the field (2026-08-17: bench shell output never rendered while the model
// queue twin worked every time). One append-only line per decision point keeps
// the delivery chain reconstructable after the fact. Small, bounded lines;
// best-effort writes; never throws into the caller. Lines are queued and
// written asynchronously; the file keeps its last 1 MiB once it passes 4 MiB.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAsyncLogAppender } from './async-log-appender.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

const NOTIFY_TRACE_MAX_BYTES = 4 * 1024 * 1024;
const NOTIFY_TRACE_KEEP_BYTES = 1024 * 1024;
const appender = createAsyncLogAppender({ maxBytes: NOTIFY_TRACE_MAX_BYTES, keepBytes: NOTIFY_TRACE_KEEP_BYTES });

let traceDir = null;

/** Resolves once every trace line queued so far is on disk. */
export function flushNotifyTrace() {
  return appender.flush();
}

// Resolved per call: a pristine boundary retargets MIXDOG_DATA_DIR/MIXDOG_HOME
// at runtime, and its traces must stay inside that isolated root.
function tracePath() {
  const dir = join(resolvePluginData(), 'diagnostics');
  if (dir !== traceDir) {
    traceDir = dir;
    try {
      mkdirSync(traceDir, { recursive: true });
    } catch {
      /* best effort */
    }
  }
  return join(traceDir, 'notify-trace.log');
}

function notifyTraceEnabled() {
  return process.env.MIXDOG_NOTIFY_TRACE === '1';
}

export function notifyTrace(stage, fields = {}) {
  if (!notifyTraceEnabled()) return;
  try {
    const parts = [`[${new Date().toISOString()}]`, `pid=${process.pid}`, stage];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${String(value).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    appender.append(tracePath(), `${parts.join(' ')}\n`);
  } catch {
    /* tracing must never break delivery */
  }
}
