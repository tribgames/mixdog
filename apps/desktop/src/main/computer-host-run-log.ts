/**
 * The Computer Use run history: one JSONL line per executed command so a failed
 * run can be reconstructed afterwards. Actions, targets, timings, and verdicts
 * only — typed text, clipboard contents, and pixels never reach this file, and
 * a history write never decides whether a command succeeds.
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { elapsedMs, mixdogDataDirectory } from './computer-host-shared';
import type { ComputerCommand, ComputerCommandResult } from './computer-host-types';

const RUN_LOG_DIRECTORY = 'computer-runs';
const RUN_LOG_MAX_BYTES = 256 * 1_024;
const RUN_LOG_MAX_FILES = 20;
let prunedRunLogDirectory = '';

function runLogFileName(sessionId: string): string {
  return `${sessionId.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'session'}.jsonl`;
}

function pruneComputerRunLogs(directory: string): void {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const path = join(directory, name);
      let modifiedAt = 0;
      try { modifiedAt = statSync(path).mtimeMs; } catch { modifiedAt = 0; }
      return { path, modifiedAt };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const stale of files.slice(RUN_LOG_MAX_FILES)) {
    try { unlinkSync(stale.path); } catch { /* another run already removed it */ }
  }
}

export function appendComputerRunRecord(sessionId: string, record: Record<string, unknown>): void {
  const id = String(sessionId || '').trim();
  if (!id) return;
  try {
    const directory = join(mixdogDataDirectory(), RUN_LOG_DIRECTORY);
    const path = join(directory, runLogFileName(id));
    mkdirSync(directory, { recursive: true });
    if (prunedRunLogDirectory !== directory) {
      pruneComputerRunLogs(directory);
      prunedRunLogDirectory = directory;
    }
    let written = 0;
    let newFile = false;
    try { written = statSync(path).size; } catch { newFile = true; }
    const line = `${JSON.stringify({ at: new Date().toISOString(), session: id, ...record })}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (written + lineBytes > RUN_LOG_MAX_BYTES) return;
    appendFileSync(path, line, 'utf8');
    if (newFile) pruneComputerRunLogs(directory);
  } catch {
    // History is diagnostic only: a command never fails because of it.
  }
}

export function computerRunRecord(
  command: ComputerCommand,
  startedAt: number,
  result?: ComputerCommandResult,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    action: String(command.action || ''),
    ...(command.window_id ? { window_id: String(command.window_id) } : {}),
    ...(command.app ? { app: String(command.app) } : {}),
    ...(command.ref ? { ref: String(command.ref) } : {}),
    ...(command.delivery ? { delivery: String(command.delivery) } : {}),
    ms: Math.round(elapsedMs(startedAt)),
  };
  if (!result) return record;
  record.ok = true;
  record.bytes = result.text.length;
  try {
    const payload = JSON.parse(result.text) as Record<string, unknown>;
    if (typeof payload.ok === 'boolean') record.ok = payload.ok;
    for (const key of [
      'effect', 'verified', 'goal_verified', 'code', 'path', 'escalation',
      'window_id', 'pixel_status', 'accessibility_status',
    ]) {
      const value = payload[key];
      if (value !== undefined && (typeof value !== 'object' || value === null)) record[key] = value;
    }
    const verdict = payload.verdict;
    if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
      const decision = (verdict as Record<string, unknown>).decision;
      const recommended = (verdict as Record<string, unknown>).recommended;
      record.verdict = {
        ...(typeof decision === 'string' ? { decision } : {}),
        ...(typeof recommended === 'string' ? { recommended } : {}),
      };
    }
  } catch {
    // Plain-text discovery results carry no structured verdict.
  }
  return record;
}
