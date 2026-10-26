/**
 * The whole-PC `screen` source for one viewer (a paired phone × one display).
 * This is the "source interface" the WebRTC sender/main wiring drives: it
 * locks geometry, produces the capture plan the hidden sender renderer opens
 * its video track from, dispatches the viewer's screen input into the desktop,
 * switches to the secure-desktop helper (frames and input) when a UAC prompt
 * or the lock screen takes the input desktop, and on stop releases every held
 * key and button and tears capture down.
 *
 * It owns none of the peer connection, signaling or phone UI. Everything that
 * touches Electron (displays, the input host process, the helper client, the
 * on-PC indicator, the log) is injected, so the source is exercised without a
 * live desktop.
 */
import type {
  RemoteScreenCapturePlan,
  RemoteScreenDisplaySummary,
  RemoteScreenInput,
  RemoteScreenStatus,
  RemoteScreenStopReason,
  RemoteWebrtcGeometry,
} from '../../shared/remote-webrtc';
import {
  lockScreenGeometry,
  screenGeometryChanged,
  screenVideoSize,
  summarizeScreenDisplay,
  fitScreenFrame,
  type ScreenBgraFrame,
  type ScreenDisplay,
  type ScreenPointerMapping,
} from './screen-geometry';
import { screenInputCommands } from './screen-input-dispatch';
import { COMMAND_TIMEOUT_MS } from '../computer/backend/worker-requests';
import {
  ScreenHostError,
  screenHostIdentity,
  type ScreenInputHost,
  type ScreenLocalDesktop,
} from './screen-input-host';
import { ScreenInputRouter, type ScreenInputBackendId } from './screen-input-router';
import {
  decideScreenSource,
  decisionUsesHelper,
  screenStatusFor,
  secureDesktopIdentity,
  type ScreenSourceDecision,
  type SecureDesktopClient,
} from './secure-desktop-switch';

/**
 * The budget of app quit: Windows' hung-app timeout, how long Windows waits
 * for an application to end before it treats it as not responding
 * (`HKCU\Control Panel\Desktop\HungAppTimeout`, default 5000 ms:
 * https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-2000-server/cc978614(v=technet.10);
 * the Restart Manager uses the same value for forced shutdown:
 * https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ne-restartmanager-rm_shutdown_type).
 * Spending longer would make the app look hung at exit or shutdown.
 */
export const SCREEN_QUIT_BUDGET_MS = 5_000;

/** The displays the PC currently has, newest geometry each read. */
export interface ScreenDisplayProvider {
  list(): ScreenDisplay[];
  /** Fires when displays are added, removed or rescaled. */
  onChange(listener: () => void): () => void;
}

/** A single viewer's trust, read live, plus a change signal so a disconnect
 *  or unpair takes effect at once rather than at the next input. Pairing is
 *  the approval: a paired phone may view and control the whole screen. */
export interface ScreenViewerAuthorization {
  /** The viewer's connection is a paired, E2EE-established client and still
   *  connected. */
  paired(): boolean;
  /** Fires on anything that can end that: a disconnect, an unpair, or the
   *  connection being replaced. */
  onChange(listener: () => void): () => void;
}

/** The on-PC indicator shown while a phone views or controls, with its
 *  one-click stop. */
export interface ScreenIndicator {
  show(view: { clientLabel: string; controlling: boolean; onStop: () => void }): void;
  update(view: { controlling: boolean }): void;
  hide(): void;
}

export type ScreenSourceEvent =
  | { type: 'start'; clientId: string; screenId: string }
  | { type: 'stop'; clientId: string; screenId: string; reason: RemoteScreenStopReason }
  | { type: 'denied'; clientId: string; screenId: string; reason: string }
  | { type: 'secure-desktop'; clientId: string; screenId: string; state: RemoteScreenStatus['state'] }
  /** A release point could not release `count` held presses through
   *  `backend` (unreachable, another desktop, a failed send, or the stop
   *  deadline): they were dropped. */
  | { type: 'release-dropped'; clientId: string; screenId: string; backend: ScreenInputBackendId; count: number };

export interface ScreenSourceDeps {
  clientId: string;
  clientLabel: string;
  screenId: string;
  displays: ScreenDisplayProvider;
  authorization: ScreenViewerAuthorization;
  /** The Windows input host for the ordinary desktop (started with the session). */
  createInputHost(): ScreenInputHost;
  /** The secure-desktop helper client (a no-op shell when not installed). */
  secureDesktop: SecureDesktopClient;
  indicator: ScreenIndicator;
  /** Start/stop and transitions are logged; no input content is ever logged. */
  log(event: ScreenSourceEvent): void;
  maxFrameRate?: number;
  /**
   * Shutdown watchdog, started the moment `stop` is called. When it fires,
   * the input host is killed and every pending send is abandoned, so a backend
   * that stopped answering cannot hold the stop open; what was not released
   * is dropped and counted. Default: one command's acknowledgment deadline
   * (`COMMAND_TIMEOUT_MS`): a backend that answers completes the whole release
   * well within the time a single command may take.
   */
  shutdownDeadlineMs?: number;
}

type ScreenVideoFrame = { width: number; height: number; pixels: Uint8Array };
type ScreenGeometryRenewal = { plan: RemoteScreenCapturePlan; geometry: RemoteWebrtcGeometry };

export interface ScreenStartResult {
  plan: RemoteScreenCapturePlan;
  geometry: RemoteWebrtcGeometry;
  status: RemoteScreenStatus;
}

export type ScreenInputOutcome = 'applied' | 'rejected';

export interface ScreenStopOptions {
  /** Bound of this stop as a whole (watchdog plus closing the host), instead
   *  of `shutdownDeadlineMs`. App quit passes `SCREEN_QUIT_BUDGET_MS`
   *  (`stopScreenSourcesForQuit`). */
  deadlineMs?: number;
}

export interface RemoteScreenSource {
  /** The displays a phone may choose, before `start`. */
  listDisplays(): RemoteScreenDisplaySummary[];
  /** Admit the viewer and lock geometry. Rejects when the viewer is not a
   *  paired, connected client, when the input host can't start, or when the
   *  session was stopped or revoked while it started. Single use: a stopped
   *  source is not restarted. */
  start(): Promise<ScreenStartResult>;
  running(): boolean;
  geometry(): RemoteWebrtcGeometry | null;
  /** The capture plan the sender opens its track from; null unless running. */
  capturePlan(): RemoteScreenCapturePlan | null;
  status(): RemoteScreenStatus;
  /** Helper-path frames, fitted to the locked geometry, for the sender. The
   *  ordinary-desktop path produces its own MediaStream from the capture plan. */
  onFrame(listener: (frame: ScreenVideoFrame) => void): () => void;
  onStatus(listener: (status: RemoteScreenStatus) => void): () => void;
  /** A new locked geometry (display changed); the sender renews capture. */
  onGeometry(listener: (result: ScreenGeometryRenewal) => void): () => void;
  /** The session ended (any cause: indicator stop, revoke, display removed,
   *  host failure). The sender stops the capture track at once. */
  onStop(listener: (reason: RemoteScreenStopReason) => void): () => void;
  /** Dispatch one validated screen input; the outcome feeds the input-ack. */
  handleInput(input: RemoteScreenInput, geometryGeneration: number): Promise<ScreenInputOutcome>;
  /** Lift every key and button this viewer holds (demote, viewer-left,
   *  `screen-release`). Idempotent, and valid before, during and after stop. */
  releaseInput(): Promise<void>;
  /** Ends the session: stops capture, releases all input. Idempotent: a later
   *  call returns the first one's promise, and a shorter `deadlineMs` in it
   *  moves the running stop's absolute deadline earlier (never later). */
  stop(reason: RemoteScreenStopReason, options?: ScreenStopOptions): Promise<void>;
  /** Resolves once shutdown is done: releases delivered or dropped, and the
   *  input backends closed. Bounded by the stop's deadline
   *  (`shutdownDeadlineMs`, or the `deadlineMs` passed to `stop`). */
  released(): Promise<void>;
}

/**
 * App quit: stops every session at once, each bounded by
 * `SCREEN_QUIT_BUDGET_MS` from now (a session already stopping is shortened
 * to it), and resolves once all have released and closed, within the budget.
 * The contract has no `app-quit` stop reason yet; `user` stands in.
 */
export async function stopScreenSourcesForQuit(sources: Iterable<RemoteScreenSource>): Promise<void> {
  await Promise.all([...sources].map((source) => source.stop('user', { deadlineMs: SCREEN_QUIT_BUDGET_MS })));
}

export function createRemoteScreenSource(deps: ScreenSourceDeps): RemoteScreenSource {
  const frameListeners = new Set<(frame: ScreenVideoFrame) => void>();
  const statusListeners = new Set<(status: RemoteScreenStatus) => void>();
  const geometryListeners = new Set<(result: ScreenGeometryRenewal) => void>();
  const stopListeners = new Set<(reason: RemoteScreenStopReason) => void>();
  const subscriptions: Array<() => void> = [];
  const maxFrameRate = deps.maxFrameRate ?? 30;
  const shutdownDeadlineMs = deps.shutdownDeadlineMs ?? COMMAND_TIMEOUT_MS;
  const ids = { clientId: deps.clientId, screenId: deps.screenId };

  let started = false;
  let running = false;
  let stopping: Promise<void> | null = null;
  let stopReason: RemoteScreenStopReason | null = null;
  let generation = 0;
  let geometry: RemoteWebrtcGeometry | null = null;
  let plan: RemoteScreenCapturePlan | null = null;
  let mapping: ScreenPointerMapping | null = null;
  let host: ScreenInputHost | null = null;
  let local: ScreenLocalDesktop | null = null;
  let decision: ScreenSourceDecision | null = null;
  let helperActive = false;
  let status: RemoteScreenStatus = { state: 'live', helper: 'not-needed', control: false };

  // Every press is held by the backend that injected it; input, backend
  // switches and releases share one serialized, cancellable queue.
  // Each backend reports the desktop (session + desktop) a command would land
  // on now; presses are tagged with it and their releases go nowhere else.
  const router = new ScreenInputRouter(
    {
      desktop: {
        async send(command) {
          if (!host) throw new ScreenHostError('host_unavailable');
          await host.command(command);
        },
        identity: () => (host ? screenHostIdentity(host) : null),
      },
      secure: {
        send: (command) => deps.secureDesktop.sendInput(command),
        identity: () => secureDesktopIdentity(deps.secureDesktop),
      },
    },
    (backend, count) => deps.log({ type: 'release-dropped', ...ids, backend, count })
  );

  const findDisplay = (): ScreenDisplay | null =>
    deps.displays.list().find((entry) => entry.screenId === deps.screenId) ?? null;

  /** The viewer's connection is still a paired, connected E2EE client. */
  const paired = (): boolean => deps.authorization.paired();

  /** Input is accepted only while every gate holds at this instant. */
  const controlNow = (): boolean =>
    running && paired() && decision !== null && screenStatusFor(decision, true).control;

  const planFor = (display: ScreenDisplay): RemoteScreenCapturePlan => {
    const size = screenVideoSize(display.physical);
    return { sourceId: display.captureSourceId, width: size.width, height: size.height, maxFrameRate };
  };

  const lock = (display: ScreenDisplay): void => {
    generation += 1;
    const locked = lockScreenGeometry(display, generation);
    geometry = locked.geometry;
    mapping = locked.mapping;
    plan = planFor(display);
  };

  const helperState = () => ({
    local,
    helperInstalled: deps.secureDesktop.installed(),
    helperConnected: deps.secureDesktop.connected(),
    helperDesktop: deps.secureDesktop.desktop(),
  });

  const emitStatus = (next: RemoteScreenStatus): void => {
    if (
      next.state === status.state &&
      next.reason === status.reason &&
      next.helper === status.helper &&
      next.control === status.control
    ) {
      return;
    }
    status = next;
    if (next.state !== 'stopped') deps.indicator.update({ controlling: next.control });
    for (const listener of statusListeners) listener(next);
  };

  const publishStatus = (): void => {
    if (!running || !decision) return;
    emitStatus(screenStatusFor(decision, paired()));
  };

  const setHelperActive = async (active: boolean): Promise<void> => {
    if (helperActive === active) return;
    helperActive = active;
    await deps.secureDesktop.setActive(active).catch(() => {});
  };

  const backendFor = (next: ScreenSourceDecision): ScreenInputBackendId | null => {
    if (decisionUsesHelper(next)) return 'secure';
    return next.mode === 'blocked' ? null : 'desktop';
  };

  /**
   * Re-reads the desktop state. The gate and the status change at once; the
   * backend change runs as one turn of the input queue: the previous
   * backend's presses are released through it (dropped if it can't reach
   * their desktop), the helper activates when it takes over, and it is
   * deactivated after its own presses were released.
   */
  const refreshDecision = (): void => {
    if (!running) return;
    const next = decideScreenSource(helperState());
    const was = decision?.status;
    decision = next;
    if (next.status !== 'live' && next.status !== was) {
      deps.log({ type: 'secure-desktop', ...ids, state: next.status });
    }
    publishStatus();
    void router
      .switchTo(backendFor(next), {
        before: async () => {
          if (running && next.helperActive) await setHelperActive(true);
        },
        after: async () => {
          if (running && !next.helperActive) await setHelperActive(false);
        },
      })
      .catch(() => {});
  };

  /** The connection is no longer paired and connected (disconnect, unpair):
   *  the session stops. */
  const reauthorize = (): void => {
    if (running && !paired()) void stop('revoked');
  };

  const renewGeometry = (): void => {
    if (!running) return;
    const display = findDisplay();
    if (!display) {
      void stop('display-removed');
      return;
    }
    if (mapping && plan && !screenGeometryChanged(mapping, display) && plan.sourceId === display.captureSourceId) return;
    lock(display);
    if (geometry && plan) {
      for (const listener of geometryListeners) listener({ plan, geometry });
    }
  };

  const onHelperFrame = (frame: ScreenBgraFrame): void => {
    // Frames are gated by the live pairing, not only the admitted one.
    if (!running || !paired() || !decision || !decisionUsesHelper(decision) || !mapping) return;
    let fitted: ScreenVideoFrame;
    try {
      fitted = fitScreenFrame(frame, mapping);
    } catch {
      return;
    }
    for (const listener of frameListeners) listener(fitted);
  };

  const ensureHost = async (): Promise<void> => {
    if (!host) {
      const created = deps.createInputHost();
      host = created;
      subscriptions.push(
        created.onDesktop((desktop) => {
          local = desktop;
          refreshDecision();
        })
      );
      subscriptions.push(
        created.onExit(() => {
          if (running) void stop('error');
        })
      );
    }
    const current = host;
    await current.start();
    local = current.desktop();
  };

  async function start(): Promise<ScreenStartResult> {
    if (started) throw new ScreenSourceDenied('already-started');
    if (!paired()) {
      deps.log({ type: 'denied', ...ids, reason: 'unauthorized' });
      throw new ScreenSourceDenied('unauthorized');
    }
    const display = findDisplay();
    if (!display) throw new ScreenSourceDenied('display-removed');
    started = true;
    running = true;
    lock(display);

    subscriptions.push(deps.authorization.onChange(reauthorize));
    subscriptions.push(deps.displays.onChange(renewGeometry));
    subscriptions.push(deps.secureDesktop.onFrame(onHelperFrame));
    subscriptions.push(deps.secureDesktop.onDesktopChanged(() => refreshDecision()));

    // The input host is the injector and also the local UAC / lock detector:
    // a session cannot proceed without it.
    try {
      await ensureHost();
    } catch (error) {
      if (running) await stop('error');
      throw error;
    }
    // The host start awaited: the phone may have disconnected or been
    // unpaired, or the session stopped, meanwhile. Re-check before anything
    // becomes visible.
    reauthorize();
    if (!running) throw new ScreenSourceDenied(stopReason ?? 'stopped');

    decision = decideScreenSource(helperState());
    status = screenStatusFor(decision, true);
    deps.indicator.show({ clientLabel: deps.clientLabel, controlling: status.control, onStop: () => void stop('user') });
    deps.log({ type: 'start', ...ids });
    refreshDecision();
    await router.settled();
    if (!running) throw new ScreenSourceDenied(stopReason ?? 'stopped');
    return { plan: plan!, geometry: geometry!, status };
  }

  async function handleInput(input: RemoteScreenInput, geometryGeneration: number): Promise<ScreenInputOutcome> {
    // Release always runs, even after a revoke or stop, so nothing stays stuck.
    if (input.type === 'screen-release') {
      await router.releaseAll();
      return 'applied';
    }
    if (!controlNow()) return 'rejected';
    const commands = screenInputCommands(input, mapping, geometryGeneration);
    if (!commands) return 'rejected';
    const pointed = input.type === 'screen-wheel' || (input.type === 'screen-pointer' && input.action !== 'up');
    // Re-checked when the input's turn comes and between its commands.
    const allowed = pointed ? () => controlNow() && mapping?.generation === geometryGeneration : controlNow;
    return router.dispatch(commands, allowed);
  }

  /**
   * The absolute deadline of the running stop. A later `stop` with a shorter
   * `deadlineMs` moves it earlier and re-arms its timer; it is never moved
   * later. When it passes: during the release step the host is killed and the
   * router abandoned; while the host closes, its graceful stop is cut short.
   */
  let stopDeadline: { at: number; timer?: ReturnType<typeof setTimeout>; passed: boolean; waiters: Set<() => void> } | null =
    null;

  const armStopDeadline = (): void => {
    const deadline = stopDeadline;
    if (!deadline || deadline.passed) return;
    clearTimeout(deadline.timer);
    deadline.timer = setTimeout(
      () => {
        deadline.passed = true;
        // Release step still running (the host is still the session's):
        // a hung helper is killed, every pending send abandoned.
        if (host) {
          host.kill();
          router.abandon();
        }
        for (const wake of [...deadline.waiters]) wake();
        deadline.waiters.clear();
      },
      Math.max(0, deadline.at - Date.now())
    );
  };

  /** Resolves when the stop deadline passes (at once if it already has). */
  const stopDeadlinePassed = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!stopDeadline || stopDeadline.passed) resolve();
      else stopDeadline.waiters.add(resolve);
    });

  function stop(reason: RemoteScreenStopReason, options: ScreenStopOptions = {}): Promise<void> {
    if (stopping) {
      // Already stopping: a shorter deadline still applies, from now.
      if (options.deadlineMs !== undefined && stopDeadline && !stopDeadline.passed) {
        const at = Date.now() + options.deadlineMs;
        if (at < stopDeadline.at) {
          stopDeadline.at = at;
          armStopDeadline();
        }
      }
      return stopping;
    }
    if (!running) return Promise.resolve();
    stopDeadline = { at: Date.now() + (options.deadlineMs ?? shutdownDeadlineMs), passed: false, waiters: new Set() };
    // Synchronous part: nothing new is admitted, queued input is cancelled,
    // and capture ends now (the sender drops its track on the stop signal).
    running = false;
    stopReason = reason;
    router.cancel();
    subscriptions.splice(0).forEach((off) => off());
    emitStatus({ state: 'stopped', reason, helper: status.helper, control: false });
    for (const listener of stopListeners) listener(reason);
    deps.indicator.hide();
    deps.log({ type: 'stop', ...ids, reason });
    // The watchdog runs from this moment, whatever the queue is waiting on: a
    // hung helper is killed and every pending send is abandoned, which lets
    // the release step below finish at once (what it could not send is
    // dropped and counted).
    armStopDeadline();
    // The release is queued behind any in-flight command, so it undoes it.
    stopping = router.releaseAll().then(async () => {
      router.abandon();
      await closeBackends();
      if (stopDeadline) clearTimeout(stopDeadline.timer);
    });
    return stopping;
  }

  /** Closes the backends by the stop deadline: the host's graceful stop (its
   *  own release-on-quit) gets the time left, and is killed when the deadline
   *  passes first (including one shortened meanwhile). */
  async function closeBackends(): Promise<void> {
    helperActive = false;
    // Not awaited: the helper client is not ours to bound.
    void deps.secureDesktop.setActive(false).catch(() => {});
    const current = host;
    host = null;
    if (!current) return;
    const timedOut = await Promise.race([
      current.stop().then(
        () => false,
        () => false
      ),
      stopDeadlinePassed().then(() => true),
    ]);
    if (timedOut) current.kill();
  }

  return {
    listDisplays: () => deps.displays.list().map(summarizeScreenDisplay),
    start,
    running: () => running,
    geometry: () => geometry,
    capturePlan: () => (running ? plan : null),
    status: () => status,
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onGeometry(listener) {
      geometryListeners.add(listener);
      return () => geometryListeners.delete(listener);
    },
    onStop(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    handleInput,
    releaseInput: () => router.releaseAll(),
    stop,
    released: () => stopping ?? Promise.resolve(),
  };
}

export class ScreenSourceDenied extends Error {
  constructor(readonly reason: string) {
    super(`remote screen denied: ${reason}`);
  }
}

// Keep the geometry-change predicate reachable for the wiring layer's own
// display watcher (it decides when to call renew vs ignore a no-op change).
export { screenGeometryChanged };
