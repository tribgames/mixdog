/** Recovery owns only the read-only preflight, never the gesture or its
 * verification. A stale result after input must not replay the operation. */
import { throwIfBrowserCancelled } from '../settle';
import type { BrowserActionContext } from './types';

export async function mutateRef<T>(
  context: BrowserActionContext,
  sourceRef: string,
  operation: (ref: string) => Promise<T>,
  editable = false
): Promise<T> {
  const { guest, signal, refRecovery, services } = context;
  const ref = await services.reply.withRefRecovery(
    guest,
    refRecovery,
    sourceRef,
    (candidate) => services.refActions.prepareRef(guest, candidate, signal, editable),
    signal
  );
  throwIfBrowserCancelled(signal);
  try {
    return await operation(ref);
  } catch (error) {
    services.state.invalidateInteraction(guest);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
        'input may have executed and was not replayed; take a fresh snapshot before continuing'
    );
  }
}
