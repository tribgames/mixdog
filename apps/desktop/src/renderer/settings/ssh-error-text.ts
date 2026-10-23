import { errorMessageText } from '../ErrorNotice';
import { t } from '../i18n';

const CONNECT_FIRST = /^Connect to (.+) to manage its logins\.$/;
const PC_ACCOUNTS = /^(.+) uses this PC's accounts\. Switch it to server accounts to manage its logins\.$/;

/** A refusal because the server is not attached (it disconnected). */
export function isConnectFirstError(reason: unknown): boolean {
  return CONNECT_FIRST.test(errorMessageText(reason));
}

/** What a failed SSH call says, in the interface language: without Electron's
 *  IPC envelope, and with the server-login refusals main words in English
 *  translated. Any other message is shown as it came. */
export function sshErrorText(reason: unknown): string {
  const message = errorMessageText(reason);
  const connect = CONNECT_FIRST.exec(message);
  if (connect) return t('Connect to {{name}} to manage its logins.', { name: connect[1] });
  const pc = PC_ACCOUNTS.exec(message);
  if (pc) {
    return t('{{name}} uses this PC’s accounts. Switch it to server accounts to manage its logins.', {
      name: pc[1],
    });
  }
  return message;
}
