/**
 * src/tui/hooks/useSession.mjs — subscribe React to the session store.
 *
 * The store (session-local.mjs) lives outside React and emits immutable snapshots;
 * useSyncExternalStore re-renders the tree whenever a snapshot changes. This
 * keeps the agentLoop fully decoupled from React's lifecycle.
 */
import { useSyncExternalStore } from 'react';

/**
 * @param {object} store returned by createSessionRuntime()
 * @returns the current session runtime state snapshot
 */
export function useSession(store) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
