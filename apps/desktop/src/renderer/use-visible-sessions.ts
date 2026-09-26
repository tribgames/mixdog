import { useEffect, useLayoutEffect } from 'react';

/** Register the current pane without waiting for an older pane's transcript.
 * Desktop transport versions fence out-of-order requests; the remote shim
 * owns its legacy encrypted-transport serialization. */
let shownSessionIds: readonly string[] = [];

/** The sessions this window currently shows (last registration). */
export function currentVisibleSessionIds(): readonly string[] {
  return shownSessionIds;
}

export function useVisibleSessions(sessionIds: string[]): void {
  const key = sessionIds.join('\0');
  useLayoutEffect(() => {
    shownSessionIds = sessionIds;
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
