import { t } from './i18n';

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The preview found neither LibreOffice nor Microsoft Office. */
export function isOfficePreviewUnavailable(reason: unknown): boolean {
  return errorMessage(reason).includes('OFFICE_PREVIEW_UNAVAILABLE');
}

/** The document is password-protected and a password can open it: the pane
 *  asks for one. */
export function isDocumentPasswordRequired(reason: unknown): boolean {
  return errorMessage(reason).includes('OFFICE_PREVIEW_PASSWORD_PROTECTED');
}

/** The password given for a protected document did not open it. */
export function isDocumentWrongPassword(reason: unknown): boolean {
  return errorMessage(reason).includes('OFFICE_PREVIEW_WRONG_PASSWORD');
}

/** Why a document preview failed, in the UI language. The runtime words the
 *  "no LibreOffice or Microsoft Office" and password failures in English with
 *  a stable code; every other failure keeps the text it carried. */
export function documentPreviewError(reason: unknown): string {
  const message = errorMessage(reason);
  if (/OFFICE_PREVIEW_(PASSWORD_PROTECTED|PASSWORD_UNSUPPORTED|PASSWORD_CORRUPT|WRONG_PASSWORD)/.test(message)) {
    return t("This file is password-protected and can't be previewed.");
  }
  if (message.includes('OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE')) {
    return t('Previewing this password-protected file needs Microsoft Office.');
  }
  return isOfficePreviewUnavailable(reason)
    ? t(
        'Previewing Office files needs LibreOffice or Microsoft Office, and neither was found. To install LibreOffice, open Extensions → Built-in → Office and choose Install, then try again.'
      )
    : message;
}

/** A read, stat or write that finds no file means the tab outlived its path
 *  (deleted, or renamed outside this editor): say so instead of the raw
 *  ENOENT text. */
export function fileAccessError(reason: unknown): string {
  return isFileGone(reason) ? t('File was deleted or renamed on disk.') : errorMessage(reason);
}

/** The path no longer names a file. Errors cross IPC as message text only. */
export function isFileGone(reason: unknown): boolean {
  return /ENOENT|no such file|cannot find/i.test(errorMessage(reason));
}

/** A save refused because the disk text differs from the text it was based on
 *  (project-files.ts words every such refusal "changed on disk"). */
export function isFileChangedOnDisk(reason: unknown): boolean {
  return /changed on disk/i.test(errorMessage(reason));
}
