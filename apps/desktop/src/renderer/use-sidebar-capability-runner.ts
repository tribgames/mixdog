import { useRef, useState } from 'react';

import type { DesktopApi, DesktopCapability } from '../shared/contract';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { scheduleErrorText } from './schedule-error-text';

/** A save whose editor can close before it settles: its failure shows inline
 *  only while `showErrorInline()` holds, as a toast otherwise. */
type SaveSettlement = {
  showErrorInline(): boolean;
  /** A stored schedule's receipt: the list refresh then runs without holding the panel busy. */
  onSaved?(value: unknown): void;
};

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
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const run = async (
    capability: DesktopCapability,
    args: unknown[] = [],
    settlement: 'inline' | 'toast' | SaveSettlement = 'inline'
  ): Promise<unknown> => {
    if (!api?.invokeCapability || inFlight.current) return undefined;
    inFlight.current = true;
    setPending(capability);
    setError('');
    const save = typeof settlement === 'object' ? settlement : undefined;
    let result: Awaited<ReturnType<DesktopApi['invokeCapability']>>;
    try {
      result = await api.invokeCapability({ capability, args });
      if (!save?.onSaved) {
        await completeMutation(capability);
        onSuccess?.();
      }
    } catch (reason) {
      const message = scheduleErrorText(reason);
      if (settlement === 'toast' || (save && !save.showErrorInline())) {
        showDesktopToast(message, 'error', { scope: `${toastScope}:${capability}` });
      } else {
        setError(message);
      }
      return undefined;
    } finally {
      inFlight.current = false;
      setPending('');
    }
    if (save?.onSaved) {
      // The receipt is already a stored schedule. Reconciliation must not
      // hold the editor busy or turn an acknowledged write into a failed save.
      save.onSaved(result?.value);
      void completeMutation(capability).catch((reason) => {
        showDesktopToast(
          t('Schedule saved, but the list could not be refreshed: {{error}}', { error: scheduleErrorText(reason) }),
          'error',
          { scope: `${toastScope}:${capability}:refresh` }
        );
      });
      onSuccess?.();
    }
    return result?.value ?? true;
  };
  return { pending, error, setError, run };
}
