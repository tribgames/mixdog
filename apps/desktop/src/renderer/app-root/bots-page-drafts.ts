import type { NavigationSelection, WorkspaceTab } from '../navigation';

type StartTask = (draft?: NavigationSelection, requestComposerFocus?: boolean) => void;

interface DraftEntries {
  startTask: StartTask;
  navigateTab(tab: WorkspaceTab): void;
}

/** The desktop Bots page shows no new-task draft (AppWorkspaceMain hides its
 *  tab and composer there), so every way of showing one opens it in Sessions:
 *  a new task (the strip's +, Ctrl+N, a focused draft pane) and a draft tab
 *  picked from the strip or the tab switcher. Picked on Bots, a draft tab left
 *  the strip the moment it was selected (user: 탭 날라감). `leaveBotsPage` is
 *  a no-op wherever Bots is not showing. */
export function showDraftsInSessions(leaveBotsPage: () => void, entries: DraftEntries): DraftEntries {
  return {
    startTask: (draft, requestComposerFocus) => {
      leaveBotsPage();
      entries.startTask(draft, requestComposerFocus);
    },
    navigateTab: (tab) => {
      if (tab.selection.kind === 'new') leaveBotsPage();
      entries.navigateTab(tab);
    },
  };
}
