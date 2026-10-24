// Structured reasons a schedule rename is refused or ends unsure, mirroring
// the engine's src/runtime/channels/lib/schedule-errors.mjs. A display surface
// decides on the `code` and the `name` parameter the error carries
// (coded-error.ts), never on the English message, which is for the model and
// the logs.
import { carriedErrorCode } from './error-trailer';

/** Another schedule already has the name (param: `name`, the name asked for). */
export const SCHEDULE_NAME_TAKEN = 'SCHEDULE_NAME_TAKEN';
/** A run of the schedule, or another rename of it, is in flight (param: `name`). */
export const SCHEDULE_RENAME_RUNNING = 'SCHEDULE_RENAME_RUNNING';
/** The row moved but the scheduler did not reload (param: `name`, the new name). */
export const SCHEDULE_RENAME_RELOAD_FAILED = 'SCHEDULE_RENAME_RELOAD_FAILED';
/** The scheduler never answered, so the rename may or may not have applied. */
export const SCHEDULE_RENAME_UNCERTAIN = 'SCHEDULE_RENAME_UNCERTAIN';

/** The display params these codes declare public: a schedule's own name. */
export const SCHEDULE_CODE_PARAMS: Readonly<Record<string, readonly 'name'[]>> = {
  [SCHEDULE_NAME_TAKEN]: ['name'],
  [SCHEDULE_RENAME_RUNNING]: ['name'],
  [SCHEDULE_RENAME_RELOAD_FAILED]: ['name'],
};

export const SCHEDULE_CODES: ReadonlySet<string> = new Set([
  SCHEDULE_NAME_TAKEN,
  SCHEDULE_RENAME_RUNNING,
  SCHEDULE_RENAME_RELOAD_FAILED,
  SCHEDULE_RENAME_UNCERTAIN,
]);

/** The schedule code an error carries, or undefined for any other `code`. */
export function scheduleErrorCode(error: unknown): string | undefined {
  const code = carriedErrorCode(error, SCHEDULE_CODES);
  return typeof code === 'string' && SCHEDULE_CODES.has(code) ? code : undefined;
}
