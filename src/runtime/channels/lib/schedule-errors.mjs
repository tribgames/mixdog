// Structured reasons a schedule rename is refused or ends unsure. The app
// decides on the `code` and the `name` detail (the desktop's
// shared/schedule-error-codes.ts mirrors these codes), never on the English
// message, which is for the model and the logs.

/** Another schedule already has the name (detail: `name`, the name asked for). */
export const SCHEDULE_NAME_TAKEN = 'SCHEDULE_NAME_TAKEN';
/** A run of the schedule is in flight, or another rename of it (detail: `name`). */
export const SCHEDULE_RENAME_RUNNING = 'SCHEDULE_RENAME_RUNNING';
/** The row moved but the scheduler did not reload (detail: `name`, the new name). */
export const SCHEDULE_RENAME_RELOAD_FAILED = 'SCHEDULE_RENAME_RELOAD_FAILED';
/** The scheduler never answered, so the rename may or may not have applied. */
export const SCHEDULE_RENAME_UNCERTAIN = 'SCHEDULE_RENAME_UNCERTAIN';

const NAMED_CODES = new Set([SCHEDULE_NAME_TAKEN, SCHEDULE_RENAME_RUNNING, SCHEDULE_RENAME_RELOAD_FAILED]);
const CODES = new Set([...NAMED_CODES, SCHEDULE_RENAME_UNCERTAIN]);

/** The fields of `error` a reply may carry across the worker boundary: a
 *  schedule code and, for the codes that name a schedule, that public `name`.
 *  Any other code or detail stays on this side. */
export function scheduleErrorFields(error) {
  const code = error?.code;
  if (typeof code !== 'string' || !CODES.has(code)) return {};
  const name = error.details?.name;
  return {
    code,
    ...(NAMED_CODES.has(code) && typeof name === 'string' && name ? { details: { name } } : {}),
  };
}

const coded = (message, code, details = null) =>
  Object.assign(new Error(message), { code }, details ? { details } : {});

export const scheduleNameTakenError = (name) =>
  coded(`A schedule named "${name}" already exists.`, SCHEDULE_NAME_TAKEN, { name });

export const scheduleRenameRunningError = (name) =>
  coded(`Schedule "${name}" is running. Rename it after the run finishes.`, SCHEDULE_RENAME_RUNNING, { name });

export const scheduleRenameReloadError = (name, cause) =>
  coded(
    `Renamed to "${name}", but reloading the scheduler failed (${cause}); it is armed on the next reload.`,
    SCHEDULE_RENAME_RELOAD_FAILED,
    { name }
  );

export const scheduleRenameUncertainError = (cause) =>
  coded(
    `The rename may or may not have applied (the scheduler did not answer: ${cause}). Check the schedule list.`,
    SCHEDULE_RENAME_UNCERTAIN
  );
