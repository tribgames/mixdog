/**
 * The permission gate for the whole-PC screen source. Whole-PC view and
 * control is the most sensitive capability the app has, so a request is
 * admitted only when every gate passes:
 *
 *   1. The master switch is on (explicitly chosen on the PC; off by default).
 *   2. The caller is an already-paired client over an established E2EE channel
 *      — the same trust the relay authenticated, never an unpaired or
 *      plaintext peer.
 *   3. The client has an explicit grant: `view` streams the screen, `control`
 *      additionally injects input. `view` never implies `control`.
 *
 * This is a pure decision over inputs the session layer supplies; it starts no
 * capture and sends no input.
 */
import type { ScreenGrant } from './screen-access-settings';

export type ScreenPermission = 'view' | 'control';

export type ScreenDenyReason =
  /** The whole-PC switch is off. */
  | 'disabled'
  /** Not an established, paired E2EE client. */
  | 'unauthorized'
  /** Paired, but this client has no grant (or only `view` for a control ask). */
  | 'not-granted';

export type ScreenPermissionDecision =
  | { allowed: true; permission: ScreenPermission }
  | { allowed: false; reason: ScreenDenyReason };

export interface ScreenPermissionInputs {
  enabled: boolean;
  /** The caller holds an established E2EE channel as a paired client. */
  pairedE2EE: boolean;
  grant: ScreenGrant;
}

/** Whether `want` is admitted. A `view` ask is met by `view` or `control`; a
 *  `control` ask needs `control`. */
export function decideScreenPermission(
  want: ScreenPermission,
  inputs: ScreenPermissionInputs
): ScreenPermissionDecision {
  if (!inputs.enabled) return { allowed: false, reason: 'disabled' };
  if (!inputs.pairedE2EE) return { allowed: false, reason: 'unauthorized' };
  if (inputs.grant === 'control') return { allowed: true, permission: want };
  if (inputs.grant === 'view' && want === 'view') return { allowed: true, permission: 'view' };
  return { allowed: false, reason: 'not-granted' };
}

/** The highest permission a client may hold right now, or null if none. Used to
 *  downgrade a live session when a grant is lowered mid-stream. */
export function effectiveScreenPermission(inputs: ScreenPermissionInputs): ScreenPermission | null {
  if (!inputs.enabled || !inputs.pairedE2EE) return null;
  if (inputs.grant === 'control') return 'control';
  if (inputs.grant === 'view') return 'view';
  return null;
}

/** Control input admitted only with a live `control` permission. */
export function screenInputAllowed(permission: ScreenPermission | null): boolean {
  return permission === 'control';
}
