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
 * desktop is up. If it is not, the phone is told an elevation prompt is on the
 * PC rather than shown a frozen frame.
 *
 * This module imports no helper implementation: `secure-desktop-service` owns
 * the real client in apps/desktop/src/main. The `SecureDesktopClient` interface
 * is the contract this switch needs from it; tests drive a mock of it.
 */
import type { RemoteScreenHelperState, RemoteScreenStatus } from '../../shared/remote-webrtc';
import type { ScreenBgraFrame } from './screen-geometry';
import type { ScreenHostCommand } from './screen-input-host';
import type { ScreenLocalDesktop } from './screen-input-host';
import type { ScreenDesktopIdentity } from './screen-input-router';

/** The input desktop's real object name, as the helper reports it (protocol
 *  v3 `DesktopName`): `Default`, or `Winlogon` for the lock screen, sign-in
 *  and UAC alike. Compared case-insensitively. */
export type SecureDesktopKind = string;

/** Desktop names compare case-insensitively (Windows object names do). */
export const normalizeDesktopName = (name: string): string => name.toLowerCase();

/**
 * The secure-desktop helper client, as this switch uses it. The real client
 * (owned by `secure-desktop-service`) is a no-op shell when the service is not
 * installed: `installed()` is false and nothing else is called.
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
  onDesktopChanged(listener: (desktop: SecureDesktopKind) => void): () => void;
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
};

export type ScreenSourceMode =
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

export interface ScreenSwitchInputs {
  /** The local input watcher's last report (null before the first). */
  local: ScreenLocalDesktop | null;
  helperInstalled: boolean;
  helperConnected: boolean;
  helperDesktop: SecureDesktopKind | null;
}

const helperState = (inputs: ScreenSwitchInputs): RemoteScreenHelperState => {
  if (!inputs.helperInstalled) return 'missing';
  if (inputs.helperConnected) return 'active';
  return 'starting';
};

/**
 * The secure desktop is up when the local watcher cannot open the input
 * desktop (`inputDesktop === null`) or names `winlogon`. A `consent.exe` in the
 * session with the input desktop still readable is an elevation prompt that
 * elevated in place on the ordinary desktop: the view is live, but the prompt
 * does not take remote input without the helper.
 */
export function decideScreenSource(inputs: ScreenSwitchInputs): ScreenSourceDecision {
  const helper = helperState(inputs);
  const local = inputs.local;
  const onSecure =
    local !== null && (local.inputDesktop === null || normalizeDesktopName(local.inputDesktop) === 'winlogon');
  const locked = local !== null && local.logonUi && !onSecure;

  if (onSecure) {
    const reason: RemoteScreenStatus['reason'] = local?.logonUi ? 'lock' : local?.consent ? 'uac' : 'secure';
    if (inputs.helperInstalled && inputs.helperConnected && inputs.helperDesktop !== null &&
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
    if (inputs.helperInstalled && inputs.helperConnected) {
      // The helper can act even for an in-place prompt; keep it warm so a jump
      // to the secure desktop has frames already flowing.
      return { mode: 'default', helper, helperActive: true, status: 'elevation-prompt', reason: locked ? 'lock' : 'uac' };
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

/** The status pushed to the phone for a decision, with whether this viewer
 *  may currently control. Control is refused on `blocked` (nothing can act)
 *  and on `elevation-prompt` without a helper. */
export function screenStatusFor(decision: ScreenSourceDecision, controlGranted: boolean): RemoteScreenStatus {
  const control =
    controlGranted &&
    decision.mode !== 'blocked' &&
    !(decision.mode === 'elevation-prompt' && decision.helper !== 'active');
  return {
    state: decision.status,
    ...(decision.reason ? { reason: decision.reason } : {}),
    helper: decision.helper,
    control,
  };
}

/** Whether a decision takes frames and input from the helper rather than the
 *  renderer capture and Windows input host. */
export function decisionUsesHelper(decision: ScreenSourceDecision): boolean {
  return decision.mode === 'helper';
}
