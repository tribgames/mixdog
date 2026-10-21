// Whether something sits over the conversation workspace so the user cannot
// actually read it: an open modal (settings, onboarding, dialogs — the shared
// dialog-modality owner already tracks those) or an expanded dock/browser/
// terminal sheet filling the main panel. Surfaces that live in their own React
// roots share this one module, so they report here instead of through props.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { hasOpenModal, subscribeModals } from './settings/dialog-modality';

const covers = new Set<string>();
const listeners = new Set<() => void>();
let coverSeq = 0;

export function workspaceCovered(): boolean {
  return covers.size > 0 || hasOpenModal();
}

export function subscribeWorkspaceCover(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeModals = subscribeModals(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeModals();
  };
}

/** Marks (or clears) one named cover; listeners hear only real changes. */
export function setWorkspaceCover(key: string, covering: boolean): void {
  if (covers.has(key) === covering) return;
  if (covering) covers.add(key);
  else covers.delete(key);
  for (const listener of listeners) listener();
}

/** Registers the calling surface as covering the workspace while `covering`. */
export function useWorkspaceCover(covering: boolean): void {
  // Not useId: separate React roots would each mint the same ids.
  const [key] = useState(() => `cover:${++coverSeq}`);
  useEffect(() => {
    setWorkspaceCover(key, covering);
    return () => setWorkspaceCover(key, false);
  }, [key, covering]);
}

export function useWorkspaceCovered(): boolean {
  return useSyncExternalStore(subscribeWorkspaceCover, workspaceCovered, () => false);
}
