import { sessionSummaryTitle, sessionTitleLabel } from '../shared/session-title.mjs';
import { t } from './i18n';

/** A session titled by a message with attachments and no words keeps the
 *  provisional `[Image]` / `[Video]` / `[File]` placeholder (a later worded
 *  title replaces it); on screen it reads as the localized kind, never the
 *  raw placeholder. Any other title is shown as it is. */
export function displaySessionTitle(title: string): string {
  return sessionTitleLabel(title, PLACEHOLDER_LABELS);
}

// Looked up on read: only the placeholder's own kind is translated.
const PLACEHOLDER_LABELS = {
  get image() {
    return t('Image');
  },
  get video() {
    return t('Video');
  },
  get file() {
    return t('File');
  },
};

/** `sessionSummaryTitle` for display: placeholders read as their kind. */
export function sessionDisplayTitle(session: Parameters<typeof sessionSummaryTitle>[0], fallback?: string): string {
  return displaySessionTitle(sessionSummaryTitle(session, fallback));
}
