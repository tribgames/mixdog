/**
 * The on-PC pill shown while a paired phone views or controls the whole
 * screen. Electron-free: windows, displays and the Computer Use pill's
 * presence are injected, so the stacking and stop rules run under test.
 *
 * One pill serves every active phone; its tooltip lists them, and Stop ends
 * every remote session (never Computer Use work, which has its own pill).
 * It sits on the display of the earliest still-active session, falling back
 * to the primary display when that display is unknown or gone.
 */
import {
  nextRemoteSlot,
  boundsKey,
  remoteOverlayBounds,
  type Rect,
  type RemotePillSlot,
} from '../computer/overlay/overlay-layout';

interface IndicatorDisplay {
  id: number;
  workArea: Rect;
}

export interface IndicatorWindow {
  setBounds(bounds: Rect): void;
  /** The phone names for the pill's tooltip, one per line. */
  setTooltip(tooltip: string): void;
  destroy(): void;
}

export interface IndicatorWindowHandlers {
  /** The pill's Stop was pressed; settles once every session has been told. */
  stop(): Promise<void>;
  /** The window died (renderer gone); the host may recreate it. */
  gone(): void;
}

interface IndicatorDeps {
  displays(): IndicatorDisplay[];
  primaryDisplayId(): number;
  createWindow(bounds: Rect, handlers: IndicatorWindowHandlers): IndicatorWindow;
  computerPillShown(): boolean;
  onComputerPillChange(listener: () => void): () => void;
  onDisplaysChange(listener: () => void): () => void;
  /** Delay before a dead window is recreated. */
  retryMs?: number;
}

export interface RemoteScreenIndicatorOptions {
  /** The phone's name; shown only as the tooltip. */
  deviceLabel: string;
  /** Ends this remote session. Never touches Computer Use. */
  onStop(): void | Promise<void>;
  /** Electron display id being viewed; the primary display when absent or unknown. */
  displayId?: number;
}

export interface RemoteScreenIndicatorHandle {
  update(deviceLabel: string): void;
  close(): void;
}

interface Session {
  label: string;
  displayId?: number;
  onStop(): void | Promise<void>;
}

export function createRemoteScreenIndicatorHost(deps: IndicatorDeps) {
  const sessions = new Set<Session>();
  let window: IndicatorWindow | null = null;
  let slot: RemotePillSlot = 'top';
  let appliedBounds = '';
  let retryTimer: NodeJS.Timeout | null = null;
  let unsubscribers: Array<() => void> = [];

  const targetDisplay = (): IndicatorDisplay | undefined => {
    const displays = deps.displays();
    const wanted = [...sessions][0]?.displayId;
    return displays.find((display) => display.id === wanted) ?? displays.find((display) => display.id === deps.primaryDisplayId()) ?? displays[0];
  };

  const tooltip = (): string =>
    [...sessions]
      .map((session) => session.label.trim())
      .filter(Boolean)
      .join('\n');

  const stopAll = async (): Promise<void> => {
    await Promise.all(
      [...sessions].map(async (session) => {
        try {
          await session.onStop();
        } catch (error) {
          console.warn('[remote-screen] indicator_stop_failed', String((error as Error)?.message || error));
        }
      })
    );
  };

  /** The slot only ever moves top → below (see nextRemoteSlot). */
  const place = (): Rect | null => {
    const display = targetDisplay();
    if (!display) return null;
    slot = nextRemoteSlot(slot, deps.computerPillShown());
    return remoteOverlayBounds(display, slot);
  };

  const layout = (): void => {
    if (!window) return;
    const bounds = place();
    if (!bounds || boundsKey(bounds) === appliedBounds) return;
    appliedBounds = boundsKey(bounds);
    window.setBounds(bounds);
  };

  const open = (): void => {
    if (window || sessions.size === 0) return;
    const bounds = place();
    if (!bounds) return;
    appliedBounds = boundsKey(bounds);
    const created = deps.createWindow(bounds, {
      stop: stopAll,
      gone: () => {
        if (window !== created) return;
        window = null;
        if (sessions.size === 0 || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          open();
        }, deps.retryMs ?? 5_000);
        retryTimer.unref?.();
      },
    });
    window = created;
    created.setTooltip(tooltip());
  };

  const subscribe = (): void => {
    if (unsubscribers.length) return;
    unsubscribers = [
      deps.onComputerPillChange(layout),
      deps.onDisplaysChange(() => {
        // A display coming back recovers a pill that had nowhere to open; a
        // pending retry already owns the reopen, so never double-create.
        if (!window && !retryTimer) open();
        layout();
      }),
    ];
  };

  const teardown = (): void => {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    window?.destroy();
    window = null;
    appliedBounds = '';
    // The next pill starts fresh and takes the top slot again if it is free.
    slot = 'top';
  };

  return {
    show(options: RemoteScreenIndicatorOptions): RemoteScreenIndicatorHandle {
      const session: Session = { label: options.deviceLabel, displayId: options.displayId, onStop: options.onStop };
      sessions.add(session);
      subscribe();
      open();
      layout();
      window?.setTooltip(tooltip());
      return {
        update(deviceLabel) {
          if (!sessions.has(session)) return;
          session.label = deviceLabel;
          window?.setTooltip(tooltip());
        },
        close() {
          if (!sessions.delete(session)) return;
          if (sessions.size === 0) teardown();
          else {
            layout();
            window?.setTooltip(tooltip());
          }
        },
      };
    },
  };
}

/** The page's only requests: a press report and Stop. Anything else is refused. */
export async function handleRemoteIndicatorControl(request: unknown, stop: () => Promise<void>) {
  const body = request as { action?: unknown; control?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid overlay request');
  if (body.action === 'press' && body.control === 'stop') return { accepted: true };
  if (body.action === 'stop') {
    await stop();
    return { accepted: true };
  }
  throw new Error('Invalid overlay request');
}
