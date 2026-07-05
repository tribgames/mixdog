/**
 * src/tui/hooks/useEngine.mjs — subscribe React to the engine store.
 *
 * The store (engine.mjs) lives outside React and emits immutable snapshots;
 * useSyncExternalStore re-renders the tree whenever a snapshot changes. This
 * keeps the agentLoop fully decoupled from React's lifecycle.
 */
import { useSyncExternalStore } from 'react';

/**
 * @param {object} store engine session from createEngineSession()
 * @returns the current engine state snapshot
 */
export function useEngine(store) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
