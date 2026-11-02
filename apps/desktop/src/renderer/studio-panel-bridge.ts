import { useSyncExternalStore } from 'react';
import type { StudioMediaJob } from './studio-media-state';
import type { MediaAsset } from './studio-support';

// What the Studio rail panel and the Studio panes tell each other. A pane owns
// its runs and open work; the panel owns the work list and asks one pane to
// open a work, or drops it from all of them.
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
  /** The work the owner has open, '' when none. */
  openId: string;
  /** A work the panel asked one specific pane to open, until that pane takes it. */
  openRequest: { paneKey: string; asset: MediaAsset } | null;
}

let state: StudioPanelState = { ownerKey: '', jobs: [], openId: '', openRequest: null };
let shown: string[] = [];
const stateListeners = new Set<() => void>();
const removedListeners = new Set<(asset: MediaAsset) => void>();

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
  if (ownerKey !== state.ownerKey) update({ ownerKey, jobs: [], openId: '' });
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

/** The pane's tab is no longer shown (or the pane unmounted). A request still
 *  aimed at it is dropped. */
export function hideStudioPane(paneKey: string): void {
  shown = shown.filter((key) => key !== paneKey);
  if (state.openRequest?.paneKey === paneKey) update({ openRequest: null });
  settleOwner();
}

/** The owner's current runs and open work; any other pane's call is ignored. */
export function publishStudioPaneState(paneKey: string, jobs: readonly StudioMediaJob[], openId: string): void {
  if (paneKey === state.ownerKey) update({ jobs, openId });
}

export function useStudioPaneOwner(paneKey: string): boolean {
  return useSyncExternalStore(subscribe, () => state.ownerKey === paneKey);
}

export function useStudioPanelState(): Pick<StudioPanelState, 'jobs' | 'openId'> {
  return useSyncExternalStore(subscribe, () => state);
}

/** Aims `asset` at the pane `paneKey`: the Studio tab that was brought forward. */
export function requestStudioOpenAsset(paneKey: string, asset: MediaAsset): void {
  update({ openRequest: { paneKey, asset } });
}

/** The work waiting for pane `paneKey`, null when none or when it waits for another pane. */
export function useStudioOpenRequest(paneKey: string): MediaAsset | null {
  return useSyncExternalStore(subscribe, () =>
    state.openRequest?.paneKey === paneKey ? state.openRequest.asset : null
  );
}

/** Takes the work aimed at `paneKey`: only that pane gets it, once. */
export function takeStudioOpenRequest(paneKey: string): MediaAsset | null {
  if (state.openRequest?.paneKey !== paneKey) return null;
  const { asset } = state.openRequest;
  update({ openRequest: null });
  return asset;
}

/** The panel deleted a work: every Studio pane drops it from its gallery. */
export function announceStudioAssetRemoved(asset: MediaAsset): void {
  for (const listener of removedListeners) listener(asset);
}

export function onStudioAssetRemoved(listener: (asset: MediaAsset) => void): () => void {
  removedListeners.add(listener);
  return () => removedListeners.delete(listener);
}
