// What an attached phone's decrypted frame asks for, after the E2EE handshake:
// transport-scoped registrations (lanes, visible sessions, view sync, resync)
// answered here, and every other call queued into the host's remote methods.
import { DESKTOP_CAPABILITIES, DESKTOP_READ_CAPABILITIES } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import {
  type LatestCall,
  REVIEW_FILE_PATCH_CALLS,
  SIDE_QUESTION_CALLS,
  SIDE_QUESTION_CANCEL_CALL,
  SLOW_CAPABILITY_READ_CALL,
  SLOW_READ_CAPABILITIES,
  VOICE_CALLS,
} from './remote-call-queue';
import { filterSessionIds, requiredSessionId } from './desktop-state';
import { normalizeRemoteBrowserStreamOptions } from '../shared/remote-browser';
import {
  REMOTE_WEBRTC_SCREEN_DISPLAYS_METHOD,
  REMOTE_WEBRTC_SIGNAL_METHOD,
  parseRemoteWebrtcRelayInputOrder,
} from '../shared/remote-webrtc';
import type { RemoteRelayInputOrder } from './remote-webrtc/input-order';
import { remoteWebrtcSignalIsBarrier, type RemoteWebrtcRelay } from './remote-webrtc/relay';
import type { createBrowserRemoteStreams } from './remote-browser-streams';
import type { createBrowserRemoteTabSubscribers } from './remote-browser-tabs';
import type { createRemoteMethods } from './remote-methods';
import { executeRemoteFrame } from './remote-methods';
import type { RelayClientState, SendEncryptedFrame } from './remote-relay-clients';
import { registerAndSynchronizeRelayViews, type ParkedRelayViews } from './remote-view-sync';
import { isStateResyncFrame } from './state-delta';

// A phone gives up on an unanswered call at 20s (renderer remote-shim), closes
// the socket and reconnects into a full resync. Anything approaching that is
// already a broken session, so the threshold is low enough to catch the call
// that got there while staying silent for ordinary work.
const SLOW_REMOTE_CALL_MS = 2_000;

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_CAPABILITIES);
const READ_CAPABILITIES: ReadonlySet<string> = new Set(DESKTOP_READ_CAPABILITIES);

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

/** The lane key of a call: its method, or for a capability call the capability
 *  name when that capability rides a slow-read, voice or side-question lane. */
export function remoteCallQueueKey(method: string, statName: string): string {
  if (statName.startsWith('invokeCapability:getTurnReviewDiff')) return 'invokeCapability:getTurnReviewDiff';
  if (
    statName === 'invokeCapability:getTurnChanges' ||
    REVIEW_FILE_PATCH_CALLS.has(statName) ||
    VOICE_CALLS.has(statName) ||
    SIDE_QUESTION_CALLS.has(statName) ||
    statName === SIDE_QUESTION_CANCEL_CALL
  ) {
    return statName;
  }
  // Read-only capabilities read like any other read: a quota/usage sweep on
  // the slow-read lane, the rest overlapping in the general lane. As barriers
  // they (and everything after them) waited for every in-flight read.
  if (method === 'invokeCapability' || method === 'readCapabilities') {
    const capabilities = statName.slice(method.length + 1).split('+');
    if (capabilities.every((name) => READ_CAPABILITIES.has(name))) {
      return capabilities.some((name) => SLOW_READ_CAPABILITIES.has(name))
        ? SLOW_CAPABILITY_READ_CALL
        : 'readCapabilities';
    }
  }
  return method;
}

const SEARCH_SUPERSEDED = 'Search superseded by a newer query.';

const RELAY_PAGE_INPUT: ReadonlySet<string> = new Set([
  'pointer',
  'wheel',
  'text',
  'key',
  'composition',
  'composition-end',
]);

/** A `browserRemoteControl` argument that is document-bound page input. */
function isRelayPageInput(control: unknown): boolean {
  return RELAY_PAGE_INPUT.has(String((control as { type?: unknown } | null)?.type ?? ''));
}

/** A file-name search's newest-wins scope: the same root and the same result
 *  shape (limit, ignored files, folders), so one surface's keystrokes replace
 *  each other while another surface's (or another root's) search stands. */
function searchLatestCall(
  call: { method?: unknown; params?: unknown } | null,
  superseded: () => Promise<void>
): LatestCall | undefined {
  if (call?.method !== 'searchProjectFiles' || !Array.isArray(call.params)) return undefined;
  const [root, , limit, includeIgnored, includeDirectories] = call.params;
  if (typeof root !== 'string') return undefined;
  return {
    latest: JSON.stringify([root, limit ?? null, includeIgnored === true, includeDirectories === true]),
    superseded,
  };
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
  /** The method table, or the factory for one client's table: the device
   *  name is a property of the connection, so a relay leg builds its own. */
  methods:
    | ReturnType<typeof createRemoteMethods>
    | ((clientId: string, client: RelayClientState) => ReturnType<typeof createRemoteMethods>);
  /** The registry still holds THIS state for the id. */
  attached(clientId: string, state: RelayClientState): boolean;
  /** …and the leg is open: what a view recovery may still send into. */
  live(clientId: string, state: RelayClientState): boolean;
  sendEncryptedFrame: SendEncryptedFrame;
  /** A paint acknowledgement is consumed here and answers nothing. */
  acknowledgePaintProbe(payload: unknown): { sessionId: string; roundTripMs: number; receiveToPaintMs: number } | null;
  resyncClient(clientId: string, state: RelayClientState): void;
  recordCall(method: string, callMs: number, bytes: { requestBytes: number; responseBytes: number }): void;
  /** Live Browser Use frame subscriptions, per client. */
  browserStreams: Pick<ReturnType<typeof createBrowserRemoteStreams>, 'subscribe' | 'unsubscribe' | 'acknowledge'>;
  /** Main-workspace browser tab watchers, per client. */
  browserTabs: Pick<ReturnType<typeof createBrowserRemoteTabSubscribers>, 'watch'>;
  /** WebRTC live-view signaling and its input-ownership gate, per client. */
  webrtc?: Pick<RemoteWebrtcRelay, 'accept' | 'forward' | 'relayInputAllowed' | 'screenDisplays'>;
  /** Ordered relay input state, per client × session. */
  relayInputOrder?: Pick<RemoteRelayInputOrder, 'admit' | 'failed'>;
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
    // Live Browser Use view: the subscription belongs to THIS client, so it is
    // registered here rather than through the client-less method table. The
    // ack is fire-and-forget and must never queue behind slower calls.
    if (call?.method === 'browserRemoteStream' && Array.isArray(call.params)) {
      try {
        const sessionId = requiredSessionId(call.params[0]);
        if (call.params[1] == null) deps.browserStreams.unsubscribe(clientId, sessionId);
        else deps.browserStreams.subscribe(clientId, sessionId, normalizeRemoteBrowserStreamOptions(call.params[1]));
        if (typeof call.id === 'number')
          await deps.sendEncryptedFrame(clientId, { id: call.id, ok: true, value: null });
      } catch (error) {
        if (typeof call.id === 'number') {
          await deps.sendEncryptedFrame(clientId, {
            id: call.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {};
    }
    // The main-workspace tab list is pushed to THIS client while it watches;
    // starting the watch answers with the current list.
    if (call?.method === 'browserRemoteTabs' && Array.isArray(call.params)) {
      try {
        const tabs = await deps.browserTabs.watch(clientId, call.params[0] === true);
        if (typeof call.id === 'number')
          await deps.sendEncryptedFrame(clientId, { id: call.id, ok: true, value: tabs });
      } catch (error) {
        if (typeof call.id === 'number') {
          await deps.sendEncryptedFrame(clientId, {
            id: call.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {};
    }
    // WebRTC live-view signaling: client-bound, validated and gated here, at
    // decode time. The two input-ownership acks run as general-lane writes so
    // they reach the window behind every relay call decoded before them.
    if (call?.method === REMOTE_WEBRTC_SIGNAL_METHOD && Array.isArray(call.params)) {
      const reply = async (ok: boolean, error?: unknown): Promise<void> => {
        if (typeof call.id !== 'number' || !deps.attached(clientId, client)) return;
        await deps.sendEncryptedFrame(
          clientId,
          ok
            ? { id: call.id, ok: true, value: null }
            : { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) }
        );
      };
      const webrtc = deps.webrtc;
      let signal: ReturnType<RemoteWebrtcRelay['accept']>;
      try {
        if (!webrtc) throw new TypeError('Remote WebRTC is unavailable.');
        signal = webrtc.accept(clientId, call.params[0]);
      } catch (error) {
        await reply(false, error);
        return {};
      }
      const run = () =>
        webrtc.forward(clientId, signal).then(
          () => reply(true),
          (error: unknown) => reply(false, error)
        );
      if (!remoteWebrtcSignalIsBarrier(signal)) {
        void run();
        return {};
      }
      const execution = client.callQueue.run(REMOTE_WEBRTC_SIGNAL_METHOD, run);
      void execution.catch(() => undefined);
      return { execution };
    }
    // The displays a phone may view as a screen source, for a granted client only.
    if (call?.method === REMOTE_WEBRTC_SCREEN_DISPLAYS_METHOD) {
      const webrtc = deps.webrtc;
      const execution = (async () => {
        try {
          if (!webrtc) throw new TypeError('Remote WebRTC is unavailable.');
          const value = await webrtc.screenDisplays(clientId);
          if (typeof call.id === 'number' && deps.attached(clientId, client)) {
            await deps.sendEncryptedFrame(clientId, { id: call.id, ok: true, value });
          }
        } catch (error) {
          if (typeof call.id === 'number' && deps.attached(clientId, client)) {
            await deps.sendEncryptedFrame(clientId, {
              id: call.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();
      return { execution };
    }
    // While WebRTC owns (or is handing back) this client's input for a session,
    // its relay page input is refused here, in decode order.
    if (
      call?.method === 'browserRemoteControl' &&
      Array.isArray(call.params) &&
      typeof call.params[0] === 'string' &&
      isRelayPageInput(call.params[1]) &&
      deps.webrtc &&
      !deps.webrtc.relayInputAllowed(clientId, call.params[0])
    ) {
      if (typeof call.id === 'number') {
        await deps.sendEncryptedFrame(clientId, {
          id: call.id,
          ok: false,
          error: 'Remote Browser Use input belongs to the WebRTC channel; input was not sent.',
        });
      }
      return {};
    }
    // Ordered relay input (RemoteWebrtcRelayInputOrder): judged where it
    // executes — general-lane writes run one at a time in decode order — so a
    // failed control poisons its run before anything behind it is admitted.
    if (
      call?.method === 'browserRemoteControl' &&
      Array.isArray(call.params) &&
      call.params[2] !== undefined &&
      deps.relayInputOrder
    ) {
      const inputOrder = deps.relayInputOrder;
      const params = call.params;
      const refuse = async (error: unknown): Promise<void> => {
        if (typeof call.id !== 'number' || !deps.attached(clientId, client)) return;
        await deps.sendEncryptedFrame(clientId, {
          id: call.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      let order: ReturnType<typeof parseRemoteWebrtcRelayInputOrder>;
      let sessionId: string;
      try {
        order = parseRemoteWebrtcRelayInputOrder(params[2]);
        sessionId = requiredSessionId(params[0]);
      } catch (error) {
        await refuse(error);
        return {};
      }
      const methods = typeof deps.methods === 'function' ? deps.methods(clientId, client) : deps.methods;
      const execution = client.callQueue.run('browserRemoteControl', async () => {
        if (!deps.attached(clientId, client)) return;
        const verdict = inputOrder.admit(clientId, sessionId, order);
        if (!verdict.dispatch) {
          await refuse(verdict.error);
          return;
        }
        const response = await executeRemoteFrame(
          methods,
          JSON.stringify({ id: call.id, method: 'browserRemoteControl', params: [params[0], params[1]] })
        );
        if (response && 'ok' in response && response.ok === false) inputOrder.failed(clientId, sessionId, order);
        if (response !== undefined && deps.attached(clientId, client)) {
          await deps.sendEncryptedFrame(clientId, response);
        }
      });
      void execution.catch(() => undefined);
      return { execution };
    }
    if (call?.method === 'browserRemoteStreamAck' && Array.isArray(call.params)) {
      const [sessionId, seq] = call.params;
      if (typeof sessionId === 'string' && typeof seq === 'number') {
        deps.browserStreams.acknowledge(clientId, sessionId, seq);
      }
      return {};
    }
    // Transport-scoped too: whether THIS browser has the app on screen, which
    // decides if a finished turn still needs a push notification.
    if (call?.method === 'setForeground' && Array.isArray(call.params)) {
      client.background = call.params[0] === false;
      if (typeof call.params[1] === 'string') client.browserId = call.params[1].slice(0, 64);
      return {};
    }
    // Transport-scoped as well: the sessions THIS browser paints, which
    // decide whether a notification for one of them is held back.
    if (call?.method === 'setScreenSessions' && Array.isArray(call.params)) {
      client.screenSessionIds = new Set(filterSessionIds(call.params[0]));
      return {};
    }
    // And the sessions whose visualize panel THIS browser has on screen: an
    // agent open there is "visible" only for these.
    if (call?.method === 'setVisualizePanels' && Array.isArray(call.params)) {
      client.visualizePanelSessionIds = new Set(filterSessionIds(call.params[0]));
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
    // stat/read/submit calls behind it. Dictation rides its own voice lane.
    const statName = remoteCallStatName(String(call?.method ?? ''), call?.params);
    const queueKey = remoteCallQueueKey(String(call?.method ?? ''), statName);
    const methods = typeof deps.methods === 'function' ? deps.methods(clientId, client) : deps.methods;
    // A /btw call names its session: a queued side question that session's
    // cancel (or newer side question) overtook is answered as canceled.
    const sideSessionId = (Array.isArray(call?.params) ? (call.params[0] as { sessionId?: unknown } | null) : null)
      ?.sessionId;
    const sideCall =
      typeof sideSessionId === 'string' && sideSessionId
        ? {
            sessionId: sideSessionId,
            superseded: async () => {
              if (typeof call?.id !== 'number' || !deps.attached(clientId, client)) return;
              await deps.sendEncryptedFrame(clientId, { id: call.id, ok: false, error: 'Side question canceled.' });
            },
          }
        : searchLatestCall(call, async () => {
            if (typeof call?.id !== 'number' || !deps.attached(clientId, client)) return;
            await deps.sendEncryptedFrame(clientId, { id: call.id, ok: false, error: SEARCH_SUPERSEDED });
          });
    const execution = client.callQueue.run(
      queueKey,
      async () => {
        if (!deps.attached(clientId, client)) return;
        const callStartedAt = Date.now();
        const queueMs = callStartedAt - callQueuedAt;
        const response = await executeRemoteFrame(methods, clearFrame);
        const callMs = Date.now() - callStartedAt;
        const method =
          typeof call?.method === 'string' && Object.hasOwn(methods, call.method) ? call.method : 'unknown';
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
      },
      sideCall
    );
    // Observe early rejection while the decode queue is still settling.
    void execution.catch(() => undefined);
    return { execution };
  };
}
