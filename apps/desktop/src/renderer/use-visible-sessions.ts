import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { defaultSessionLaneStore } from './session-lane-store';
import { useWorkspaceCovered } from './workspace-cover';

/** Until startup settles, an empty set is the boot's provisional New Task frame, not a view. */
function provisionalBootFrame(sessionIds: readonly string[]): boolean {
  return (
    sessionIds.length === 0 &&
    isRemoteHostRenderer() &&
    !(window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled
  );
}

let shownSessionIds: readonly string[] = [];

/** The lane store learns the registration too: a shown session's lane is its
 *  current state once a frame arrives (session-attention-index). */
function setShownSessionIds(sessionIds: readonly string[]): void {
  shownSessionIds = sessionIds;
  defaultSessionLaneStore.setShownSessionIds(sessionIds);
}

/** The sessions this window currently shows (last registration). */
export function currentVisibleSessionIds(): readonly string[] {
  return shownSessionIds;
}

interface RegistrationHolder {
  ids: readonly string[];
}

/** One window-wide set held by several hook instances: the newest registration
 *  is the set, and a leaving instance withdraws only its own. */
function createSharedRegistration(apply: (ids: readonly string[]) => void) {
  // Mounted holders in registration order, the newest last.
  const holders: RegistrationHolder[] = [];
  return {
    hold(holder: RegistrationHolder, ids: readonly string[]): void {
      const index = holders.indexOf(holder);
      if (index >= 0) holders.splice(index, 1);
      holder.ids = ids;
      holders.push(holder);
      apply(ids);
    },
    release(holder: RegistrationHolder): void {
      const index = holders.indexOf(holder);
      if (index < 0) return;
      holders.splice(index, 1);
      if (index === holders.length) apply(holders.at(-1)?.ids ?? []);
    },
  };
}

function useSharedRegistration(
  registration: ReturnType<typeof createSharedRegistration>,
  sessionIds: readonly string[]
): void {
  const [holder] = useState<RegistrationHolder>(() => ({ ids: [] }));
  const key = sessionIds.join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the content signature of sessionIds, so a new array with the same ids does not re-register
  useLayoutEffect(() => {
    registration.hold(holder, sessionIds);
  }, [key]);
  useEffect(() => () => registration.release(holder), [registration, holder]);
}

// The registration in flight: a newer one cancels its retries and its wait for startup.
let cancelVisibleRegistration = (): void => undefined;

function registerVisibleSessions(sessionIds: readonly string[]): void {
  cancelVisibleRegistration();
  cancelVisibleRegistration = () => undefined;
  setShownSessionIds(sessionIds);
  const register = window.mixdogDesktop?.setVisibleSessions;
  if (!register) return;
  const ids = [...sessionIds];
  let cancelled = false;
  let timer = 0;
  let attempt = 0;
  const run = async (): Promise<void> => {
    let accepted = false;
    try {
      accepted = (await register(ids)) === true;
    } catch {
      /* retry while current */
    }
    if (cancelled || accepted) return;
    const delay = Math.min(1_000, 80 * 2 ** Math.min(attempt++, 4));
    timer = window.setTimeout(() => {
      void run();
    }, delay);
  };
  if (provisionalBootFrame(ids)) {
    // Still empty once startup settles (a New Task boot): register it then.
    const settled = () => void run();
    window.addEventListener('mixdog:startup-settled', settled, { once: true });
    cancelVisibleRegistration = () => {
      cancelled = true;
      window.removeEventListener('mixdog:startup-settled', settled);
      window.clearTimeout(timer);
    };
    return;
  }
  cancelVisibleRegistration = () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
  void run();
}

const visibleRegistration = createSharedRegistration(registerVisibleSessions);

let screenSessionIds: readonly string[] = [];
const screenSessionListeners = new Set<() => void>();

function publishScreenSessions(sessionIds: readonly string[]): void {
  screenSessionIds = sessionIds;
  for (const listener of screenSessionListeners) listener();
  window.mixdogDesktop?.reportScreenSessions?.([...sessionIds]);
}

const screenRegistration = createSharedRegistration((ids) => publishScreenSessions([...ids]));

function subscribeScreenSessions(listener: () => void): () => void {
  screenSessionListeners.add(listener);
  return () => screenSessionListeners.delete(listener);
}

/** The sessions this window paints (last report): every visible pane, the
 *  focused one or not. Unread reading follows it. */
export function currentScreenSessionIds(): readonly string[] {
  return screenSessionIds;
}

/** `currentScreenSessionIds`, re-rendering the caller on every report. */
export function useScreenSessionIds(): readonly string[] {
  return useSyncExternalStore(
    subscribeScreenSessions,
    () => screenSessionIds,
    () => screenSessionIds
  );
}

/** Tell main which sessions this window actually shows (pane-active sessions
 *  only), so a completion elsewhere still notifies while this window is focused. Nothing is shown while a modal or an
 *  expanded sheet covers the workspace; the report follows those transitions. */
export function useScreenSessions(sessionIds: readonly string[]): void {
  const covered = useWorkspaceCovered();
  useSharedRegistration(screenRegistration, covered ? [] : sessionIds);
}

export function useVisibleSessions(sessionIds: string[]): void {
  useSharedRegistration(visibleRegistration, sessionIds);
}
