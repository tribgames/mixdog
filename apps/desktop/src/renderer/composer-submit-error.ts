import { t } from './i18n';
import { displayErrorMessage, errorParams } from '../shared/coded-error';
import { roomErrorCode, ROOM_MEMBER_SWITCHED_OFF } from '../shared/room-error-codes';

/** The text a refused send shows under the composer: a coded refusal is
 *  translated by its code (desktop and phone alike, the code survives both
 *  transports); any other message is shown as it came. */
export function composerSubmitErrorText(error: unknown): string {
  if (!(error instanceof Error) || !error.message) {
    return 'The connection was interrupted. Your message has been kept for retry.';
  }
  const code = roomErrorCode(error);
  const name = errorParams(error)?.name;
  if (code === ROOM_MEMBER_SWITCHED_OFF) {
    return name ? t('"{{name}}" is switched off.', { name }) : t('This bot is switched off.');
  }
  return displayErrorMessage(error);
}
