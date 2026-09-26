// What an attached phone's decrypted frame asks for, after the E2EE handshake:
// transport-scoped registrations (lanes, visible sessions, view sync, resync)
// answered here, and every other call queued into the host's remote methods.
import { DESKTOP_CAPABILITIES } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { filterSessionIds } from './desktop-state';
import type { createRemoteMethods } from './remote-methods';
import { executeRemoteFrame } from './remote-methods';
import type { RelayClientState } from './remote-relay-clients';
import { registerAndSynchronizeRelayViews, type ParkedRelayViews } from './remote-view-sync';
import { isStateResyncFrame } from './state-delta';

// A phone gives up on an unanswered call at 20s (renderer remote-shim), closes
// the socket and reconnects into a full resync. Anything approaching that is
// already a broken session, so the threshold is low enough to catch the call
// that got there while staying silent for ordinary work.
const SLOW_REMOTE_CALL_MS = 2_000;

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_CAPABILITIES);

// Names the capabilities behind a capability call, so the logs say which one
// ran instead of only "invokeCapability". Only allow-listed names; never args.
function callCapabilities(method: string, params: unknown): string[] {
  if (method !== 'invokeCapability' && method !== 'readCapabilities') return [];
  const input = Array.isArray(params) ? params[0] : undefined;
  const requests = Array.isArray(input) ? input : [input];
  return requests.slice(0, 8).map((request) => {
    const name = (request as { capability?: unknown } | null)?.capability;
    return typeof name === 'string' && KNOWN_CAPABILITIES.has(name) ? name : 'unknown';
  });
}

/** The per-minute call summary key: the method, plus its capability names. */
export function remoteCallStatName(method: string, params: unknown): string {
  const capabilities = callCapabilities(method, params);
  if (!capabilities.length) return method;
  const name = `${method}:${capabilities.join('+')}`;
  // Whether a turn review re-read carried the tag of the review it holds:
  // tells a phone that never sends it from a review that keeps changing.
  if (name === 'invokeCapability:getTurnReviewDiff') {
    const args = (Array.isArray(params) ? (params[0] as { args?: unknown } | null)?.args : null) as unknown;
    const options = Array.isArray(args) ? (args[0] as { known?: unknown } | null) : null;
    if (typeof options?.known === 'string') return `${name}+tagged`;
  }
  return name;
}

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
  /** A departed phone's lanes, claimed by the resume token it presents. */
  takeParkedViews?(token: string): ParkedRelayViews | null;
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
    // The phone's own account of a slow reconnect (phase/state/issue tokens
    // with ms offsets). Log-only: nothing answers it.
    if (call?.method === 'reportConnectionTimeline' && Array.isArray(call.params)) {
      const text = String(call.params[0] ?? '')
        .slice(0, 1_500)
        .replace(/[^\w=@:. -]/gu, '');
      if (text) console.info(`[mixdog-remote-timeline] client=${clientId.slice(0, 8)} ${text}`);
      return {};
    }
    if (call?.method === 'synchronizeViews' && typeof call.id === 'number') {
      const synchronize = async (): Promise<void> => {
        if (!deps.attached(clientId, client)) return;
        try {
          if (!client.viewSync) throw new TypeError('View synchronization is unavailable.');
          const value = await registerAndSynchronizeRelayViews(
            deps.host,
            clientId,
            client,
            call.params,
            () => deps.live(clientId, client),
            (payload) => deps.sendEncryptedFrame(clientId, payload, false, undefined, true),
            deps.takeParkedViews
          );
          await deps.sendEncryptedFrame(clientId, { id: call.id, ok: true, value });
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
        (await deps.host.setVisibleSessionsForSource?.(`remote:${clientId}`, requested, !client.transcriptPaging)) ??
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
    // The turn review diff re-reads the worktree (seconds while a turn runs)
    // and is read-only: it rides the slow-read lane instead of fencing
    // stat/read/submit calls behind it.
    const queueKey = remoteCallStatName(String(call?.method ?? ''), call?.params).startsWith(
      'invokeCapability:getTurnReviewDiff'
    )
      ? 'invokeCapability:getTurnReviewDiff'
      : String(call?.method ?? '');
    const execution = client.callQueue.run(queueKey, async () => {
      if (!deps.attached(clientId, client)) return;
      const callStartedAt = Date.now();
      const queueMs = callStartedAt - callQueuedAt;
      const response = await executeRemoteFrame(deps.methods, clearFrame);
      const callMs = Date.now() - callStartedAt;
      const method =
        typeof call?.method === 'string' && Object.hasOwn(deps.methods, call.method) ? call.method : 'unknown';
      if (callMs + queueMs >= SLOW_REMOTE_CALL_MS) {
        const capabilities = callCapabilities(method, call?.params).join(',');
        console.error(
          `[mixdog-remote-slow-call] method=${method}` +
            (capabilities ? ` capability=${capabilities}` : '') +
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
        deps.recordCall(remoteCallStatName(method, call?.params), callMs, {
          requestBytes: frameBytes,
          responseBytes,
        });
      }
    });
    // Observe early rejection while the decode queue is still settling.
    void execution.catch(() => undefined);
    return { execution };
  };
}
