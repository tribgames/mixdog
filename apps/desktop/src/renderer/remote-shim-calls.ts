// Calls over the socket: RPC framing, the view-sync gate, catalog reads and
// the push lanes this browser registers.
import { RELAY_PAYLOAD_TOO_LARGE_CODE } from '../shared/remote-payload-limit';
import type { createRemoteCatalog } from '../shared/remote-catalog';
import { REMOTE_CLIENT_CALL_WINDOW, REMOTE_CLIENT_PRIORITY_RESERVE } from '../shared/remote-frame-budget';
import { armRemoteCallDeadline } from './remote-call-deadline';
import { remoteConnectionInterruptedError } from './remote-connection-state';
import type { RemoteShimContext } from './remote-shim-state';

/** Calls that must reach a running turn now: they skip the view-sync gate. */
const UNGATED_CALLS = new Set(['abortSession', 'resolveToolApprovalForSession', 'answerApprovalNotification']);
/** The view sync and the ungated calls: they draw on the priority reserve. */
const PRIORITY_CALLS = new Set(['synchronizeViews', ...UNGATED_CALLS]);

/** A call on the wire this long with nothing at all arriving from the relay
 *  probes the leg. A socket that died silently still reads as open, so its
 *  calls would otherwise wait out their full deadline; the probe recycles it
 *  within the wake probe's pong window and the redial takes the normal,
 *  calm reconnect path (interrupted calls, the status dot). */
const SILENT_CALL_PROBE_MS = 5_000;

/** Desktop reads with no side effect; only these may share a queued request. */
const COALESCED_READS = new Set([
  'getSnapshot',
  'getUpdaterState',
  'listProjects',
  'readActivityRailPins',
  'readCapabilities',
  'readHostDisplayPreferences',
  'readSettings',
  'viewerDevice',
]);
const COALESCED_CAPABILITY_READS = new Set([
  'getBotOrder',
  'getOrchestrationMode',
  'getConfiguredOrchestrationMode',
  'getProviderSetup',
  'getVoiceStatus',
  'getWorktreeSettings',
  'listWorkflows',
  'skillsStatus',
]);

function coalescedReadKey(method: string, params: unknown[]): string {
  if (method === 'invokeCapability') {
    const capability = (params[0] as { capability?: unknown } | undefined)?.capability;
    if (typeof capability !== 'string' || !COALESCED_CAPABILITY_READS.has(capability)) return '';
  } else if (!COALESCED_READS.has(method)) return '';
  return `${method}\0${JSON.stringify(params)}`;
}

/** Reads the app makes as it mounts, started by the shim as soon as the relay
 *  answers: on a phone they used to leave only after the app's chunks had
 *  downloaded and evaluated, so the first screen waited a full relay round
 *  trip after mount for its snapshot, updater state and projects. Each answer
 *  goes to the app's first identical read, once; whatever the app has not
 *  asked for when the boot window closes is dropped, so no later read is
 *  ever served from boot. */
const bootReads = new Map<string, Promise<unknown>>();
const BOOT_READ_WINDOW_MS = 10_000;

function takeBootRead(key: string): Promise<unknown> | undefined {
  const read = bootReads.get(key);
  if (read) bootReads.delete(key);
  return read;
}

/** Boot reads of state the view sync owns: they still wait for it, so their
 *  answer can never be older than the baseline the sync installs. */
const SYNC_ORDERED_BOOT_READS = new Set(['getSnapshot', 'listProjects']);

export function prefetchBootReads(ctx: RemoteShimContext, reads: ReadonlyArray<readonly [string, unknown[]]>): void {
  for (const [method, params] of reads) {
    const key = coalescedReadKey(method, params);
    if (!key || bootReads.has(key)) continue;
    // Everything else leaves the moment the channel is up, beside the sync
    // instead of behind it: settings, display preferences, pins and the
    // updater state are what the shell paints first.
    const read = SYNC_ORDERED_BOOT_READS.has(method) ? ctx.call(method, params) : ctx.invoke(method, params);
    // A failed boot read is not handed out: the app's own read asks again.
    read.catch(() => {
      if (bootReads.get(key) === read) bootReads.delete(key);
    });
    bootReads.set(key, read);
  }
  setTimeout(() => bootReads.clear(), BOOT_READ_WINDOW_MS);
}

export const installRemoteCalls = (ctx: RemoteShimContext): void => {
  // Push lanes this browser actually reads. Terminal output, diagnostics and
  // folder events are produced by DESKTOP activity — a build, a save — and
  // used to reach every paired phone regardless of what it had open, so a
  // phone left connected received entire build logs it never displayed.
  // Registering the lanes stops them at the source. A reconnect replays this
  // exactly like the visible-session set.
  const publishLanes = (): void => {
    void call<boolean>('setRemoteLanes', [[...ctx.activeLanes]]).catch(() => {
      // A missed registration is repaired by the reconnect replay.
    });
  };
  const laneSubscription = <T>(lane: string, listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      ctx.activeLanes.add(lane);
      publishLanes();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        ctx.activeLanes.delete(lane);
        publishLanes();
      }
    };
  };

  const sendApplicationFrame = async (ws: WebSocket, payload: Record<string, unknown>): Promise<void> => {
    const { refuseOversize, noteSentFrame } = ctx.limits;
    if (ctx.e2eePairing) {
      if (!ctx.secureChannel || !ctx.connectionReady) throw new Error('Relay encryption is not ready.');
      const frame = ctx.relayBinaryFrames
        ? await ctx.secureChannel.encryptBinary(payload)
        : await ctx.secureChannel.encryptJson(payload);
      refuseOversize(frame, payload);
      noteSentFrame(frame, payload);
      ws.send(frame);
      return;
    }
    const directFrame = JSON.stringify(payload);
    refuseOversize(directFrame, payload);
    noteSentFrame(directFrame, payload);
    ws.send(directFrame);
  };

  // Transport credits: at most REMOTE_CLIENT_CALL_WINDOW calls outstanding on
  // the PC; the rest wait here, before their deadline is armed. The app's
  // reads are released together when a view sync lands, and on a busy PC that
  // burst outran the desktop's per-browser frame budget: the PC dropped the
  // connection ("remote client backlog exceeded"), the redial synced and
  // released the same burst, and the phone sat behind the reconnect overlay.
  // A credit belongs to the PC, not to the caller: a call that timed out here
  // is still queued or running there, so its credit returns only when the PC
  // answers that id or the connection it went out on retires. Ordinary calls
  // stop short of the priority reserve; priority waiters are served first and
  // in their own order, so the sync is never held behind reads or behind a
  // later abort.
  let creditsInUse = 0;
  const credits = new Map<number, WebSocket>();
  const ordinaryWaiters: Array<() => void> = [];
  const priorityWaiters: Array<() => void> = [];
  const creditLimit = (priority: boolean): number =>
    priority ? REMOTE_CLIENT_CALL_WINDOW : REMOTE_CLIENT_CALL_WINDOW - REMOTE_CLIENT_PRIORITY_RESERVE;
  const takeCredit = (priority: boolean): Promise<void> => {
    const waiters = priority ? priorityWaiters : ordinaryWaiters;
    if (waiters.length === 0 && creditsInUse < creditLimit(priority)) {
      creditsInUse += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  const freeCredits = (count: number): void => {
    creditsInUse -= count;
    while (priorityWaiters.length > 0 && creditsInUse < creditLimit(true)) {
      creditsInUse += 1;
      priorityWaiters.shift()?.();
    }
    while (ordinaryWaiters.length > 0 && creditsInUse < creditLimit(false)) {
      creditsInUse += 1;
      ordinaryWaiters.shift()?.();
    }
  };
  /** The PC answered this call (or named it in a refusal): its work is done. */
  const settleCallCredit = (id: number): void => {
    if (credits.delete(id)) freeCredits(1);
  };
  /** The PC leg behind `ws` is gone, and every call it still owed with it. */
  const retireCallCredits = (ws: WebSocket): void => {
    let retired = 0;
    for (const [id, socket] of credits) {
      if (socket !== ws) continue;
      credits.delete(id);
      retired += 1;
    }
    if (retired > 0) freeCredits(retired);
  };
  /** Test/diagnostic seam: credits taken, calls the PC still owes, and calls
   *  waiting for a credit. */
  const callCreditStats = () => ({
    inUse: creditsInUse,
    owed: credits.size,
    waiting: ordinaryWaiters.length + priorityWaiters.length,
  });

  const invoke = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    await takeCredit(PRIORITY_CALLS.has(method));
    let ws: WebSocket;
    try {
      ws = await ctx.connect();
    } catch (error) {
      freeCredits(1);
      throw error;
    }
    return await new Promise<T>((resolve, reject) => {
      const id = ctx.nextId++;
      credits.set(id, ws);
      // Bounded send phase: a frame that cannot leave this page in time (a
      // stalled handshake, a re-keying leg) fails the call and wakes the
      // liveness probe, so recovery never waits on a send that never ends.
      let cancelDeadline = armRemoteCallDeadline(ctx.pending, id, reject, ctx.wakeProbe);
      let silenceTimer = 0;
      const settle = (): void => {
        cancelDeadline();
        window.clearTimeout(silenceTimer);
      };
      ctx.pending.set(id, {
        resolve: (value: unknown) => {
          settle();
          (resolve as (value: unknown) => void)(value);
        },
        reject: (reason: Error) => {
          settle();
          reject(reason);
        },
      });
      // Once the frame is sent the network deadline restarts: on a busy
      // phone the ordered encryption queue alone used most of it, failing
      // reads the desktop then answered in milliseconds.
      void sendApplicationFrame(ws, { id, method, params }).then(
        () => {
          if (!ctx.pending.has(id)) return;
          cancelDeadline();
          cancelDeadline = armRemoteCallDeadline(ctx.pending, id, reject, ctx.wakeProbe);
          const sentAt = Date.now();
          silenceTimer = window.setTimeout(() => {
            // One probe at a time; any frame since the send proves the leg.
            if (!ctx.pending.has(id) || ctx.wakePongTimer !== null || ctx.lastTrafficAt >= sentAt) return;
            ctx.wakeProbe();
          }, SILENT_CALL_PROBE_MS);
        },
        (error) => {
          cancelDeadline();
          // Never sent: the PC owes nothing for it.
          settleCallCredit(id);
          if (!ctx.pending.delete(id)) return;
          const failure = error instanceof Error ? error : new Error(String(error));
          // The socket was handed out before its handshake finished — or it is
          // already closed. Nothing was sent on it, and a socket re-keying in
          // place after a desktop redial must not be closed for this: the call
          // fails as interrupted and the connection recovers on its own.
          if (ctx.socket !== ws || !ctx.connectionReady) {
            reject(remoteConnectionInterruptedError());
            return;
          }
          reject(failure);
          // A payload this leg refused to send is a bad request, not a broken
          // socket: every other call on it stays alive.
          if ((failure as { code?: string }).code === RELAY_PAYLOAD_TOO_LARGE_CODE) return;
          try {
            ws.close();
          } catch {
            /* reconnect loop handles it */
          }
        }
      );
    });
  };

  const send = async <T = unknown>(method: string, params: unknown[]): Promise<T> => {
    await ctx.connect();
    if (ctx.peerViewSync && !UNGATED_CALLS.has(method)) {
      await ctx.viewSync.ready();
    }
    return invoke<T>(method, params);
  };

  /** Identical state reads still waiting for the connection or the view sync.
   *  A cold start asks most of them twice — once as the app mounts, again
   *  from the connection-ready refreshes — and both copies would leave
   *  together once the sync lands. A read already sent is never joined, so a
   *  re-read after a change always gets an answer of its own. */
  const queuedReads = new Map<string, Promise<unknown>>();
  const call = <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const key = coalescedReadKey(method, params);
    if (!key) return send<T>(method, params);
    const booted = takeBootRead(key);
    if (booted) return booted as Promise<T>;
    const queued = queuedReads.get(key);
    if (queued) return queued as Promise<T>;
    const read: Promise<T> = (async () => {
      await ctx.connect();
      if (ctx.peerViewSync) await ctx.viewSync.ready();
    })().then(
      () => {
        if (queuedReads.get(key) === read) queuedReads.delete(key);
        return invoke<T>(method, params);
      },
      (error: unknown) => {
        if (queuedReads.get(key) === read) queuedReads.delete(key);
        throw error;
      }
    );
    queuedReads.set(key, read);
    return read;
  };

  /** The roster a view-synchronizing desktop already delivered. Every sync
   *  sends the sessions and agent catalogs in full before its receipt and
   *  keeps them current with pushes, so once the view is synchronized the
   *  retained copy IS the answer. Asking again only re-downloaded the whole
   *  catalog, and on the desktop that read queued behind every earlier
   *  capability call: a cold boot's catalog readiness — and with it a session
   *  opened from a notification — waited seconds for unrelated settings
   *  probes. Legacy peers and an unset catalog still read over the relay. */
  const readCatalog = async <T>(
    catalog: ReturnType<typeof createRemoteCatalog<T>>,
    method: 'listSessions' | 'listAgentPool'
  ): Promise<T[]> => {
    await ctx.connect();
    if (!ctx.peerViewSync) return call<T[]>(method);
    await ctx.viewSync.ready();
    return (await catalog.read(() => invoke<T[]>(method))) ?? call<T[]>(method);
  };

  const fire = (method: string, params: unknown[]): void => {
    void ctx
      .connect()
      .then((ws) => sendApplicationFrame(ws, { method, params }))
      .catch(() => {});
  };

  Object.assign(ctx, {
    publishLanes,
    laneSubscription,
    invoke,
    call,
    readCatalog,
    fire,
    settleCallCredit,
    retireCallCredits,
    callCreditStats,
  });
};
