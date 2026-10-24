import { t } from './i18n';
import { displayErrorMessage, errorParams } from '../shared/coded-error';
import {
  SCHEDULE_NAME_TAKEN,
  SCHEDULE_RENAME_RELOAD_FAILED,
  SCHEDULE_RENAME_RUNNING,
  SCHEDULE_RENAME_UNCERTAIN,
  scheduleErrorCode,
} from '../shared/schedule-error-codes';

/** The text a failed panel call shows: a schedule refusal is translated by
 *  its code and `name` param (both transports keep them); any other failure
 *  shows its message as it came. */
export function scheduleErrorText(error: unknown): string {
  const message = displayErrorMessage(error);
  const code = scheduleErrorCode(error);
  const name = errorParams(error)?.name;
  if (code === SCHEDULE_RENAME_UNCERTAIN) {
    return t('The rename may or may not have applied because the scheduler did not answer. Check the schedule list.');
  }
  if (!name) return message;
  if (code === SCHEDULE_NAME_TAKEN) return t('A schedule named "{{name}}" already exists.', { name });
  if (code === SCHEDULE_RENAME_RUNNING) {
    return t('Schedule "{{name}}" is running. Rename it after the run finishes.', { name });
  }
  if (code === SCHEDULE_RENAME_RELOAD_FAILED) {
    return t('Renamed to "{{name}}", but the scheduler could not reload. It is armed on the next reload.', { name });
  }
  return message;
}
