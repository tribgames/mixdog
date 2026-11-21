// `opOutcomeUnknown` (packages/protocol-client): the connection was lost and the core's record of the op cannot be read, so the action may have run.
import { isOutcomeUnknown } from '../shared/outcome-unknown';
import { t } from './i18n';

/** The text the dock shows for a failed Git action. */
export function gitActionFailureText(reason: unknown): string {
  if (isOutcomeUnknown(reason))
    return t(
      'Connection was lost before this Git action was confirmed, so it may have run. Check the repository status before trying it again.'
    );
  return reason instanceof Error ? reason.message : String(reason);
}
