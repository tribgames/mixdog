// The Routines tile's rows: the schedules and webhooks one agent owns, in the
// display shapes channel-admin serves (`owner`, run stamps).
import { MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { ROUTINE_LIMITS } from '../../../../src/runtime/shared/routine-limits.mjs';
import type { RecordValue } from './desktop-types';

export interface RoutineRow extends RoutineHealth {
  name: string;
  enabled: boolean;
  /** The schedule's project folder name; '' runs as a task. */
  target: string;
  /** Next fire time (ms) of an enabled schedule; null when none is due. */
  nextAt: number | null;
  /** The latest finished run, success or failure; null before the first. */
  last: { at: number; ok: boolean } | null;
  source: RecordValue;
}

const stamp = (value: unknown): number | null => {
  const at = typeof value === 'string' && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** The latest finished run, success or failure; null before the first. */
function lastOutcome(row: RecordValue): RoutineRow['last'] {
  const success = stamp(row.lastSuccessAt);
  const failure = stamp(row.lastFailedAt);
  if (success === null && failure === null) return null;
  const ok = (success ?? -1) >= (failure ?? -1);
  return { at: ok ? (success as number) : (failure as number), ok };
}

/** What every routine row carries besides its kind's fields. */
export interface RoutineHealth {
  /** Failed runs in a row, when the routine switched itself off for them. */
  pausedAfter: number | null;
  /** A finished run's result the owner's queue refused; the tile offers a retry. */
  deliveryFailed: { error: string } | null;
}

/** channel-admin's `consecutiveFailures` / `undelivered` as display state. */
function routineHealth(row: RecordValue): RoutineHealth {
  const failures = Number(row.consecutiveFailures) || 0;
  const undelivered = row.undelivered && typeof row.undelivered === 'object' ? (row.undelivered as RecordValue) : null;
  return {
    pausedAfter: row.enabled === false && failures >= ROUTINE_LIMITS.pauseAfterFailures ? failures : null,
    deliveryFailed: undelivered?.failed === true ? { error: String(undelivered.error || '') } : null,
  };
}

/** The rows `agentId` owns; a row without an owner belongs to Mixy. */
const ownedBy = (agentId: string) => (row: RecordValue) =>
  (typeof row.owner === 'string' && row.owner ? row.owner : MIXY_AGENT_ID) === agentId;

/** The agents that own at least one schedule or webhook. */
export function routineOwners(setup: RecordValue): Set<string> {
  const owners = new Set<string>();
  for (const list of [setup.schedules, setup.webhooks]) {
    for (const row of Array.isArray(list) ? (list as RecordValue[]) : []) {
      owners.add(typeof row?.owner === 'string' && row.owner ? row.owner : MIXY_AGENT_ID);
    }
  }
  return owners;
}

/** The schedules `agentId` owns. */
export function routineRows(schedules: readonly RecordValue[], agentId: string): RoutineRow[] {
  return schedules
    .filter(ownedBy(agentId))
    .map((row) => {
      const cwd = typeof row.cwd === 'string' ? row.cwd : '';
      const enabled = row.enabled !== false;
      return {
        name: String(row.name || ''),
        enabled,
        target: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '',
        nextAt: enabled ? stamp(row.nextFireAt) : null,
        last: lastOutcome(row),
        source: row,
        ...routineHealth(row),
      };
    })
    .filter((row) => row.name);
}

export interface WebhookRoutineRow extends RoutineHealth {
  name: string;
  enabled: boolean;
  /** The sender's payload format (`github`, `generic`, …). */
  parser: string;
  /** When the latest event arrived; null before the first. */
  eventAt: number | null;
  last: RoutineRow['last'];
  /** Whether "Run now" has a received payload to re-run. */
  hasPayload: boolean;
}

/** The webhooks `agentId` owns, in the display shape of channel-admin's listWebhooks. */
export function webhookRoutineRows(webhooks: readonly RecordValue[], agentId: string): WebhookRoutineRow[] {
  return webhooks
    .filter(ownedBy(agentId))
    .map((row) => ({
      name: String(row.name || ''),
      enabled: row.enabled !== false,
      parser: String(row.parser || 'github'),
      eventAt: stamp(row.lastEventAt),
      last: lastOutcome(row),
      hasPayload: row.hasLastPayload === true,
      ...routineHealth(row),
    }))
    .filter((row) => row.name);
}
