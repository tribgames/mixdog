/**
 * Run a schedule fire: its instructions become one turn in its owner bot's
 * home thread (routine-home-turn.mjs), under the owned-routine guards
 * (owned-automation-run.mjs). Shared by the engine's "Run now" and the
 * channels-worker scheduler.
 */
import { markScheduleSkipped } from '../runtime/channels/lib/schedules-db.mjs';
import { runOwnedAutomation } from './owned-automation-run.mjs';
import { runRoutineTurn } from './routine-home-turn.mjs';

/**
 * One fire of `schedule`. `prompt` overrides schedule.prompt when the caller
 * (channels worker) already resolved the body; `attended` marks a person's
 * "Run now" (no failure backoff); `reserved` that the caller holds the name
 * (owned-automation-run.mjs beginAutomationRename).
 */
export async function runScheduleSession(
  schedule,
  { attended = false, prompt = null, signal = null, reserved = false } = {}
) {
  const body = String(prompt ?? schedule.prompt ?? '').trim();
  return runOwnedSchedule(
    schedule,
    ({ signal: runSignal }) =>
      runRoutineTurn({
        kind: 'schedule',
        name: schedule.name,
        ownerAgentId: schedule.ownerAgentId,
        prompt: body,
        attachments: schedule.attachments,
        cwd: schedule.cwd || null,
        signal: runSignal,
      }),
    { attended, signal, reserved }
  );
}

/** One owned run of `schedule` (owned-automation-run.mjs). */
export function runOwnedSchedule(schedule, run, { recordSkip = markScheduleSkipped, ...deps } = {}) {
  return runOwnedAutomation('schedule', schedule, run, { recordSkip, ...deps });
}
