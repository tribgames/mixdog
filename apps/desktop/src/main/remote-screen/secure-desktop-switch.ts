/**
 * The capture/input source a screen session uses right now, and the status it
 * reports to the phone, as a pure function of three inputs: what the local
 * input watcher sees, whether the secure-desktop helper is installed and
 * attached, and which desktop that helper reports.
 *
 * The ordinary desktop streams through the renderer capture and the Windows
 * input host. When the input desktop becomes the secure desktop — a UAC prompt
 * that elevated onto it, Ctrl+Alt+Del, or the lock / sign-in screen — neither
 * can reach it: `desktopCapturer` returns the last frame and `SendInput` lands
 * nowhere. If the helper (a LocalSystem service + session helper) is installed
 * and attached, its frames and input take over for as long as the secure
 * desktop is up; control there waits until the helper's video actually reaches
 * the viewer, so the phone never acts on a desktop it can't see. If it is not,
 * the phone is told an elevation prompt is on the PC rather than shown a
 * frozen frame.
 *
 * This module imports no helper implementation: the real client lives in
 * apps/desktop/src/main/secure-desktop/, and secure-desktop-adapter.ts adapts
 * it to the `SecureDesktopClient` interface this switch needs; tests drive a
 * mock of it.
 */
import {
  REMOTE_SCREEN_HELPER_ISSUES,
  type RemoteScreenHelperInfo,
  type RemoteScreenHelperIssue,
  type RemoteScreenHelperState,
  type RemoteScreenStatus,
} from '../../shared/remote-webrtc';
import type { ScreenBgraFrame } from './screen-geometry';
import type { ScreenHostCommand, ScreenLocalDesktop } from './screen-input-host';
import type { ScreenDesktopIdentity } from './screen-input-router';

/** The input desktop's real object name, as the helper reports it (protocol
 *  v3 `DesktopName`): `Default`, or `Winlogon` for the lock screen, sign-in
 *  and UAC alike. Compared case-insensitively. */
type SecureDesktopKind = string;

/** Desktop names compare case-insensitively (Windows object names do). */
const normalizeDesktopName = (name: string): string => name.toLowerCase();

/**
 * The secure-desktop helper client, as this switch uses it. The real client
 * (main/secure-desktop/, through secure-desktop-adapter.ts) is a no-op shell
 * when the service is not installed: `installed()` is false and nothing else is
 * called.
 */
export interface SecureDesktopClient {
  /** The helper service is installed on this PC. */
  installed(): boolean;
  /** Connected to the running helper and past its handshake. */
  connected(): boolean;
  /** The desktop the helper currently captures and injects on. */
  desktop(): SecureDesktopKind | null;
  /** The Windows session the helper is attached to (`server-hello` /
   *  `desktop-changed` carry it); null while not connected. */
  session(): number | null;
  /** Begin or end the helper's capture + injection. */
  setActive(active: boolean): Promise<void>;
  /** A secure-desktop input action (pre-mapped desktop pixels). Settles or
   *  rejects in bounded time, and delivers a release whenever the helper is
   *  attached, even while capture is inactive. */
  sendInput(command: ScreenHostCommand): Promise<void>;
  /** The latest secure-desktop frame, or null before the first one. */
  latestFrame(): ScreenBgraFrame | null;
  onFrame(listener: (frame: ScreenBgraFrame) => void): () => void;
  /** The helper's connection or desktop changed (connected, the input
   *  desktop switched, disconnected): `connected()`, `desktop()` and
   *  `session()` read anew. */
  onDesktopChanged(listener: () => void): () => void;
  /** Releases the client for good: reconnects cancelled, the connection
   *  closed (also one still being made), every listener detached. Its owner
   *  (the screen sources) calls it once every session released. */
  dispose(): void;
}

/** Where a command through the helper lands now; null unless connected and
 *  both its session and desktop are known. */
export function secureDesktopIdentity(client: SecureDesktopClient): ScreenDesktopIdentity | null {
  if (!client.connected()) return null;
  const session = client.session();
  const desktop = client.desktop();
  // Lower-cased like the input host's name, so both backends' identities of
  // one desktop compare equal.
  return session === null || desktop === null ? null : { session, desktop: normalizeDesktopName(desktop) };
}

/** A client that reports not-installed; the real shell matches it when the
 *  service is absent. */
export const NO_SECURE_DESKTOP: SecureDesktopClient = {
  installed: () => false,
  connected: () => false,
  desktop: () => null,
  session: () => null,
  setActive: async () => {},
  sendInput: async () => {},
  latestFrame: () => null,
  onFrame: () => () => {},
  onDesktopChanged: () => () => {},
  dispose: () => {},
};

type ScreenSourceMode =
  /** Renderer capture + the Windows input host on the ordinary desktop. */
  | 'default'
  /** Ordinary capture still, but an elevation prompt owns input (no helper). */
  | 'elevation-prompt'
  /** The helper's frames and input on the secure desktop. */
  | 'helper'
  /** The secure desktop is up and no helper can serve it. */
  | 'blocked';

export interface ScreenSourceDecision {
  mode: ScreenSourceMode;
  helper: RemoteScreenHelperState;
  /** The helper should be capturing/injecting (mode `helper`, or warming for a
   *  prompt so a switch to the secure desktop is seamless). */
  helperActive: boolean;
  status: RemoteScreenStatus['state'];
  reason?: RemoteScreenStatus['reason'];
}

interface ScreenSwitchInputs {
  /** The local input watcher's last report (null before the first). */
  local: ScreenLocalDesktop | null;
  helperInstalled: boolean;
  helperConnected: boolean;
  helperDesktop: SecureDesktopKind | null;
  /** The helper's WTS session lock state (`locked()`); null when it reports
   *  none or isn't connected. */
  helperLocked: boolean | null;
  /** The installed service was found stopped and could not be started
   *  (`ensureRunning` answered not running); a connection supersedes it. */
  helperServiceDown?: boolean;
  /** Another session holds the helper (secure-desktop-helper.ts, "One
   *  holder"): this one can't use it until the hold passes. */
  helperOwnedElsewhere?: boolean;
}

const helperState = (inputs: ScreenSwitchInputs): RemoteScreenHelperState => {
  if (!inputs.helperInstalled) return 'missing';
  if (inputs.helperOwnedElsewhere) return 'in-use';
  if (inputs.helperConnected) return 'active';
  return inputs.helperServiceDown ? 'failed' : 'starting';
};

/**
 * The secure desktop is up when the local watcher cannot open the input
 * desktop (`inputDesktop === null`) or names `winlogon`. A `consent.exe` in the
 * session with the input desktop still readable is an elevation prompt that
 * elevated in place on the ordinary desktop: the view is live, but the prompt
 * does not take remote input without the helper.
 *
 * Lock screen vs UAC (both on the one `Winlogon` desktop): the helper's WTS
 * lock state decides whenever it reports one, before the local LogonUI check
 * (LogonUI also draws the Ctrl+Alt+Del screen of an unlocked session). Not
 * locked is UAC when a consent prompt runs, else an unnamed secure screen.
 */
export function decideScreenSource(inputs: ScreenSwitchInputs): ScreenSourceDecision {
  const helper = helperState(inputs);
  // Connected and this session's to use (not held by another session).
  const usable = inputs.helperConnected && !inputs.helperOwnedElsewhere;
  const local = inputs.local;
  const onSecure =
    local !== null && (local.inputDesktop === null || normalizeDesktopName(local.inputDesktop) === 'winlogon');
  const lockScreen = local !== null && (inputs.helperLocked ?? local.logonUi);
  const locked = lockScreen && !onSecure;

  if (onSecure) {
    const reason: RemoteScreenStatus['reason'] = lockScreen ? 'lock' : local?.consent ? 'uac' : 'secure';
    if (
      inputs.helperInstalled &&
      usable &&
      inputs.helperDesktop !== null &&
      normalizeDesktopName(inputs.helperDesktop) !== 'default'
    ) {
      return { mode: 'helper', helper, helperActive: true, status: 'secure-desktop', reason };
    }
    return {
      mode: 'blocked',
      helper,
      helperActive: inputs.helperInstalled,
      status: 'secure-desktop',
      reason,
    };
  }

  // Ordinary desktop. An in-place elevation prompt (or the lock UI while the
  // input desktop is still readable) is live but un-actionable without a helper.
  if (local?.consent || locked) {
    if (inputs.helperInstalled && usable) {
      // The helper can act even for an in-place prompt; keep it warm so a jump
      // to the secure desktop has frames already flowing.
      return {
        mode: 'default',
        helper,
        helperActive: true,
        status: 'elevation-prompt',
        reason: locked ? 'lock' : 'uac',
      };
    }
    return {
      mode: 'elevation-prompt',
      helper,
      helperActive: inputs.helperInstalled,
      status: 'elevation-prompt',
      reason: locked ? 'lock' : 'uac',
    };
  }

  return { mode: 'default', helper, helperActive: false, status: 'live' };
}

/** The status's helper block besides what the decision says (`secure`). */
export type ScreenHelperFacts = Omit<RemoteScreenHelperInfo, 'secure'>;

/** The status pushed to the phone for a decision, with whether this viewer
 *  may currently control. Control is refused on `blocked` (nothing can act),
 *  on `elevation-prompt` without a helper, and on `helper` until the helper's
 *  video reaches this viewer (`helperVideo`): without the picture the phone
 *  would act on a desktop it can't see. */
export function screenStatusFor(
  decision: ScreenSourceDecision,
  controlGranted: boolean,
  helperVideo: boolean,
  helper: ScreenHelperFacts
): RemoteScreenStatus {
  const control =
    controlGranted &&
    decision.mode !== 'blocked' &&
    !(decision.mode === 'elevation-prompt' && decision.helper !== 'active') &&
    (decision.mode !== 'helper' || helperVideo);
  return {
    state: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
    helper: decision.helper,
    control,
    helperInfo: {
      ...helper,
      secure: decision.reason === 'lock' || decision.reason === 'uac' ? decision.reason : null,
    },
  };
}

/** A helper advisory code the phone is told about; null for the others
 *  (handshake failures close the connection; a refused grant is followed by
 *  the next challenge). */
export function screenHelperIssue(code: string): RemoteScreenHelperIssue | null {
  return (REMOTE_SCREEN_HELPER_ISSUES as readonly string[]).includes(code) ? (code as RemoteScreenHelperIssue) : null;
}

/** The issue still standing after the helper's connection or desktop changed
 *  (connected, the input desktop switched, disconnected, or the adapter was
 *  rebuilt by an install): every report of the desktop it was about ends
 *  (`desktop_unavailable` ends at the next `desktop-changed`), while
 *  `grant_key_missing` describes the install and stands as long as the
 *  connection to it does. */
export function helperIssueAfterChange(
  issue: RemoteScreenHelperIssue | null,
  connected: boolean
): RemoteScreenHelperIssue | null {
  return issue === 'grant_key_missing' && connected ? issue : null;
}

/** Whether a decision takes frames and input from the helper rather than the
 *  renderer capture and Windows input host. */
export function decisionUsesHelper(decision: ScreenSourceDecision): boolean {
  return decision.mode === 'helper';
}
