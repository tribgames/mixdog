import { useState } from 'react';

import type { DesktopApi, DesktopCapability } from '../shared/contract';
import { showDesktopToast } from './notifications';
import { scheduleErrorText } from './schedule-error-text';

/** The mutation runner the Schedules, Webhooks and Workflows panels share:
 *  one capability at a time, settled through the host-scoped cache completion
 *  (which never re-adopts a host the app already left), failures reported
 *  inline or as a toast under the panel's own scope. Resolves `undefined` on
 *  failure so callers can keep their editor open. */
export function useSidebarCapabilityRunner({
  api,
  completeMutation,
  toastScope,
  onSuccess,
}: {
  api: Partial<Pick<DesktopApi, 'invokeCapability'>> | undefined;
  completeMutation(mutation: string): Promise<void>;
  toastScope: string;
  onSuccess?(): void;
}) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const run = async (
    capability: DesktopCapability,
    args: unknown[] = [],
    errorMode: 'inline' | 'toast' = 'inline'
  ): Promise<unknown> => {
    if (!api?.invokeCapability || pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability({ capability, args });
      await completeMutation(capability);
      onSuccess?.();
      return result?.value ?? true;
    } catch (reason) {
      const message = scheduleErrorText(reason);
      if (errorMode === 'toast') showDesktopToast(message, 'error', { scope: `${toastScope}:${capability}` });
      else setError(message);
      return undefined;
    } finally {
      setPending('');
    }
  };
  return { pending, error, setError, run };
}
