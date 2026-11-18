import { errorMessageText } from '../ErrorNotice';
import { t } from '../i18n';

/** A thrown error of the connection domain leads with its code (`connect-first: Connect to box ...`): the way every coded error
 *  of the domain reaches the window, whatever carries it. */
const CODE_LED = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*): /;

function codeOf(reason: unknown): string | undefined {
  return CODE_LED.exec(errorMessageText(reason))?.[1];
}

/** A refusal because the server is not attached (it disconnected). */
export function isConnectFirstError(reason: unknown): boolean {
  return codeOf(reason) === 'connect-first';
}

export function isUnknownSshLoginFlow(reason: unknown): boolean {
  return errorMessageText(reason) === 'OAuth login flow is no longer available.';
}

/** What a failed SSH call says, in the interface language: without Electron's IPC envelope, and the codes the connection domain
 *  throws worded by code (`name` is the server the call was about). Any other message is shown as it came. */
export function sshErrorText(reason: unknown, name = ''): string {
  switch (codeOf(reason)) {
    case 'connect-first':
      return t('Connect to {{name}} to manage its logins.', { name });
    case 'pc-accounts':
      return t('{{name}} uses this PC’s accounts. Switch it to server accounts to manage its logins.', { name });
    default:
      return errorMessageText(reason);
  }
}
