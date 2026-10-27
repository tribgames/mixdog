// The whole-PC screen view's decisions, with no DOM or React: which displays
// to offer, what the pane shows for a connection and a `screen-status`, and
// the events that must lift every key and button this phone holds.
import type {
  RemoteScreenDisplaySummary,
  RemoteScreenInput,
  RemoteScreenStatus,
  RemoteWebrtcTransportState,
} from '../shared/remote-webrtc';

/** The displays a host listed, keeping only well-formed entries. */
export function readScreenDisplays(value: unknown): RemoteScreenDisplaySummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RemoteScreenDisplaySummary[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { screenId, label, primary, pixelWidth, pixelHeight, scaleFactor } = entry as Record<string, unknown>;
    if (typeof screenId !== 'string' || !screenId || typeof label !== 'string') return [];
    if (typeof pixelWidth !== 'number' || typeof pixelHeight !== 'number') return [];
    return [
      {
        screenId,
        label,
        primary: primary === true,
        pixelWidth,
        pixelHeight,
        scaleFactor: typeof scaleFactor === 'number' ? scaleFactor : 1,
      },
    ];
  });
}

export type ScreenEntry =
  | { kind: 'none' }
  /** One display: no picker, straight to the view. */
  | { kind: 'view'; display: RemoteScreenDisplaySummary }
  /** Two or more: the monitor picker comes first. */
  | { kind: 'pick'; displays: RemoteScreenDisplaySummary[] };

export function chooseScreenEntry(displays: readonly RemoteScreenDisplaySummary[]): ScreenEntry {
  if (displays.length === 0) return { kind: 'none' };
  if (displays.length === 1) return { kind: 'view', display: displays[0]! };
  return { kind: 'pick', displays: [...displays] };
}

export type ScreenBlockReason = 'uac' | 'lock' | 'secure';

export type ScreenView =
  /** `reconnecting`: the session was lost with the phone's connection (a
   *  network change) and comes back on its own. */
  | { kind: 'connecting'; reconnecting?: true }
  | { kind: 'failed' }
  | { kind: 'live'; control: boolean }
  /** The secure desktop (D2): the last frame dimmed, the reason beneath, no keyboard.
   *  `dim` is false for an elevation prompt, which the live view still shows. */
  | { kind: 'blocked'; reason: ScreenBlockReason; dim: boolean }
  /** The PC ended it (D3). */
  | { kind: 'stopped'; reason: 'display-removed' | 'other' };

const FAILED_TRANSPORT: ReadonlySet<RemoteWebrtcTransportState> = new Set(['cooldown', 'closed']);

/** The phone's relay link to a host that serves the screen: `up`; `down` while
 *  no host is connected and the relay connection is being made again (a
 *  network change); `none` when the connected host (or this page) has none. */
export type ScreenLink = 'up' | 'down' | 'none';

export function screenLink(hostServes: boolean, connection: string | null): ScreenLink {
  if (hostServes) return 'up';
  return connection === 'connecting' || connection === 'reconnecting' || connection === 'syncing' ? 'down' : 'none';
}

/** The PC ended the session because this phone's connection left it (the
 *  relay leg dropped, or the video connection was lost): not a decision of
 *  anyone's, so the next connection starts it again by itself. */
export function screenStopIsConnectionLoss(status: RemoteScreenStatus | null): boolean {
  return status?.state === 'stopped' && status.reason === 'viewer-left';
}

/** What the pane shows for the connection and the PC's latest `screen-status`.
 *  `resuming`: a new session was started by itself after a connection loss,
 *  and has no picture yet. */
export function screenView({
  link = 'up',
  transport,
  showsVideo,
  status,
  resuming = false,
}: {
  link?: ScreenLink;
  transport: RemoteWebrtcTransportState;
  showsVideo: boolean;
  status: RemoteScreenStatus | null;
  resuming?: boolean;
}): ScreenView {
  const lost = screenStopIsConnectionLoss(status);
  if (status?.state === 'stopped' && !lost) {
    return { kind: 'stopped', reason: status.reason === 'display-removed' ? 'display-removed' : 'other' };
  }
  if (link === 'down' || lost) return { kind: 'connecting', reconnecting: true };
  if (link === 'none') return { kind: 'failed' };
  if (!showsVideo && FAILED_TRANSPORT.has(transport)) return { kind: 'failed' };
  if (status?.state === 'secure-desktop' || status?.state === 'elevation-prompt') {
    const reason: ScreenBlockReason = status.reason === 'uac' || status.reason === 'lock' ? status.reason : 'secure';
    return { kind: 'blocked', reason, dim: status.state === 'secure-desktop' };
  }
  if (!showsVideo) return resuming ? { kind: 'connecting', reconnecting: true } : { kind: 'connecting' };
  return { kind: 'live', control: status ? status.control : true };
}

/** The docked keyboard bar. Its height is part of the layout in every state
 *  but D3, so the picture never moves as the connection comes and goes:
 *  `visible: false` (the secure desktop) hides it but keeps its room, and the
 *  field is typable only while the PC accepts control. */
export function screenKeyboardBar(view: ScreenView): { present: boolean; visible: boolean; enabled: boolean } {
  if (view.kind === 'stopped') return { present: false, visible: false, enabled: false };
  return {
    present: true,
    visible: view.kind !== 'blocked',
    enabled: view.kind === 'live' && view.control,
  };
}

/** The PC cursor last reported for trackpad mode, in video pixels. It is
 *  valid only for the geometry it was reported in and only while the ordinary
 *  desktop is shown, so a geometry change or a secure desktop / stopped status
 *  makes it unknown again (the adapter then follows its own cursor). */
export function createScreenCursorTracker(generation: () => number | null) {
  let last: { x: number; y: number; generation: number } | null = null;
  // Counts the moments every cursor held anywhere becomes meaningless.
  let resets = 0;
  return {
    /** Changes whenever a cursor kept outside (the touch layer's own) goes
     *  stale: a new geometry, a new session, a secure desktop or a stop. */
    stamp(): string {
      return `${resets}:${generation() ?? ''}`;
    },
    set(cursor: { x: number; y: number }): void {
      const current = generation();
      last = current === null ? null : { x: cursor.x, y: cursor.y, generation: current };
    },
    status(status: RemoteScreenStatus): void {
      if (status.state === 'secure-desktop' || status.state === 'stopped') {
        last = null;
        resets += 1;
      }
    },
    clear(): void {
      last = null;
      resets += 1;
    },
    read(): { x: number; y: number } | null {
      return last && last.generation === generation() ? { x: last.x, y: last.y } : null;
    },
  };
}

/** Positive input (pointer moves and presses, wheel, key downs, text) is sent
 *  only while the view is live and the PC accepts control. Releasing is always
 *  allowed — key-ups, button-ups and `screen-release` — so control lost
 *  between a press and its release never leaves a key or button held. */
export function screenInputAllowed(input: RemoteScreenInput, view: ScreenView): boolean {
  if (input.type === 'screen-release') return true;
  if (input.type === 'screen-key' && input.action === 'up') return true;
  if (input.type === 'screen-pointer' && input.action === 'up') return true;
  return view.kind === 'live' && view.control;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Lifts everything this phone holds on the PC when it can no longer be sure a
 * touch or key will end: the page hides, leaves or loses focus, a touch is
 * cancelled, and when the pane is left (`dispose`). Returns `dispose`.
 */
export function installScreenReleaseTriggers(
  targets: {
    document: Listenable & { visibilityState: string };
    window: Listenable;
    stage: Listenable | null;
  },
  release: () => void
): () => void {
  const hidden = () => {
    if (targets.document.visibilityState === 'hidden') release();
  };
  targets.document.addEventListener('visibilitychange', hidden);
  targets.window.addEventListener('pagehide', release);
  targets.window.addEventListener('blur', release);
  targets.stage?.addEventListener('touchcancel', release);
  return () => {
    targets.document.removeEventListener('visibilitychange', hidden);
    targets.window.removeEventListener('pagehide', release);
    targets.window.removeEventListener('blur', release);
    targets.stage?.removeEventListener('touchcancel', release);
    release();
  };
}
