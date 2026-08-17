// Lightweight always-on completion-notification trace. The display path for
// background completions is event-time only and has repeatedly failed silently
// in the field (2026-08-17: bench shell output never rendered while the model
// queue twin worked every time). One append-only line per decision point keeps
// the delivery chain reconstructable after the fact. Small, bounded lines;
// best-effort writes; never throws into the caller.
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let traceDir = null;

function tracePath() {
  if (!traceDir) {
    traceDir = join(homedir(), '.mixdog', 'data', 'diagnostics');
    try { mkdirSync(traceDir, { recursive: true }); } catch { /* best effort */ }
  }
  return join(traceDir, 'notify-trace.log');
}

export function notifyTrace(stage, fields = {}) {
  try {
    const parts = [`[${new Date().toISOString()}]`, `pid=${process.pid}`, stage];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${String(value).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    appendFileSync(tracePath(), `${parts.join(' ')}\n`);
  } catch { /* tracing must never break delivery */ }
}
