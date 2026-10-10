import { t } from './i18n';

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A read, stat or write that finds no file means the tab outlived its path
 *  (deleted, or renamed outside this editor): say so instead of the raw
 *  ENOENT text. */
export function fileAccessError(reason: unknown): string {
  const message = errorMessage(reason);
  return /ENOENT|no such file|cannot find/i.test(message) ? t('File was deleted or renamed on disk.') : message;
}
