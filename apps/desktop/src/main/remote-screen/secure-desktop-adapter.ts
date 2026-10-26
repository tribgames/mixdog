/**
 * Adapts the real secure-desktop client (main/secure-desktop/, protocol v4) to
 * the `SecureDesktopClient` interface the screen source's switch uses
 * (secure-desktop-switch.ts), plus the v4 control-grant path
 * (`SecureDesktopAdapter`).
 *
 * - Not installed (`available` false): it reports not-installed and does
 *   nothing, exactly like `NO_SECURE_DESKTOP`, so a secure desktop stays
 *   blocked.
 * - Connected on demand: the first `setActive(true)` dials the helper's pipe
 *   (never awaited, so the input queue that calls it can't wait on it). Once
 *   the handshake completes, a wanted activation is sent. While activation is
 *   wanted, a lost or failed connection is dialled again after a backoff that
 *   starts at one second and doubles to thirty.
 * - `session()` / `desktop()` come from the client's `session()` object
 *   (`{protocol, version, session, desktop}`), kept current by
 *   `desktop-changed`; a connect, a desktop change and a disconnect all fire
 *   `onDesktopChanged`.
 * - Input: a host command becomes the protocol's `InputEvent` (same desktop
 *   pixels). A button command without a position uses the last position sent
 *   (the helper releases in place anyway). The cursor read-back has no helper
 *   counterpart and is refused. `sendInput` settles in bounded time (the
 *   client's own deadline).
 * - Ctrl+Alt+Del: the Delete press of a combo while this adapter has Ctrl and
 *   Alt down (the phone's `ctrl-alt-del` special key arrives as the presses
 *   Ctrl, Alt, Delete) becomes the helper's `sas` instead: a Delete injected
 *   with `SendInput` never reaches Winlogon as the secure attention sequence.
 *   The modifiers counted are only those the helper still holds: the record
 *   is cleared whenever the helper releases everything it holds —
 *   deactivation, a new video run, a desktop change, `grant_expired`,
 *   `desktop_unavailable`, a `sas`, and a disconnect — so a Ctrl+Alt from
 *   before any of those can never turn a later Delete into SAS.
 * - Control grants (protocol v4): the helper injects and presses SAS only
 *   under a grant the paired phone signed. `onGrantChallenge` hands each
 *   helper challenge to the caller (to relay to the phone), `sendGrant`
 *   relays the phone's answer, and `setVideoRun` declares the run the phone
 *   is shown (re-sent after every reconnect).
 * - `locked()` is the helper's WTS lock state (lock screen vs UAC on the one
 *   `Winlogon` desktop); `onHelperIssue` reports the helper's advisory codes
 *   (`input_failed`, `desktop_unavailable`, `grant_required`, `grant_expired`,
 *   `grant_key_missing`, `sas_disabled_by_policy`, …) for the status shown to
 *   the phone.
 * - `dispose()` (by the screen sources, once every session released): the
 *   reconnect is cancelled, the client's listeners are detached and its
 *   connection closed, including one still in its handshake; a connect that
 *   succeeds anyway is closed when it does. Nothing dials after it.
 */
import type {
  InputEvent,
  SecureDesktopClient as SecureDesktopService,
  SecureDesktopGrant,
  SecureDesktopGrantChallenge,
} from '../secure-desktop';
import type { ScreenBgraFrame } from './screen-geometry';
import type { ScreenHostCommand } from './screen-input-host';
import { NO_SECURE_DESKTOP, type SecureDesktopClient } from './secure-desktop-switch';

/** The part of the real client this adapter uses (tests supply a fake). */
type SecureDesktopServicePort = Pick<
  SecureDesktopService,
  | 'available'
  | 'session'
  | 'connect'
  | 'on'
  | 'setActive'
  | 'sendInput'
  | 'close'
  | 'setVideoRun'
  | 'sendGrant'
  | 'sas'
>;

/** The switch's client plus the protocol v4 grant, SAS and status surface. */
export interface SecureDesktopAdapter extends SecureDesktopClient {
  /** The helper's session lock state; null when unknown or not connected. */
  locked(): boolean | null;
  /** Each helper challenge, to be relayed to the paired phone for signing. */
  onGrantChallenge(listener: (challenge: SecureDesktopGrantChallenge) => void): () => void;
  /** Relay the phone's signed answer. Rejects when not connected. */
  sendGrant(grant: SecureDesktopGrant): Promise<void>;
  /** The video run (epoch) the phone is shown now. */
  setVideoRun(epoch: number): void;
  /** The helper's advisory `error` codes, as they arrive. */
  onHelperIssue(listener: (code: string) => void): () => void;
}

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const VK_CONTROL = [0x11, 0xa2, 0xa3];
const VK_MENU = [0x12, 0xa4, 0xa5];
const VK_DELETE = 0x2e;

/** Helper `error` codes sent after it released everything it held
 *  (helper.rs `settle_lapse`, the video-run change, `suspend_if_desktop_lost`
 *  and the re-attach path). */
const HELPER_RELEASED_CODES: ReadonlySet<string> = new Set(['grant_expired', 'desktop_unavailable']);

const NOT_INSTALLED: SecureDesktopAdapter = {
  ...NO_SECURE_DESKTOP,
  locked: () => null,
  onGrantChallenge: () => () => {},
  sendGrant: () => Promise.reject(new Error('secure desktop helper is not installed')),
  setVideoRun: () => {},
  onHelperIssue: () => () => {},
};

/** A host command as a helper input event; null when the helper has none. */
function secureDesktopInputEvent(
  command: ScreenHostCommand,
  lastPointer: { x: number; y: number }
): InputEvent | null {
  switch (command.op) {
    case 'move':
      return { kind: 'pointer-move', x: command.x, y: command.y };
    case 'button': {
      const at = command.at ?? lastPointer;
      return { kind: 'pointer-button', button: command.button, down: command.down, x: at.x, y: at.y };
    }
    case 'wheel':
      return { kind: 'pointer-wheel', x: command.x, y: command.y, dx: command.dx, dy: command.dy };
    case 'key':
      return { kind: 'key', down: command.down, vk: command.vk, scan: command.scan, extended: command.extended };
    case 'text':
      return { kind: 'text', text: command.text };
    case 'cursor':
      return null;
  }
}

export function createSecureDesktopAdapter(
  service: SecureDesktopServicePort,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout }
): SecureDesktopAdapter {
  if (!service.available) return NOT_INSTALLED;
  const changeListeners = new Set<() => void>();
  const frameListeners = new Set<(frame: ScreenBgraFrame) => void>();
  const challengeListeners = new Set<(challenge: SecureDesktopGrantChallenge) => void>();
  const issueListeners = new Set<(code: string) => void>();
  let disposed = false;
  let wantActive = false;
  let dialing = false;
  let retryMs = RECONNECT_FIRST_MS;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let latest: ScreenBgraFrame | null = null;
  let lastPointer = { x: 0, y: 0 };
  let videoRun: number | null = null;
  /** Keys this adapter has pressed through the helper and the helper still
   *  holds, by virtual key. Cleared whenever the helper releases everything. */
  const heldKeys = new Set<number>();

  const changed = (): void => {
    for (const listener of [...changeListeners]) listener();
  };

  const scheduleRetry = (): void => {
    if (!wantActive || retry || dialing || service.session()) return;
    retry = timers.setTimeout(() => {
      retry = null;
      dial();
    }, retryMs);
    (retry as { unref?: () => void }).unref?.();
    retryMs = Math.min(RECONNECT_MAX_MS, retryMs * 2);
  };

  const dial = (): void => {
    if (dialing || service.session()) return;
    dialing = true;
    service.connect().then(
      () => {
        dialing = false;
        // Disposed while it was being made: the late connection is closed.
        if (disposed) {
          service.close();
          return;
        }
        retryMs = RECONNECT_FIRST_MS;
        if (videoRun !== null) service.setVideoRun(videoRun);
        if (wantActive) service.setActive(true);
        changed();
      },
      () => {
        dialing = false;
        scheduleRetry();
      }
    );
  };

  const detach = [
    service.on('desktop-changed', () => {
      // A desktop switch releases everything the helper held.
      heldKeys.clear();
      changed();
    }),
    service.on('close', () => {
      latest = null;
      heldKeys.clear();
      changed();
      scheduleRetry();
    }),
    service.on('grant-challenge', (challenge) => {
      for (const listener of [...challengeListeners]) listener(challenge);
    }),
    service.on('error', (code) => {
      if (HELPER_RELEASED_CODES.has(code)) heldKeys.clear();
      for (const listener of [...issueListeners]) listener(code);
    }),
    service.on('frame', (header, pixels) => {
      const frame: ScreenBgraFrame = {
        width: header.width,
        height: header.height,
        stride: header.stride,
        originX: header.originX,
        originY: header.originY,
        pixels,
      };
      latest = frame;
      for (const listener of [...frameListeners]) listener(frame);
    }),
  ];

  return {
    installed: () => true,
    connected: () => service.session() !== undefined,
    desktop: () => service.session()?.desktop ?? null,
    session: () => service.session()?.session ?? null,
    async setActive(active) {
      if (disposed) return;
      wantActive = active;
      if (!active) {
        // Deactivating releases everything the helper held.
        heldKeys.clear();
        if (retry) timers.clearTimeout(retry);
        retry = null;
        if (service.session()) service.setActive(false);
        return;
      }
      if (service.session()) service.setActive(true);
      else dial();
    },
    sendInput(command) {
      const event = secureDesktopInputEvent(command, lastPointer);
      if (!event) return Promise.reject(new Error('secure desktop helper has no such input'));
      if (event.kind === 'pointer-move' || event.kind === 'pointer-button' || event.kind === 'pointer-wheel') {
        lastPointer = { x: event.x, y: event.y };
      }
      if (event.kind === 'key') {
        if (
          event.down &&
          event.vk === VK_DELETE &&
          VK_CONTROL.some((vk) => heldKeys.has(vk)) &&
          VK_MENU.some((vk) => heldKeys.has(vk))
        ) {
          // The helper releases everything it holds before raising SAS.
          heldKeys.clear();
          return service.sas();
        }
        if (event.down) heldKeys.add(event.vk);
        else heldKeys.delete(event.vk);
      }
      return service.sendInput(event);
    },
    locked: () => service.session()?.locked ?? null,
    onGrantChallenge(listener) {
      challengeListeners.add(listener);
      return () => challengeListeners.delete(listener);
    },
    sendGrant: (grant) => service.sendGrant(grant),
    setVideoRun(epoch) {
      // A new run releases everything the helper held.
      if (epoch !== videoRun) heldKeys.clear();
      videoRun = epoch;
      if (!disposed && service.session()) service.setVideoRun(epoch);
    },
    onHelperIssue(listener) {
      issueListeners.add(listener);
      return () => issueListeners.delete(listener);
    },
    latestFrame: () => latest,
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onDesktopChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wantActive = false;
      if (retry) timers.clearTimeout(retry);
      retry = null;
      for (const off of detach) off();
      changeListeners.clear();
      frameListeners.clear();
      challengeListeners.clear();
      issueListeners.clear();
      latest = null;
      // Deactivates and ends a connection that is up or still in its
      // handshake (a connect that succeeds anyway is closed in `dial`).
      service.close();
    },
  };
}
