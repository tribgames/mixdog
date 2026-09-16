import { useEffect, useLayoutEffect } from 'react';

/** Register the current pane without waiting for an older pane's transcript.
 * Desktop transport versions fence out-of-order requests; the remote shim
 * owns its legacy encrypted-transport serialization. */
export function useVisibleSessions(sessionIds: string[]): void {
  const key = sessionIds.join('\0');
  useLayoutEffect(() => {
    const register = window.mixdogDesktop?.setVisibleSessions;
    if (!register) return;
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    const run = async (): Promise<void> => {
      let accepted = false;
      try {
        accepted = (await register(sessionIds)) === true;
      } catch {
        /* retry while current */
      }
      if (cancelled || accepted) return;
      const delay = Math.min(1_000, 80 * 2 ** Math.min(attempt++, 4));
      timer = window.setTimeout(() => {
        void run();
      }, delay);
    };
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key]);
  useEffect(
    () => () => {
      void window.mixdogDesktop?.setVisibleSessions?.([]).catch(() => undefined);
    },
    []
  );
}
