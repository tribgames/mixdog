import { useEffect, useLayoutEffect } from 'react';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useWorkspaceCovered } from './workspace-cover';

/** Until startup settles, an EMPTY set is the boot's provisional New Task
 *  frame, not a view: the relay client already named the restored session
 *  when it connected, and clearing it first made the host drop that head
 *  start and re-synchronize the whole view moments later. */
function provisionalBootFrame(sessionIds: readonly string[]): boolean {
  return (
    sessionIds.length === 0 &&
    isRemoteHostRenderer() &&
    !(window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled
  );
}

/** Register the current pane without waiting for an older pane's transcript.
 * Desktop transport versions fence out-of-order requests; the remote shim
 * owns its legacy encrypted-transport serialization. */
let shownSessionIds: readonly string[] = [];

/** The sessions this window currently shows (last registration). */
export function currentVisibleSessionIds(): readonly string[] {
  return shownSessionIds;
}

/** Tell main which sessions this window actually shows (pane-active sessions
 *  only, not the Agents dock's observed ones), so a completion elsewhere still
 *  notifies while this window is focused. Nothing is shown while a modal or an
 *  expanded sheet covers the workspace; the report follows those transitions. */
export function useScreenSessions(sessionIds: readonly string[]): void {
  const covered = useWorkspaceCovered();
  const shown = covered ? [] : sessionIds;
  const key = shown.join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the content signature of shown
  useLayoutEffect(() => {
    window.mixdogDesktop?.reportScreenSessions?.([...shown]);
  }, [key]);
  useEffect(
    () => () => {
      window.mixdogDesktop?.reportScreenSessions?.([]);
    },
    []
  );
}

export function useVisibleSessions(sessionIds: string[]): void {
  const key = sessionIds.join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the content signature of sessionIds, so a new array with the same ids does not re-register
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
    if (provisionalBootFrame(sessionIds)) {
      // Still empty once startup settles (a New Task boot): register it then.
      const settled = () => void run();
      window.addEventListener('mixdog:startup-settled', settled, { once: true });
      return () => {
        cancelled = true;
        window.removeEventListener('mixdog:startup-settled', settled);
        window.clearTimeout(timer);
      };
    }
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
