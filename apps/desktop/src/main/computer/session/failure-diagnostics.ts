import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { computerStepTimings, computerTimings } from '../shared/timings';
import { computerCursorFeedback } from '../shared/cursor-feedback';

const MAX_BUNDLES = 20;
const MAX_SESSIONS = 32;
const MAX_RECORDS = 40;
const MAX_BYTES = 128 * 1024;
const category = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** An allowlist boundary: no titles, text, clipboard, app paths or pixels. */
export function diagnosticRecord(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof input.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.at)) result.at = input.at;
  for (const key of ['action', 'delivery', 'effect', 'code', 'error', 'path', 'escalation', 'stage']) {
    const value = category(input[key]);
    if (value) result[key] = value;
  }
  for (const key of ['ok', 'verified', 'goal_verified']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (typeof input.window_id === 'string' && /^hwnd:0x[0-9a-f]{1,16}$/i.test(input.window_id)) {
    result.window_id = input.window_id;
  }
  if (typeof input.ms === 'number' && Number.isFinite(input.ms)) result.ms = Math.max(0, input.ms);
  const recovery = object(input.input_recovery ?? input.recovery);
  result.recovery = Object.fromEntries(['ok', 'user_control', 'recovery_skipped', 'focus_preserved_for_followup', 'recapture_available',
    'focus_restored', 'focus_unchanged', 'input_not_dispatched', 'cursor_preserved', 'cursor_restored', 'reasserted']
    .filter((key) => typeof recovery[key] === 'boolean').map((key) => [key, recovery[key]]));
  const native = object(input.native_result);
  result.native_result = Object.fromEntries([
    ...['code', 'path', 'effect', 'delivery'].filter(key => category(native[key])).map(key => [key, native[key]]),
    ...['delivery_accepted', 'verified', 'goal_verified'].filter(key => typeof native[key] === 'boolean').map(key => [key, native[key]]),
  ]);
  result.cursor_feedback = computerCursorFeedback(input.cursor_feedback ?? native.cursor_feedback) ?? {};
  result.timings_ms = computerTimings(input.timings_ms);
  const observation = object(input.capture_after ?? input.observation);
  const captureTimings = computerTimings(input.capture_timings_ms ?? observation.timings_ms);
  if (Object.keys(captureTimings).length) result.capture_timings_ms = captureTimings;
  const steps = computerStepTimings(input.step_timings ?? input.steps ?? input.actions);
  if (steps.length) result.step_timings = steps;
  return result;
}

export function createComputerFailureDiagnostics(directory: string) {
  const histories = new Map<string, Record<string, unknown>[]>();
  const files = () => readdirSync(directory).filter((name) => /^failure-[0-9a-f-]+\.json$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return {
    record(sessionId: string, input: Record<string, unknown>): void {
      try {
        const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
        const history = histories.get(key) ?? [];
        history.push({ at: new Date().toISOString(), ...diagnosticRecord(input) });
        if (history.length > MAX_RECORDS) history.shift();
        histories.delete(key);
        histories.set(key, history);
        if (histories.size > MAX_SESSIONS) histories.delete(histories.keys().next().value!);
        if (input.ok !== false && !(input.stage === 'cleanup' && history.some((record) => record.ok === false))) return;
        mkdirSync(directory, { recursive: true });
        const bundle = {
          version: 1, id: randomUUID(), session: key,
          createdAt: new Date().toISOString(), platform: process.platform,
          screenshots: 'excluded', records: history,
        };
        const text = JSON.stringify(bundle);
        if (Buffer.byteLength(text) > MAX_BYTES) return;
        writeFileSync(join(directory, `failure-${bundle.id}.json`), text, { flag: 'wx', mode: 0o600 });
        for (const file of files().slice(MAX_BUNDLES)) unlinkSync(join(directory, file.name));
      } catch { /* diagnostic failure must not alter an action's outcome */ }
    },
    read(): unknown[] {
      try {
        return files().slice(0, MAX_BUNDLES).flatMap(({ name }) => {
          try {
            const path = join(directory, name);
            if (statSync(path).size > MAX_BYTES) return [];
            const value = JSON.parse(readFileSync(path, 'utf8'));
            // Reapply the boundary even to persisted files.
            return [{
              version: 1, screenshots: 'excluded',
              id: /^[0-9a-f-]{36}$/.test(value.id) ? value.id : undefined,
              createdAt: diagnosticRecord({ at: value.createdAt }).at,
              records: Array.isArray(value.records) ? value.records.slice(-MAX_RECORDS).map((record: unknown) =>
                diagnosticRecord(object(record))) : [],
            }];
          } catch { return []; }
        });
      } catch { return []; }
    },
  };
}
