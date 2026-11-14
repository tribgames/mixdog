/**
 * The computer-use pill follows the core's `computer` section
 * (`{active, observeOnly, controller, sessionThreadId, sessions, ...}`): the presence mirror
 * (`computer/presence/mirror.ts`) turns each section value into the snapshot the overlay renders; this source is its
 * adapter for the host role, with the same `snapshot()`/`subscribe()` shape as the in-process coordinator.
 */
import {
  type ComputerPresence,
  type ComputerPresenceDeps,
  type ComputerSectionValue,
  createComputerPresence,
} from '../computer/presence/mirror';

export type { ComputerSectionValue } from '../computer/presence/mirror';

export interface ComputerPillSource extends ComputerPresence {
  /** A `computer/updated` section value (full snapshot, not a delta). */
  apply(section: ComputerSectionValue): void;
}

export function createComputerPillSource(
  now: () => number = Date.now,
  deps: Partial<Pick<ComputerPresenceDeps, 'legacy' | 'notifyPointerReleased'>> = {}
): ComputerPillSource {
  const presence = createComputerPresence({ notifyPointerReleased: () => {}, ...deps, now });
  return { ...presence, apply: presence.applySection };
}
