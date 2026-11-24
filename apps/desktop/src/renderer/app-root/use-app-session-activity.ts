import { useEffect, useMemo } from 'react';
import { BOT_DELETED_EVENT } from '../agent-profile-actions';
import { closeSessionTabsEverywhere } from '../session-tab-cleanup';
import { sessionDisplayTitle } from '../session-display-title';
import type { useAppSessionActions } from '../use-app-session-actions';
import { isMobileRemoteSurface } from '../mobile-surface';
import { useShellUpdateReload } from '../use-shell-update-reload';
import { currentVisibleSessionIds } from '../use-visible-sessions';
import { t } from '../i18n';
import type { WorkspaceTab } from '../navigation';
import type { DesktopSessionSummary } from '../../shared/contract';
import { isIncompleteCatalogError } from '../../shared/session-catalog';

export function retitleSessionTabs(tabs: WorkspaceTab[], sessions: readonly DesktopSessionSummary[]): WorkspaceTab[] {
  let byId: Map<string, DesktopSessionSummary> | null = null;
  let changed = false;
  const next = tabs.map((tab) => {
    // A selection-pinned title is caller-owned, not catalog-owned.
    if (tab.selection.kind !== 'session' || tab.selection.title) return tab;
    byId ??= new Map(sessions.map((session) => [session.id, session]));
    const session = byId.get(tab.selection.id);
    if (!session) return tab;
    const title = sessionDisplayTitle(session, t('Untitled session'));
    if (!title || title === tab.title) return tab;
    changed = true;
    return { ...tab, title };
  });
  return changed ? next : tabs;
}

type SessionActivityOptions = Pick<
  Parameters<typeof useAppSessionActions>[0],
  'sessions' | 'setTabs' | 'refreshSessions'
> & {
  setSessionCatalogReady: (ready: boolean) => void;
  closePaneTab: (key: string) => void;
};

export function useAppSessionActivity({
  sessions,
  setTabs,
  refreshSessions,
  setSessionCatalogReady,
  closePaneTab,
}: SessionActivityOptions) {
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
    if (!sessions.length) return;
    setTabs((current) => retitleSessionTabs(current, sessions));
  }, [sessions, setTabs]);
  // A session deleted elsewhere is torn down by the session actions, like a
  // local delete. A bot deleted in this window: its chat is archived, its tabs close.
  useEffect(() => {
    const onBotDeleted = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
      if (typeof sessionId === 'string' && sessionId) closeSessionTabsEverywhere([sessionId], setTabs, closePaneTab);
    };
    window.addEventListener(BOT_DELETED_EVENT, onBotDeleted);
    return () => window.removeEventListener(BOT_DELETED_EVENT, onBotDeleted);
  }, [setTabs, closePaneTab]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Child pane effects commit first, keeping visible reads ahead of this
    // lightweight catalog reconciliation in the worker queue.
    const read = (attempt: number): void => {
      void refreshSessions().then(
        () => {
          if (live) setSessionCatalogReady(true);
        },
        (error: unknown) => {
          if (!live) return;
          // A host that showed its first page and then failed to finish the list leaves the catalog incomplete: not ready, read again.
          if (isIncompleteCatalogError(error))
            timer = setTimeout(() => read(attempt + 1), Math.min(30_000, 1_000 * 2 ** attempt));
          else setSessionCatalogReady(true);
        }
      );
    };
    read(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [refreshSessions, setSessionCatalogReady]);
  return { runningAutomationNames };
}
