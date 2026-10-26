/**
 * Adapts the real secure-desktop client (main/secure-desktop/, protocol v3) to
 * the `SecureDesktopClient` interface the screen source's switch uses
 * (secure-desktop-switch.ts).
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
 * - `dispose()` (by the screen sources, once every session released): the
 *   reconnect is cancelled, the client's listeners are detached and its
 *   connection closed, including one still in its handshake; a connect that
 *   succeeds anyway is closed when it does. Nothing dials after it.
 */
import type { InputEvent, SecureDesktopClient as SecureDesktopService } from '../secure-desktop';
import type { ScreenBgraFrame } from './screen-geometry';
import type { ScreenHostCommand } from './screen-input-host';
import { NO_SECURE_DESKTOP, type SecureDesktopClient } from './secure-desktop-switch';

/** The part of the real client this adapter uses (tests supply a fake). */
export type SecureDesktopServicePort = Pick<
  SecureDesktopService,
  'available' | 'session' | 'connect' | 'on' | 'setActive' | 'sendInput' | 'close'
>;

const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** A host command as a helper input event; null when the helper has none. */
export function secureDesktopInputEvent(
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
): SecureDesktopClient {
  if (!service.available) return NO_SECURE_DESKTOP;
  const changeListeners = new Set<() => void>();
  const frameListeners = new Set<(frame: ScreenBgraFrame) => void>();
  let disposed = false;
  let wantActive = false;
  let dialing = false;
  let retryMs = RECONNECT_FIRST_MS;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let latest: ScreenBgraFrame | null = null;
  let lastPointer = { x: 0, y: 0 };

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
    service.on('desktop-changed', changed),
    service.on('close', () => {
      latest = null;
      changed();
      scheduleRetry();
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
      return service.sendInput(event);
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
      latest = null;
      // Deactivates and ends a connection that is up or still in its
      // handshake (a connect that succeeds anyway is closed in `dial`).
      service.close();
    },
  };
}
