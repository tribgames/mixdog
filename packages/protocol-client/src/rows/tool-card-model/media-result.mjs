/**
 * media-result.mjs — the media tool's JSON job outcome: `{ ok, job, status,
 * error, canceled }`. A status read that succeeded is distinct from the job
 * state it inspected.
 */
import { normalizeToolTerminalStatus } from '../tool-status.mjs';

export function parseMediaOutcome(text) {
  const body = String(text || '').trim();
  if (!body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      ok: parsed.ok !== false,
      job: String(parsed.job || ''),
      jobStatus: normalizeToolTerminalStatus(parsed.status),
      error: typeof parsed.error === 'string' ? parsed.error.trim() : '',
      canceled: parsed.canceled === true,
    };
  } catch {
    return null;
  }
}

/** The tool call's own outcome: a read of a failed job still read fine. */
export function mediaTerminalStatus(args, text) {
  const outcome = parseMediaOutcome(text);
  if (!outcome) return '';
  if (!outcome.ok) return 'failed';
  const action = String(args?.action || '').toLowerCase();
  if (action === 'cancel') return outcome.canceled || outcome.jobStatus === 'cancelled' ? 'cancelled' : 'completed';
  return 'completed';
}

const JOB_WORDS = new Map([
  ['running', 'running'],
  ['completed', 'done'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
]);

export function mediaResultSummary(args, text) {
  const outcome = parseMediaOutcome(text);
  if (!outcome) return null;
  if (!outcome.ok) return outcome.error || 'Failed';
  const action = String(args?.action || '').toLowerCase();
  if (action === 'cancel' && (outcome.canceled || outcome.jobStatus === 'cancelled')) return 'Cancelled';
  if ((action === 'status' || action === 'cancel') && JOB_WORDS.has(outcome.jobStatus)) {
    return `Job ${JOB_WORDS.get(outcome.jobStatus)}`;
  }
  return null;
}
