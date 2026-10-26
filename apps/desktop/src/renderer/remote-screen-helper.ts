// The secure-desktop helper from the phone's side (UAC, lock and Winlogon
// screens): what the PC's `screen-status` helper block means for the blocked
// view, the install / update request, and the short-lived control grants the
// phone signs for the helper's challenges. Pure and dependency-injected: the
// key store, the viewer's channel and the pane's visibility are passed in, so
// each rule is tested on plain objects.
import type {
  RemoteScreenHelperGrant,
  RemoteScreenHelperInfo,
  RemoteScreenHelperInstallOutcome,
  RemoteScreenHelperIssue,
  RemoteScreenHelperState,
  RemoteScreenStatus,
} from '../shared/remote-webrtc';
import { signSecureDesktopGrant, type SecureDesktopControllerKey } from '../shared/secure-desktop-grant';
import type { ScreenBlockReason, ScreenView } from './remote-screen-state';

/** The helper block of a `screen-status` (`helperInfo`): the shared reader has
 *  already checked every field, so unknown values never reach here. */
export type ScreenHelperBlock = RemoteScreenHelperInfo;
export type ScreenHelperOutcome = RemoteScreenHelperInstallOutcome;
export type ScreenHelperIssue = RemoteScreenHelperIssue;

/** The helper block of a status, or null before the first status. */
export function readScreenHelperBlock(status: Pick<RemoteScreenStatus, 'helperInfo'> | null): ScreenHelperBlock | null {
  return status?.helperInfo ?? null;
}

/** Which secure screen the blocked view describes: the helper's word for it
 *  when it has one, else the status reason. */
export function screenBlockReason(
  view: Extract<ScreenView, { kind: 'blocked' }>,
  block: ScreenHelperBlock | null
): ScreenBlockReason {
  return block?.secure ?? view.reason;
}

/** One line under the blocked view's note: fixed copy by id, or the PC's own
 *  detail text. */
export type ScreenHelperCopyId =
  | Exclude<ScreenHelperOutcome | ScreenHelperIssue, 'installed' | 'updated' | 'grant_expired'>
  | 'service-failed'
  | 'in-use';
export type ScreenHelperLine =
  | { kind: 'copy'; id: ScreenHelperCopyId }
  | { kind: 'detail'; text: string };

export interface ScreenHelperPanel {
  /** The button: ask for the helper to be installed, or approve its update. */
  action: 'install' | 'update' | null;
  /** The request is on its way and the PC has not answered: not pressable. */
  busy: boolean;
  lines: ScreenHelperLine[];
}

const EMPTY_PANEL: ScreenHelperPanel = { action: null, busy: false, lines: [] };

/**
 * What the blocked view adds for the helper, from the PC's status alone:
 * - the button follows the offer, except while the PC is waiting on an answer
 *   (in-progress), when another Windows account owns the helper, when it
 *   cannot be installed here, once it was installed or updated, and after a
 *   decline (the PC refuses to prompt again until its app restarts). A
 *   `failed` outcome leaves it in place for the person to press again;
 *   nothing ever presses it for them.
 * - the lines say how the last request ended, then what the helper reported.
 *   An expired grant is the helper asking again, which the phone answers by
 *   itself, so it says nothing.
 */
export function screenHelperPanel(
  block: ScreenHelperBlock | null,
  pending: boolean,
  service?: RemoteScreenHelperState
): ScreenHelperPanel {
  // An installed helper service that would not start: said, with no button
  // (the PC retries by itself the next time the helper is needed).
  // The helper is held by another viewer: said, with no button.
  if (service === 'in-use') return { action: null, busy: false, lines: [{ kind: 'copy', id: 'in-use' }] };
  if (service === 'failed') return { action: null, busy: false, lines: [{ kind: 'copy', id: 'service-failed' }] };
  if (!block) return EMPTY_PANEL;
  const lines: ScreenHelperLine[] = [];
  const offered = block.offer === 'none' ? null : block.offer;
  let action: ScreenHelperPanel['action'] = offered;
  switch (block.outcome) {
    case 'in-progress':
      lines.push({ kind: 'copy', id: 'in-progress' });
      action = null;
      break;
    case 'declined':
      // The PC latches a decline until its app restarts: asking again would
      // not prompt, so there is no button.
      lines.push({ kind: 'copy', id: 'declined' });
      action = null;
      break;
    case 'failed':
      lines.push(block.detail ? { kind: 'detail', text: block.detail } : { kind: 'copy', id: 'failed' });
      break;
    case 'other-user':
      lines.push({ kind: 'copy', id: 'other-user' });
      action = null;
      break;
    case 'unavailable':
      lines.push({ kind: 'copy', id: 'unavailable' });
      action = null;
      break;
    case 'installed':
    case 'updated':
      action = null;
      break;
    default:
      break;
  }
  if (block.issue && block.issue !== 'grant_expired') lines.push({ kind: 'copy', id: block.issue });
  return { action, busy: pending && action !== null, lines };
}

// --- install request --------------------------------------------------------

/** Phone → PC: enroll this phone's controller key and install (or update) the
 *  helper. Sent only when the person presses the button. */
export interface ScreenHelperInstallMessage {
  v: 1;
  kind: 'screen-helper-install';
  publicKey: string;
}

/** Phone → PC: the signed answer to one helper challenge. */
export interface ScreenHelperGrantMessage extends RemoteScreenHelperGrant {
  v: 1;
  kind: 'screen-helper-grant';
}

export type ScreenHelperClientMessage = ScreenHelperInstallMessage | ScreenHelperGrantMessage;

/** The button's request: the pairing's key (made now if this is the first
 *  use), then its public half to the PC. False when either step failed, so a
 *  key that could not be kept is never enrolled. */
export function createScreenHelperInstall(deps: {
  ensureKey(): Promise<Pick<SecureDesktopControllerKey, 'publicKey'>>;
  send(message: ScreenHelperInstallMessage): boolean;
}) {
  return async function requestInstall(): Promise<boolean> {
    let key: Pick<SecureDesktopControllerKey, 'publicKey'>;
    try {
      key = await deps.ensureKey();
    } catch {
      return false;
    }
    return deps.send({ v: 1, kind: 'screen-helper-install', publicKey: key.publicKey });
  };
}

// --- control grants ---------------------------------------------------------

/** PC → phone: one helper challenge for video run `epoch`. */
export interface ScreenHelperChallenge {
  epoch: number;
  nonce: string;
  challenge: string;
}

export type ScreenGrantResult = 'sent' | 'stale' | 'inactive' | 'no-key' | 'failed';

/** Whether this phone is showing the secure-desktop picture it would be
 *  granting control of: the screen pane is on screen (live or the blocked
 *  view) and the page is visible. A hidden page, a connecting or stopped view
 *  signs nothing. Control itself is not asked for: the grant is what gives it. */
export function screenGrantSurfaceActive(view: ScreenView, visibility: string): boolean {
  return visibility === 'visible' && (view.kind === 'live' || view.kind === 'blocked');
}

/**
 * Signs a helper challenge for the video run the phone is currently shown,
 * right away, and only while that run and the surface still hold when the
 * signature is done (a grant lapses within seconds on the PC, so a late one
 * for a run that has moved on is never sent). The key must already exist: a
 * phone with none cannot answer, and does not invent one.
 *
 * Each challenge captures a generation and the viewer (`origin`) it came from.
 * `invalidate()` bumps the generation on every surface or session transition
 * (hide, show, session end, viewer replacement, unmount), so a challenge that
 * began before one never signs or sends after it, even when the surface is
 * active again by then. The generation, the origin, the epoch and the surface
 * are rechecked right before signing (after the key loaded) and right before
 * sending; the grant goes out through the origin it came from, never through
 * whatever viewer is current.
 */
export function createScreenHelperGrants<Origin = undefined>(deps: {
  key(): Promise<Pick<SecureDesktopControllerKey, 'privateKey'> | null>;
  /** The newest video run the PC announced, or null. */
  epoch(): number | null;
  active(): boolean;
  /** The viewer now current; a challenge from any other one is dropped. */
  origin?(): Origin | null;
  send(message: ScreenHelperGrantMessage, origin: Origin): boolean;
  sign?: typeof signSecureDesktopGrant;
}) {
  const sign = deps.sign ?? signSecureDesktopGrant;
  let generation = 0;
  return {
    invalidate(): void {
      generation += 1;
    },
    /** Moves on with every `invalidate()`; lets another request share the gate. */
    generation: (): number => generation,
    async challenge(challenge: ScreenHelperChallenge, origin?: Origin): Promise<ScreenGrantResult> {
      const captured = generation;
      const verdict = (): ScreenGrantResult | null => {
        if (captured !== generation) return 'stale';
        if (deps.origin && deps.origin() !== (origin ?? null)) return 'stale';
        if (deps.epoch() !== challenge.epoch) return 'stale';
        return deps.active() ? null : 'inactive';
      };
      const early = verdict();
      if (early) return early;
      let key: Pick<SecureDesktopControllerKey, 'privateKey'> | null;
      try {
        key = await deps.key();
      } catch {
        return 'failed';
      }
      if (!key) return 'no-key';
      const beforeSign = verdict();
      if (beforeSign) return beforeSign;
      let signature: string;
      try {
        signature = await sign(key.privateKey, challenge, challenge.epoch);
      } catch {
        return 'failed';
      }
      const late = verdict();
      if (late) return late;
      return deps.send(
        {
          v: 1,
          kind: 'screen-helper-grant',
          epoch: challenge.epoch,
          challenge: challenge.challenge,
          signature,
        },
        origin as Origin
      )
        ? 'sent'
        : 'failed';
    },
  };
}

// --- the one automatic install request --------------------------------------

export type ScreenHelperAutoResult = 'sent' | 'skipped' | 'dropped' | 'failed';

/**
 * Asks for the helper once, by itself, the first time a PC screen session
 * offers an install: the same `screen-helper-install` the button sends, behind
 * the same gate as a grant (the pane is the active, visible surface; the
 * surface generation and the viewer are the ones the status came from, checked
 * again after each await). Only an `install` offer qualifies: an update
 * replaces another phone's key and stays button-only. The pairing's mark is
 * written only after the send went out, so a dropped or failed send leaves
 * the attempt available; after a sent one only the button can ask again.
 */
export function createScreenHelperAutoInstall<Origin = undefined>(deps: {
  /** The pairing's page-scope guard, shared by every coordinator of this page. */
  guard(): { running: boolean; done: boolean };
  /** Whether this pairing already made its automatic request. */
  requested(): Promise<boolean>;
  mark(): Promise<void>;
  ensureKey(): Promise<Pick<SecureDesktopControllerKey, 'publicKey'>>;
  active(): boolean;
  /** The surface generation (`createScreenHelperGrants().generation`). */
  generation(): number;
  origin?(): Origin | null;
  send(message: ScreenHelperInstallMessage, origin: Origin): boolean;
}) {
  return {
    async consider(info: Pick<RemoteScreenHelperInfo, 'offer'>, origin?: Origin): Promise<ScreenHelperAutoResult> {
      const guard = deps.guard();
      if (info.offer !== 'install' || guard.running || guard.done) return 'skipped';
      guard.running = true;
      try {
        const captured = deps.generation();
        const valid = () =>
          captured === deps.generation() && (!deps.origin || deps.origin() === (origin ?? null)) && deps.active();
        if (!valid()) return 'dropped';
        try {
          if (await deps.requested()) {
            guard.done = true;
            return 'skipped';
          }
          if (!valid()) return 'dropped';
          const key = await deps.ensureKey();
          if (!valid()) return 'dropped';
          if (!deps.send({ v: 1, kind: 'screen-helper-install', publicKey: key.publicKey }, origin as Origin)) {
            return 'failed';
          }
        } catch {
          return 'failed';
        }
        // The request is out: this page makes no second one even if the mark
        // cannot be kept.
        guard.done = true;
        await deps.mark().catch(() => {});
        return 'sent';
      } finally {
        guard.running = false;
      }
    },
  };
}
