import { useState, useMemo } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { desktopUtilityDockTabEnabled } from './desktop-feature-config';
import { agentActivitySessionIds } from './desktop-types';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import { navigationKey } from './text-format';

interface AppSessionTitleProps {
  navigationSelection: NavigationSelection;
  sessions: DesktopSessionSummary[];
  tabs: WorkspaceTab[];
  renameSession: (id: string, title: string) => Promise<unknown> | void;
}

export function useAppSessionTitle({ navigationSelection, sessions, tabs, renameSession }: AppSessionTitleProps) {
  const [headerTitleEditingSessionId, setHeaderTitleEditingSessionId] = useState('');
  const [headerTitleDraft, setHeaderTitleDraft] = useState('');
  const [headerTitleInvalid, setHeaderTitleInvalid] = useState(false);

  const selectedSession =
    navigationSelection.kind === 'session'
      ? sessions.find((session) => session.id === navigationSelection.id)
      : undefined;

  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : '';

  const workingSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((session) => session.leadWorking === true || session.agentWorking === true)
          .map((session) => session.id)
      ),
    [sessions]
  );

  const observedAgentSessionIds = useMemo(
    () => (desktopUtilityDockTabEnabled('agents') ? agentActivitySessionIds(sessions) : []),
    [sessions]
  );

  const visibleSessionTitle =
    currentSessionTitle || tabs.find((tab) => tab.key === navigationKey(navigationSelection))?.title || 'New task';

  const openHeaderTitleEditor = () => {
    if (!selectedSession) return;
    setHeaderTitleDraft(visibleSessionTitle);
    setHeaderTitleInvalid(false);
    setHeaderTitleEditingSessionId(selectedSession.id);
  };

  const closeHeaderTitleEditor = () => {
    setHeaderTitleEditingSessionId('');
    setHeaderTitleDraft('');
    setHeaderTitleInvalid(false);
  };

  const commitHeaderTitleEditor = (fromBlur = false) => {
    if (!selectedSession) return closeHeaderTitleEditor();
    const title = headerTitleDraft.trim();
    if (!title) {
      setHeaderTitleInvalid(true);
      if (fromBlur) closeHeaderTitleEditor();
      return;
    }
    closeHeaderTitleEditor();
    if (title !== visibleSessionTitle) void renameSession(selectedSession.id, title);
  };

  return {
    headerTitleEditingSessionId,
    headerTitleDraft,
    setHeaderTitleDraft,
    headerTitleInvalid,
    selectedSession,
    currentSessionTitle,
    workingSessionIds,
    observedAgentSessionIds,
    visibleSessionTitle,
    openHeaderTitleEditor,
    closeHeaderTitleEditor,
    commitHeaderTitleEditor,
  };
}
