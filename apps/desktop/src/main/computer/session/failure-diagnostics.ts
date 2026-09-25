import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { computerStepTimings, computerTimings } from '../shared/timings';
import { computerCursorFeedback } from '../shared/cursor-feedback';
import { captureAttempts } from '../shared/capture-attempts';
import { diagnosticCategory } from '../shared/diagnostic-category';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

const MAX_BUNDLES = 20;
const MAX_SESSIONS = 32;
const MAX_RECORDS = 40;
const MAX_BYTES = 128 * 1024;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const booleanEvidence = (key: string, value: unknown) =>
  typeof value === 'boolean' || (key === 'delivery_accepted' && value === null);

/** An allowlist boundary: no titles, text, clipboard, app paths or pixels. */
const RECOVERY_EVIDENCE_KEYS = [
  'ok',
  'user_control',
  'recovery_skipped',
  'focus_preserved_for_followup',
  'recapture_available',
  'focus_restored',
  'focus_unchanged',
  'input_not_dispatched',
  'cursor_restored',
  'reasserted',
];

function recoveryEvidence(recovery: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    RECOVERY_EVIDENCE_KEYS.filter((key) => typeof recovery[key] === 'boolean').map((key) => [key, recovery[key]])
  );
}

function nativeResultEvidence(native: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    ...['code', 'path', 'effect', 'delivery']
      .filter((key) => diagnosticCategory(native[key]))
      .map((key) => [key, native[key]]),
    ...['delivery_accepted', 'input_may_have_executed', 'verified', 'goal_verified']
      .filter((key) => booleanEvidence(key, native[key]))
      .map((key) => [key, native[key]]),
  ]);
}

// The observation rides on the reply itself for capture-style actions.
function observedRecord(input: Record<string, unknown>): {
  observation: Record<string, unknown>;
  observed: Record<string, unknown>;
} {
  const observation = object(input.capture_after ?? input.observation);
  const captureReply = ['capture', 'screenshot', 'zoom'].includes(String(input.action)) ? input : {};
  return { observation, observed: Object.keys(observation).length ? observation : captureReply };
}

function observationEvidence(observed: Record<string, unknown>): Record<string, unknown> {
  const pixels = object(observed.pixel_unavailable);
  const accessibilityError =
    computerErrorCode(observed.accessibility_error) || diagnosticCategory(observed.accessibility_error);
  return Object.fromEntries([
    ...['pixel_status', 'accessibility_status']
      .filter((key) => diagnosticCategory(observed[key]))
      .map((key) => [key, observed[key]]),
    ...(typeof observed.ok === 'boolean' ? [['ok', observed.ok]] : []),
    ...(diagnosticCategory(observed.pixel_reason ?? pixels.reason)
      ? [['pixel_reason', observed.pixel_reason ?? pixels.reason]]
      : []),
    ...(accessibilityError ? [['accessibility_error', accessibilityError]] : []),
  ]);
}

export function diagnosticRecord(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof input.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.at)) result.at = input.at;
  for (const key of ['action', 'delivery', 'effect', 'code', 'error', 'path', 'escalation', 'stage']) {
    const value = diagnosticCategory(input[key]);
    if (value) result[key] = value;
  }
  for (const key of ['ok', 'verified', 'goal_verified', 'completed', 'input_may_have_executed', 'delivery_accepted']) {
    if (booleanEvidence(key, input[key])) result[key] = input[key];
  }
  if (typeof input.window_id === 'string' && /^hwnd:0x[0-9a-f]{1,16}$/i.test(input.window_id)) {
    result.window_id = input.window_id;
  }
  if (typeof input.ms === 'number' && Number.isFinite(input.ms)) result.ms = Math.max(0, input.ms);
  result.recovery = recoveryEvidence(object(input.input_recovery ?? input.recovery));
  const native = object(input.native_result);
  result.native_result = nativeResultEvidence(native);
  result.cursor_feedback = computerCursorFeedback(input.cursor_feedback ?? native.cursor_feedback) ?? {};
  result.timings_ms = computerTimings(input.timings_ms);
  const { observation, observed } = observedRecord(input);
  result.observation = observationEvidence(observed);
  const captureTimings = computerTimings(input.capture_timings_ms ?? observation.timings_ms);
  const attempts = captureAttempts(input.capture_attempts ?? observed.capture_attempts);
  if (attempts.length) result.capture_attempts = attempts;
  if (Object.keys(captureTimings).length) result.capture_timings_ms = captureTimings;
  const steps = computerStepTimings(input.step_timings ?? input.steps ?? input.actions);
  if (steps.length) result.step_timings = steps;
  return result;
}

export function createComputerFailureDiagnostics(directory: string) {
  const histories = new Map<string, Record<string, unknown>[]>();
  const bundleIds = new Map<string, string>();
  const files = () =>
    readdirSync(directory)
      .filter((name) => /^failure-[0-9a-f-]+\.json$/.test(name))
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
        if (histories.size > MAX_SESSIONS) {
          const [oldest] = histories.keys();
          histories.delete(oldest);
          bundleIds.delete(oldest);
        }
        if (input.ok !== false && !(input.stage === 'cleanup' && history.some((record) => record.ok === false))) return;
        mkdirSync(directory, { recursive: true });
        const id = bundleIds.get(key) ?? randomUUID();
        bundleIds.set(key, id);
        const bundle = {
          version: 1,
          id,
          session: key,
          createdAt: new Date().toISOString(),
          platform: process.platform,
          screenshots: 'excluded',
          records: history,
        };
        const text = JSON.stringify(bundle);
        if (Buffer.byteLength(text) > MAX_BYTES) return;
        const pending = join(directory, `pending-${id}.json`);
        writeFileSync(pending, text, { mode: 0o600 });
        renameSync(pending, join(directory, `failure-${id}.json`));
        for (const file of files().slice(MAX_BUNDLES)) unlinkSync(join(directory, file.name));
      } catch {
        /* diagnostic failure must not alter an action's outcome */
      }
    },
    read(): unknown[] {
      try {
        return files()
          .slice(0, MAX_BUNDLES)
          .flatMap(({ name }) => {
            try {
              const path = join(directory, name);
              if (statSync(path).size > MAX_BYTES) return [];
              const value = JSON.parse(readFileSync(path, 'utf8'));
              // Reapply the boundary even to persisted files.
              return [
                {
                  version: 1,
                  screenshots: 'excluded',
                  id: /^[0-9a-f-]{36}$/.test(value.id) ? value.id : undefined,
                  createdAt: diagnosticRecord({ at: value.createdAt }).at,
                  records: Array.isArray(value.records)
                    ? value.records.slice(-MAX_RECORDS).map((record: unknown) => diagnosticRecord(object(record)))
                    : [],
                },
              ];
            } catch {
              return [];
            }
          });
      } catch {
        return [];
      }
    },
  };
}
