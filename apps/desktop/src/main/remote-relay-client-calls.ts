// What an attached phone's decrypted frame asks for, after the E2EE handshake:
// transport-scoped registrations (lanes, visible sessions, view sync, resync)
// answered here, and every other call queued into the host's remote methods.
import type { DesktopService } from './desktop-service-contract';
import { filterSessionIds } from './desktop-state';
import type { createRemoteMethods } from './remote-methods';
import { executeRemoteFrame } from './remote-methods';
import type { RelayClientState } from './remote-relay-clients';
import { registerAndSynchronizeRelayViews } from './remote-view-sync';
import { isStateResyncFrame } from './state-delta';

// A phone gives up on an unanswered call at 20s (renderer remote-shim), closes
// the socket and reconnects into a full resync. Anything approaching that is
// already a broken session, so the threshold is low enough to catch the call
// that got there while staying silent for ordinary work.
const SLOW_REMOTE_CALL_MS = 2_000;

export interface RelayClientCallDeps {
  host: DesktopService;
  methods: ReturnType<typeof createRemoteMethods>;
  /** The registry still holds THIS state for the id. */
  attached(clientId: string, state: RelayClientState): boolean;
  /** …and the leg is open: what a view recovery may still send into. */
  live(clientId: string, state: RelayClientState): boolean;
  sendEncryptedFrame(
    clientId: string,
    payload: unknown,
    droppable?: boolean,
    onSent?: (bytes: number) => void,
    requireDelivery?: boolean
  ): Promise<void>;
  /** A paint acknowledgement is consumed here and answers nothing. */
  acknowledgePaintProbe(payload: unknown): { sessionId: string; roundTripMs: number; receiveToPaintMs: number } | null;
  resyncClient(clientId: string, state: RelayClientState): void;
  recordCall(method: string, callMs: number, bytes: { requestBytes: number; responseBytes: number }): void;
}

export interface RelayClientCallOutcome {
  /** The call's execution, when it runs outside the ordered decode queue. */
  execution?: Promise<void>;
}

export function createRelayClientCallDispatch(
  deps: RelayClientCallDeps
): (
  clientId: string,
  client: RelayClientState,
  clearPayload: unknown,
  frameBytes: number
) => Promise<RelayClientCallOutcome> {
  return async (clientId, client, clearPayload, frameBytes) => {
    const paint = deps.acknowledgePaintProbe(clearPayload);
    if (paint) {
      console.error(
        `[mixdog-remote-perf] session=${paint.sessionId}` +
          ` publish-to-paint-rtt=${paint.roundTripMs.toFixed(0)}ms` +
          ` receive-to-paint=${paint.receiveToPaintMs.toFixed(1)}ms`
      );
      return {};
    }
    const call = clearPayload as { id?: unknown; method?: unknown; params?: unknown } | null;
    if (call?.method === 'synchronizeViews' && typeof call.id === 'number') {
      const synchronize = async (): Promise<void> => {
        if (!deps.attached(clientId, client)) return;
        try {
          if (!client.viewSync) throw new TypeError('View synchronization is unavailable.');
          await registerAndSynchronizeRelayViews(
            deps.host,
            clientId,
            client,
            call.params,
            () => deps.live(clientId, client),
            (payload) => deps.sendEncryptedFrame(clientId, payload, false, undefined, true)
          );
          await deps.sendEncryptedFrame(clientId, { id: call.id, ok: true, value: true });
        } catch (error) {
          client.syncing = false;
          await deps.sendEncryptedFrame(clientId, {
            id: call.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      // Only decoding must be ordered. A slow recovery read must not
      // stop an explicit abort/approval from reaching the live runtime.
      const recovery = (client.viewRecovery ?? Promise.resolve()).catch(() => undefined).then(synchronize);
      client.viewRecovery = recovery;
      const execution = recovery.finally(() => {
        if (client.viewRecovery === recovery) client.viewRecovery = undefined;
      });
      void execution.catch(() => undefined);
      return { execution };
    }
    // Transport-scoped, like setVisibleSessions: it registers what THIS
    // browser reads rather than asking the host for anything.
    if (call?.method === 'setRemoteLanes' && Array.isArray(call.params)) {
      const requested = Array.isArray(call.params[0]) ? call.params[0] : [];
      client.lanes = new Set(
        requested.map((value: unknown) => String(value || '')).filter((value: string) => /^[a-z]{1,16}$/u.test(value))
      );
      if (typeof call.id === 'number') {
        await deps.sendEncryptedFrame(clientId, {
          id: call.id,
          ok: true,
          value: true,
        });
      }
      return {};
    }
    if (call?.method === 'setVisibleSessions' && Array.isArray(call.params)) {
      await client.viewRecovery;
      const requested = filterSessionIds(call.params[0]);
      const nextVisible = new Set(requested);
      for (const sessionId of client.sessionStateEncoders.keys()) {
        if (!nextVisible.has(sessionId)) client.sessionStateEncoders.delete(sessionId);
      }
      client.visibleSessionIds = nextVisible;
      const value =
        (await deps.host.setVisibleSessionsForSource?.(`remote:${clientId}`, requested)) ??
        (await deps.host.setVisibleSessions?.(requested)) ??
        false;
      if (typeof call.id === 'number') {
        await deps.sendEncryptedFrame(clientId, {
          id: call.id,
          ok: true,
          value,
        });
      }
      return {};
    }
    const clearFrame = JSON.stringify(clearPayload);
    if (isStateResyncFrame(clearFrame)) {
      deps.resyncClient(clientId, client);
      return {};
    }
    // Decryption stays ordered; independent reads execute concurrently.
    // Count the frame until execution finishes, not merely until decode.
    const callQueuedAt = Date.now();
    const execution = client.callQueue.run(String(call?.method ?? ''), async () => {
      if (!deps.attached(clientId, client)) return;
      const callStartedAt = Date.now();
      const queueMs = callStartedAt - callQueuedAt;
      const response = await executeRemoteFrame(deps.methods, clearFrame);
      const callMs = Date.now() - callStartedAt;
      const method =
        typeof call?.method === 'string' && Object.hasOwn(deps.methods, call.method) ? call.method : 'unknown';
      if (callMs + queueMs >= SLOW_REMOTE_CALL_MS) {
        console.error(
          `[mixdog-remote-slow-call] method=${method}` +
            ` ms=${callMs} queueMs=${queueMs} queuedBehind=${client.pendingFrames}`
        );
      }
      let responseBytes = 0;
      if (response !== undefined && deps.attached(clientId, client)) {
        await deps.sendEncryptedFrame(clientId, response, false, (bytes) => {
          responseBytes += bytes;
        });
      }
      if (deps.attached(clientId, client)) {
        deps.recordCall(method, callMs, { requestBytes: frameBytes, responseBytes });
      }
    });
    // Observe early rejection while the decode queue is still settling.
    void execution.catch(() => undefined);
    return { execution };
  };
}
