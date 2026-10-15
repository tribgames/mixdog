import { useEffect, useMemo, useState } from 'react';
import { navigationKey } from '../text-format';
import { sessionSummaryTitle } from '../../shared/session-title.mjs';
import type { useAppSessionActions } from '../use-app-session-actions';
import { isMobileRemoteSurface } from '../mobile-surface';
import { useShellUpdateReload } from '../use-shell-update-reload';
import { currentVisibleSessionIds } from '../use-visible-sessions';
import { t } from '../i18n';

type SessionActivityOptions = Pick<
  Parameters<typeof useAppSessionActions>[0],
  'sessions' | 'setTabs' | 'refreshSessions'
> & {
  setSessionCatalogReady: (ready: boolean) => void;
  subscribeSessionsRemoved: (listener: (sessionIds: string[]) => void) => () => void;
  closePaneTab: (key: string) => void;
};

export function useAppSessionActivity({
  sessions,
  setTabs,
  refreshSessions,
  setSessionCatalogReady,
  subscribeSessionsRemoved,
  closePaneTab,
}: SessionActivityOptions) {
  // Re-evaluate unread consumption when a desktop window or phone resumes.
  const [windowFocusTick, setWindowFocusTick] = useState(0);
  useEffect(() => {
    const onEngage = () => setWindowFocusTick((tick) => (tick + 1) % 1_000_000);
    window.addEventListener('focus', onEngage);
    // A resumed phone does not reliably pair its return with visibilitychange.
    window.addEventListener('pageshow', onEngage);
    document.addEventListener('visibilitychange', onEngage);
    return () => {
      window.removeEventListener('focus', onEngage);
      window.removeEventListener('pageshow', onEngage);
      document.removeEventListener('visibilitychange', onEngage);
    };
  }, []);

  // A phone holds no turn of its own: only the conversation it shows can be
  // interrupted by adopting a deploy, not every agent working on the desktop.
  const shown = isMobileRemoteSurface() ? new Set(currentVisibleSessionIds()) : null;
  useShellUpdateReload({
    busy: sessions.some((session) => session.working === true && (!shown || shown.has(String(session.id)))),
  });
  const runningAutomationNames = useMemo(() => {
    const schedule = new Set<string>();
    const webhook = new Set<string>();
    for (const session of sessions) {
      if (session.working !== true || !session.sourceName) continue;
      if (session.sourceType === 'schedule') schedule.add(session.sourceName);
      if (session.sourceType === 'webhook') webhook.add(session.sourceName);
    }
    return { schedule, webhook };
  }, [sessions]);
  useEffect(() => {
    const catalogTitles = new Map(
      sessions.map((session) => [session.id, sessionSummaryTitle(session, t('Untitled session'))] as const)
    );
    if (!catalogTitles.size) return;
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        // A selection-pinned title is caller-owned, not catalog-owned.
        if (tab.selection.kind !== 'session' || tab.selection.title) return tab;
        const title = catalogTitles.get(tab.selection.id);
        if (!title || title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, [sessions, setTabs]);
  // A non-empty host catalog (listing or push) dropped sessions the previous
  // catalog held: they were deleted elsewhere (IPC, another window, the phone,
  // a sweep), so their tabs close. Cache seeds, optimistic edits, empty lists
  // and transport errors never reach this subscription, and a tab for a
  // session that was never listed (new draft, agent worker) is untouched.
  useEffect(
    () =>
      subscribeSessionsRemoved((removedIds) => {
        const gone = new Set(removedIds);
        setTabs((current) => {
          const next = current.filter((tab) => !(tab.selection.kind === 'session' && gone.has(tab.selection.id)));
          return next.length === current.length ? current : next;
        });
        for (const id of gone) closePaneTab(navigationKey({ kind: 'session', id }));
      }),
    [subscribeSessionsRemoved, setTabs, closePaneTab]
  );
  useEffect(() => {
    let live = true;
    // Child pane effects commit first, keeping visible reads ahead of this
    // lightweight catalog reconciliation in the worker queue.
    void refreshSessions()
      .catch(() => undefined)
      .finally(() => {
        if (live) setSessionCatalogReady(true);
      });
    return () => {
      live = false;
    };
  }, [refreshSessions, setSessionCatalogReady]);
  return { windowFocusTick, runningAutomationNames };
}
