// The secure-desktop helper from the phone's side (UAC, lock and Winlogon
// screens): what the PC's `screen-status` helper block means for the blocked
// view, the install / update request, and the short-lived control grants the
// phone signs for the helper's challenges. Pure and dependency-injected: the
// key store, the viewer's channel and the pane's visibility are passed in, so
// each rule is tested on plain objects.
import {
  CREDUI_MAX_PASSWORD_LENGTH,
  CREDUI_MAX_USERNAME_LENGTH,
  type RemoteScreenHelperCredential,
  type RemoteScreenHelperGrant,
  type RemoteScreenHelperInfo,
  type RemoteScreenHelperInstallOutcome,
  type RemoteScreenHelperIssue,
  type RemoteScreenHelperState,
  type RemoteScreenStatus,
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

/** One line under the blocked view's note: fixed, translated copy by id. The
 *  PC's diagnostic `detail` (English, naming internals) is never shown: the
 *  PC logs it (secure-desktop.log). */
export type ScreenHelperCopyId =
  // Successes render no line (`installed`/`updated`/`enrolled`/`revoked`); an
  // expired grant is handled by re-signing, not a line.
  | Exclude<ScreenHelperOutcome | ScreenHelperIssue, 'installed' | 'updated' | 'enrolled' | 'revoked' | 'grant_expired'>
  | 'service-failed'
  | 'in-use';
export type ScreenHelperLine = { kind: 'copy'; id: ScreenHelperCopyId };

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
      lines.push({ kind: 'copy', id: 'failed' });
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
    case 'enrolled':
    case 'revoked':
      // A success: no line, and nothing left to press.
      action = null;
      break;
    case 'busy':
      // Another phone's password request was running and nothing ran for this
      // one: say so, and leave the action so it can ask again.
      lines.push({ kind: 'copy', id: 'busy' });
      break;
    case 'bad-credentials':
    case 'not-admin':
    case 'logon-type-denied':
    case 'account-locked':
    case 'account-disabled':
    case 'policy-blocked':
      // The remote (Windows-password) path was refused: say why, and leave the
      // action so the person can try again.
      lines.push({ kind: 'copy', id: block.outcome });
      break;
    default:
      break;
  }
  if (block.issue && block.issue !== 'grant_expired') lines.push({ kind: 'copy', id: block.issue });
  return { action, busy: pending && action !== null, lines };
}

// --- install request --------------------------------------------------------

/** Phone → PC: enroll this phone's controller key and install (or update) the
 *  helper. Sent only when the person submits the Windows-password sheet,
 *  which is what `credential` is (the PC then shows no prompt). */
export interface ScreenHelperInstallMessage {
  v: 1;
  kind: 'screen-helper-install';
  publicKey: string;
  credential?: RemoteScreenHelperCredential;
}

/** Phone → PC: the same for an installed helper that lacks this phone's key.
 *  The PC decides from its own state whether that is an install or an enroll,
 *  so either message gets the same handling. */
export interface ScreenHelperEnrollMessage {
  v: 1;
  kind: 'screen-helper-enroll';
  publicKey: string;
  credential?: RemoteScreenHelperCredential;
}

/** Phone → PC: the signed answer to one helper challenge. */
export interface ScreenHelperGrantMessage extends RemoteScreenHelperGrant {
  v: 1;
  kind: 'screen-helper-grant';
}

export type ScreenHelperClientMessage =
  | ScreenHelperInstallMessage
  | ScreenHelperEnrollMessage
  | ScreenHelperGrantMessage;

/** The sheet's request: the pairing's key (made now if this is the first
 *  use), then its public half to the PC with the typed Windows password (the
 *  password sheet always sends one; without it the PC asks on its own screen). An
 *  `update` offer goes as an enroll, an `install` offer as an install. False
 *  when either step failed, so a key that could not be kept is never enrolled. */
export function createScreenHelperInstall(deps: {
  ensureKey(): Promise<Pick<SecureDesktopControllerKey, 'publicKey'>>;
  send(message: ScreenHelperInstallMessage | ScreenHelperEnrollMessage): boolean;
}) {
  return async function requestInstall(
    action: NonNullable<ScreenHelperPanel['action']> = 'install',
    credential?: RemoteScreenHelperCredential
  ): Promise<boolean> {
    let key: Pick<SecureDesktopControllerKey, 'publicKey'>;
    try {
      key = await deps.ensureKey();
    } catch {
      return false;
    }
    return deps.send({
      v: 1,
      kind: action === 'update' ? 'screen-helper-enroll' : 'screen-helper-install',
      publicKey: key.publicKey,
      ...(credential ? { credential } : {}),
    });
  };
}

// --- the Windows-password sheet ----------------------------------------------

/** What the sheet's fields hold. */
export interface ScreenHelperForm {
  password: string;
  user: string;
}

export const EMPTY_SCREEN_HELPER_FORM: ScreenHelperForm = { password: '', user: '' };

/** The sheet's account field appears when the PC says its signed-in account is
 *  not an administrator (it cannot use that account then), or once the PC's
 *  answer was `not-admin` (the recovery when it did not say). `revealed` keeps
 *  the field once shown, so a later answer (a wrong password) does not take it
 *  away. Otherwise, including a PC that does not say, the password only: the PC
 *  uses its own account. */
export function screenHelperAsksAccount(block: ScreenHelperBlock | null, revealed = false): boolean {
  return revealed || block?.accountIsAdmin === false || block?.outcome === 'not-admin';
}

/** A submit needs a password within Windows' bound, and the account name
 *  (within its bound) when the sheet asks for one. */
export function screenHelperFormReady(form: ScreenHelperForm, asksAccount: boolean): boolean {
  if (!form.password || form.password.length > CREDUI_MAX_PASSWORD_LENGTH) return false;
  if (!asksAccount) return true;
  const user = form.user.trim();
  return user.length > 0 && user.length <= CREDUI_MAX_USERNAME_LENGTH;
}

/**
 * Pressing 승인: the credential to send (null while the form is not ready: the
 * form stays as it is) and the form after it. The password field is always
 * emptied by a submit, whatever the answer will be: a wrong one is typed
 * again, a right one is not needed again, and none stays in the page. The
 * account name stays for the next try. Without the account field the
 * credential carries no name (the PC uses its own account).
 */
export function submitScreenHelperForm(
  form: ScreenHelperForm,
  asksAccount: boolean
): { credential: RemoteScreenHelperCredential | null; form: ScreenHelperForm } {
  if (!screenHelperFormReady(form, asksAccount)) return { credential: null, form };
  const credential: RemoteScreenHelperCredential = { password: form.password };
  if (asksAccount) credential.user = form.user.trim();
  return { credential, form: { ...form, password: '' } };
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
