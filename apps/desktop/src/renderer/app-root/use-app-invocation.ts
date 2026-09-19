import { useCallback, useMemo } from 'react';

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
        setError(reason instanceof Error ? reason.message : String(reason));
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
    () =>
      [error || (!connected ? 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.' : '')].filter(
        Boolean
      ),
    [connected, error]
  );
  return { invokeResult, invoke, errors };
}
