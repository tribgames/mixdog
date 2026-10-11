// Calls over the socket: RPC framing, the view-sync gate, catalog reads and
// the push lanes this browser registers.
import { RELAY_PAYLOAD_TOO_LARGE_CODE } from '../shared/remote-payload-limit';
import type { createRemoteCatalog } from '../shared/remote-catalog';
import { armRemoteCallDeadline } from './remote-call-deadline';
import { remoteConnectionInterruptedError } from './remote-connection-state';
import type { RemoteShimContext } from './remote-shim-state';

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

  const invoke = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const ws = await ctx.connect();
    return await new Promise<T>((resolve, reject) => {
      const id = ctx.nextId++;
      const deadline = armRemoteCallDeadline(ctx.pending, id, reject, ctx.wakeProbe);
      ctx.pending.set(id, {
        resolve: (value: unknown) => {
          window.clearTimeout(deadline);
          (resolve as (value: unknown) => void)(value);
        },
        reject: (reason: Error) => {
          window.clearTimeout(deadline);
          reject(reason);
        },
      });
      void sendApplicationFrame(ws, { id, method, params }).catch((error) => {
        ctx.pending.delete(id);
        const failure = error instanceof Error ? error : new Error(String(error));
        window.clearTimeout(deadline);
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
      });
    });
  };

  const call = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    await ctx.connect();
    if (ctx.peerViewSync && method !== 'abortSession' && method !== 'resolveToolApprovalForSession') {
      await ctx.viewSync.ready();
    }
    return invoke<T>(method, params);
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

  Object.assign(ctx, { publishLanes, laneSubscription, invoke, call, readCatalog, fire });
};
