import { useSyncExternalStore } from 'react';
import type { StudioMediaJob } from './studio-media-state';

// What the Studio panes tell the Studio rail panel: the runs in flight, so a
// board row can show that something in it is generating. (The open board
// itself is shared through studio-boards.)
//
// Ownership: of the Studio panes showing their tab, the panel mirrors the one
// the user focused last (`shown`, owner last). Only the owner's state is kept;
// when the owner stops showing its tab or unmounts, the previous pane takes
// over (and republishes), or the state clears.
interface StudioPanelState {
  /** The owning pane's key, '' when no Studio pane is shown. */
  ownerKey: string;
  /** The owner's runs. */
  jobs: readonly StudioMediaJob[];
}

let state: StudioPanelState = { ownerKey: '', jobs: [] };
let shown: string[] = [];
const stateListeners = new Set<() => void>();

function update(patch: Partial<StudioPanelState>): void {
  state = { ...state, ...patch };
  for (const listener of stateListeners) listener();
}

function subscribe(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/** `shown` changed: a new owner starts from an empty state until it publishes. */
function settleOwner(): void {
  const ownerKey = shown.at(-1) ?? '';
  if (ownerKey !== state.ownerKey) update({ ownerKey, jobs: [] });
}

/** A Studio pane's tab is now shown. A focused pane becomes the owner; an
 *  unfocused one waits behind it. */
export function showStudioPane(paneKey: string, focused: boolean): void {
  if (shown.includes(paneKey)) {
    if (focused) focusStudioPane(paneKey);
    return;
  }
  shown = focused ? [...shown, paneKey] : [paneKey, ...shown];
  settleOwner();
}

/** The user focused this shown pane: it becomes the owner. */
export function focusStudioPane(paneKey: string): void {
  if (!shown.includes(paneKey)) return;
  shown = [...shown.filter((key) => key !== paneKey), paneKey];
  settleOwner();
}

/** The pane's tab is no longer shown (or the pane unmounted). */
export function hideStudioPane(paneKey: string): void {
  shown = shown.filter((key) => key !== paneKey);
  settleOwner();
}

/** The owner's current runs; any other pane's call is ignored. */
export function publishStudioPaneState(paneKey: string, jobs: readonly StudioMediaJob[]): void {
  if (paneKey === state.ownerKey) update({ jobs });
}

export function useStudioPaneOwner(paneKey: string): boolean {
  return useSyncExternalStore(subscribe, () => state.ownerKey === paneKey);
}

export function useStudioPanelState(): Pick<StudioPanelState, 'jobs'> {
  return useSyncExternalStore(subscribe, () => state);
}
