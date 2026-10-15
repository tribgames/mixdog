// What the visualize panel accepts from a pane's page. The page script shares
// its world with the page's own scripts, so a message from the pane proves
// nothing about the user; these gates tie each pin, choice and crop to a real
// user gesture or a fresh, consistent answer.
//
// - Pins: a pick request is minted only by a trusted click on the panel's own
//   Comment layer (an `isTrusted` event in the panel document, which a
//   cross-origin page cannot dispatch). The page may answer that one request,
//   once, shortly after; anything else is dropped. The note is then typed into
//   the panel's own box, so the pin and its capture always follow the user.
// - Choices: main watches the window's real input and mints a one-time token
//   when a mouse release or Enter/Space lands inside a pane
//   (main/visualize/gestures.ts); a choice is taken only by spending one, so
//   one gesture in that pane carries at most one choice. Without a token (a
//   paired remote client, a desktop touch tap, a failed lookup) the choice
//   becomes a proposal: a confirm bar in the panel's own UI, and only a
//   trusted click or key press on its button queues it. Proposals replace one
//   another per pane, are rate-limited, and expire.
// - Crops: the secret-field masks are re-read from the page right before the
//   shot; no fresh answer, an overflow, or an element that moved means no crop.
//   After the shot the page is asked again, and the crop is kept only if the
//   element, its boxes and every mask are exactly as before.
// - Captures: one window capture at a time.

import { useSyncExternalStore } from 'react';

import {
  sameRect,
  type VisualizeFeedbackRect,
  type VisualizePageMeasure,
  type VisualizePagePick,
} from '../shared/visualize-feedback';
import type { VisualizeChoice } from './visualize-feedback-store';

export const VISUALIZE_PICK_TTL_MS = 2_000;
export const MAX_VISUALIZE_CAPTURES_IN_FLIGHT = 1;
/** How far (CSS px) the element may have moved since the pick and still be
 *  cropped where it was pinned. */
export const VISUALIZE_CROP_DRIFT_PX = 1;

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const visualizeRequestId = randomId;

/** One open pick request at a time; its answer is accepted once, in time. */
export function createVisualizePickGate(mint: () => string = randomId) {
  let open: { id: string; at: number } | null = null;
  return {
    /** Call only from a trusted click on the panel's Comment layer. */
    request(now: number): string {
      open = { id: mint(), at: now };
      return open.id;
    },
    accept(id: string, now: number): boolean {
      if (!open || open.id !== id || now - open.at > VISUALIZE_PICK_TTL_MS) return false;
      open = null;
      return true;
    },
    cancel(): void {
      open = null;
    },
  };
}

/** Desktop: spend one real gesture main saw in this pane. A client without
 *  main's input (paired remote) has none, so its choices are refused. */
export async function consumeVisualizeChoiceGesture(target: {
  sessionId: string;
  tabId: string;
  pane: number;
}): Promise<boolean> {
  const consume = globalThis.window?.mixdogDesktop?.visualizeConsumeGesture;
  if (!consume) return false;
  try {
    return (await consume(target)) === true;
  } catch {
    return false;
  }
}

const drifted = (a: VisualizeFeedbackRect, b: VisualizeFeedbackRect): boolean =>
  Math.abs(a.x - b.x) > VISUALIZE_CROP_DRIFT_PX ||
  Math.abs(a.y - b.y) > VISUALIZE_CROP_DRIFT_PX ||
  Math.abs(a.width - b.width) > VISUALIZE_CROP_DRIFT_PX ||
  Math.abs(a.height - b.height) > VISUALIZE_CROP_DRIFT_PX;

/** What a crop may use: only the fresh answer's element box and masks, and
 *  only when that answer exists, names the same element, reports every secret
 *  field, and the element still sits where it was pinned. Null: no crop. */
export function visualizeFreshCrop(
  pinned: Pick<VisualizePagePick, 'selector' | 'view'>,
  fresh: VisualizePagePick | null
): { view: VisualizeFeedbackRect; masks: VisualizeFeedbackRect[] } | null {
  if (!fresh || fresh.masksOverflow || fresh.selector !== pinned.selector) return null;
  if (drifted(pinned.view, fresh.view)) return null;
  return { view: fresh.view, masks: fresh.masks };
}

const sameMasks = (a: VisualizeFeedbackRect[], b: VisualizeFeedbackRect[]): boolean =>
  a.length === b.length && a.every((mask, index) => sameRect(mask, b[index]));

/** A crop is kept only when the page answers again after the shot with
 *  exactly the element, boxes and secret-field masks it gave right before
 *  it: anything that changed (or no answer) may have changed what was shot. */
export function visualizeSameDescription(before: VisualizePagePick, after: VisualizePagePick | null): boolean {
  if (!after || after.masksOverflow || before.masksOverflow || after.selector !== before.selector) return false;
  if (!sameRect(after.view, before.view) || !sameRect(after.box, before.box)) return false;
  return sameMasks(after.masks, before.masks);
}

/** The same rule for a dragged HTML area: the page must report the same
 *  contents and exactly the same secret-field masks before and after the shot. */
export function visualizeSameMeasure(before: VisualizePageMeasure, after: VisualizePageMeasure | null): boolean {
  if (!after || after.masksOverflow || before.masksOverflow || after.count !== before.count) return false;
  return sameMasks(after.masks, before.masks);
}

let capturesInFlight = 0;

/** Claim a capture slot; false while one is already running. */
export function beginVisualizeCapture(): boolean {
  if (capturesInFlight >= MAX_VISUALIZE_CAPTURES_IN_FLIGHT) return false;
  capturesInFlight += 1;
  return true;
}

export function endVisualizeCapture(): void {
  capturesInFlight = Math.max(0, capturesInFlight - 1);
}

// ── Choice proposals (no gesture token): one confirm bar per pane ────────

/** Fewest ms between two bar updates of one pane; faster proposals drop. */
export const VISUALIZE_PROPOSAL_MIN_INTERVAL_MS = 300;
/** A bar left alone dismisses itself after this long. */
export const VISUALIZE_PROPOSAL_TTL_MS = 10_000;

export interface VisualizeChoiceProposal {
  id: number;
  sessionId: string;
  choice: VisualizeChoice;
  /** Put the page's marks back to what is really queued. */
  reset(): void;
}

let proposals = new Map<string, VisualizeChoiceProposal>();
const proposedAt = new Map<string, number>();
const proposalListeners = new Set<() => void>();
let proposalSequence = 0;

function emitProposals(): void {
  for (const listener of proposalListeners) listener();
}

export function visualizeProposalKey(sessionId: string, tabId: string, pane: number): string {
  return `${sessionId}\0${tabId}\0${pane}`;
}

/** Show (or replace) a pane's confirm bar; false when rate-limited. */
export function proposeVisualizeChoice(
  key: string,
  proposal: Omit<VisualizeChoiceProposal, 'id'>,
  now: number
): boolean {
  if (now - (proposedAt.get(key) ?? Number.NEGATIVE_INFINITY) < VISUALIZE_PROPOSAL_MIN_INTERVAL_MS) return false;
  proposedAt.set(key, now);
  proposalSequence += 1;
  proposals = new Map(proposals).set(key, { ...proposal, id: proposalSequence });
  emitProposals();
  return true;
}

export function visualizeChoiceProposal(key: string): VisualizeChoiceProposal | null {
  return proposals.get(key) ?? null;
}

/** Remove the bar if it still shows proposal `id`; returns it (null when it
 *  was already replaced, confirmed, cancelled or expired). */
export function takeVisualizeChoiceProposal(key: string, id: number): VisualizeChoiceProposal | null {
  const proposal = proposals.get(key);
  if (!proposal || proposal.id !== id) return null;
  proposals = new Map(proposals);
  proposals.delete(key);
  emitProposals();
  return proposal;
}

function subscribeProposals(listener: () => void): () => void {
  proposalListeners.add(listener);
  return () => {
    proposalListeners.delete(listener);
  };
}

export function useVisualizeChoiceProposal(key: string): VisualizeChoiceProposal | null {
  return useSyncExternalStore(
    subscribeProposals,
    () => visualizeChoiceProposal(key),
    () => null
  );
}

/** Test seam. */
export function resetVisualizeChoiceProposals(): void {
  proposals = new Map();
  proposedAt.clear();
  emitProposals();
}
