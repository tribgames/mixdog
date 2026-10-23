import { t } from './i18n';

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Why a document preview failed, in the UI language. The runtime words the
 *  "no LibreOffice or Microsoft Office" failure in English with a stable code;
 *  every other failure keeps the text it carried. */
export function documentPreviewError(reason: unknown): string {
  const message = errorMessage(reason);
  if (message.includes('OFFICE_PREVIEW_PASSWORD_PROTECTED')) {
    return t("This file is password-protected and can't be previewed.");
  }
  return message.includes('OFFICE_PREVIEW_UNAVAILABLE')
    ? t(
        'Previewing Office files needs LibreOffice or Microsoft Office, and neither was found. To install LibreOffice, open Extensions → Built-in → Office and choose Install, then try again.'
      )
    : message;
}

/** A read, stat or write that finds no file means the tab outlived its path
 *  (deleted, or renamed outside this editor): say so instead of the raw
 *  ENOENT text. */
export function fileAccessError(reason: unknown): string {
  const message = errorMessage(reason);
  return /ENOENT|no such file|cannot find/i.test(message) ? t('File was deleted or renamed on disk.') : message;
}
