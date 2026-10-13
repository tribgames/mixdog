import type { SessionSnapshot } from '../shared/contract';
import type { ComposerIslandModelMismatch } from './ComposerIsland';
import type { Snapshot } from './desktop-types';
import { modelDisplayName } from './provider-display';

/** The chat keeps the route it runs on while the composer may already hold
 *  another pick: offer reverting the pick or continuing the chat in it. */
export function conversationModelMismatch({
  draftMode,
  routeSnapshot,
  routeSessionIdRef,
  invokeResult,
  applySnapshot,
  onInherit,
}: {
  draftMode: boolean;
  routeSnapshot: Snapshot;
  routeSessionIdRef: { current: string };
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onInherit: () => Promise<boolean>;
}): ComposerIslandModelMismatch | null {
  const sessionProvider = String(routeSnapshot.sessionProvider || '');
  const sessionModel = String(routeSnapshot.sessionModel || '');
  const selectedProvider = String(routeSnapshot.provider || '');
  const selectedModel = String(routeSnapshot.model || '');
  if (draftMode || !sessionProvider || !sessionModel || !selectedModel) return null;
  if (sessionProvider === selectedProvider && sessionModel === selectedModel) return null;
  return {
    sessionModel: modelDisplayName(sessionModel, sessionProvider),
    selectedModel: modelDisplayName(selectedModel, selectedProvider),
    onRevert: () => {
      const sessionId = routeSessionIdRef.current;
      if (!sessionId) return;
      void invokeResult(async () => {
        const next = await window.mixdogDesktop.setModelRoute(
          { provider: sessionProvider, model: sessionModel },
          sessionId
        );
        applySnapshot(next);
        return next;
      });
    },
    onContinue: () => {
      void invokeResult(() => onInherit());
    },
  };
}
