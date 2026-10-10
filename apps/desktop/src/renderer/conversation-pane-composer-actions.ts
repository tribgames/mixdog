import { useRef } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import { t } from './i18n';
import type { Snapshot } from './desktop-types';
import { inheritSessionDirectly, sessionModelSelection } from './session-inheritance';
import type { ConversationComposerActions } from './conversation-support';

/** The latest pane-local composer actions behind a stable ref, including the
 *  in-place Inherit that targets this pane's own route. */
export function useConversationPaneComposerActions({
  actions,
  sessionAddress,
  routeSnapshot,
  onInheritSession,
}: {
  actions: Omit<ConversationComposerActions, 'onInherit'>;
  sessionAddress?: string;
  routeSnapshot: Snapshot;
  onInheritSession?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
}) {
  const latestComposerActions: ConversationComposerActions = {
    ...actions,
    onInherit: async () => {
      const sourceSessionId = String(sessionAddress || routeSnapshot.sessionId || '');
      const route = sessionModelSelection(routeSnapshot);
      if (!onInheritSession || !sourceSessionId || !route) {
        throw new Error(t('Inheritance is unavailable on this surface.'));
      }
      return inheritSessionDirectly(sourceSessionId, route, onInheritSession);
    },
  };
  const composerActions = useRef(latestComposerActions);
  composerActions.current = latestComposerActions;
  return composerActions;
}
