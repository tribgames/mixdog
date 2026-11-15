// How the dock words the failure of a Git action. Every action carries an op id and is never replayed after the connection to
// the core is lost; when the answer never came back and the core's own record of the op cannot be read either, the client
// library fails the call with `opOutcomeUnknown` (packages/protocol-client). Its bare message is a protocol word, and the action
// may have run: the person is told that, and to look at the repository before trying again.
import { t } from './i18n';

/** Whether `reason` is the client library's failure for an action whose outcome could not be learned. */
export function isOutcomeUnknown(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  return (reason as { detail?: { kind?: unknown } }).detail?.kind === 'opOutcomeUnknown' || reason.message === 'opOutcomeUnknown';
}

/** The text the dock shows for a failed Git action. */
export function gitActionFailureText(reason: unknown): string {
  if (isOutcomeUnknown(reason))
    return t(
      'Mixdog lost its connection before this Git action was confirmed, so it may have run. Check the repository status before trying it again.'
    );
  return reason instanceof Error ? reason.message : String(reason);
}
