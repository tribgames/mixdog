import { useCallback, useMemo } from 'react';
import { STALE_SESSION_VIEW_MARKER } from '../../shared/session-devices';
import { t } from '../i18n';

/** The host's refusal of a send from a stale view arrives as English text; say
 *  it in the UI language. The draft stays in the composer. */
export function localizedInvocationError(message: string): string {
  return message.includes(STALE_SESSION_VIEW_MARKER)
    ? t('This conversation changed on another device. Review the latest messages, then send again.')
    : message;
}

export const BRIDGE_UNAVAILABLE_ERROR = 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.';

export function useAppInvocation({
  error,
  connected,
  setError,
}: {
  error: string;
  connected: boolean;
  setError: (message: string) => void;
}) {
  const invokeResult = useCallback(
    async <T>(action: () => T | Promise<T>): Promise<T | undefined> => {
      setError('');
      try {
        return await action();
      } catch (reason) {
        setError(localizedInvocationError(reason instanceof Error ? reason.message : String(reason)));
        return undefined;
      }
    },
    [setError]
  );
  const invoke = useCallback(
    async (action: () => unknown): Promise<void> => {
      await invokeResult(action);
    },
    [invokeResult]
  );
  const errors = useMemo(
    () => [error || (!connected ? BRIDGE_UNAVAILABLE_ERROR : '')].filter(Boolean),
    [connected, error]
  );
  return { invokeResult, invoke, errors };
}
