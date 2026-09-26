// Phones currently attached through the relay (client-open/-close envelopes),
// with the per-client wire state and the inbound frame budget that protects
// this leg from a client that sends faster than its calls complete.
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { createKeyedListDeltaEncoder } from '../shared/list-delta';
import type { RelayE2EEChannel, RelayE2EEChallenge } from '../shared/remote-e2ee';
import type { DesktopService } from './desktop-service-contract';
import { createRemoteCallQueue } from './remote-call-queue';
import type { createRemoteStateLane } from './remote-state-lane';
import type { ParkedRelayViews } from './remote-view-sync';
import type { createSnapshotDeltaEncoder } from './state-delta';

const MAX_ACTIVE_REMOTE_CLIENTS = 32;
const MAX_PENDING_REMOTE_FRAMES = 256;
const MAX_PENDING_REMOTE_TOTAL_FRAMES = 512;
const E2EE_HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a dropped phone's delta lanes wait for it to come back. */
export const VIEW_RESUME_TTL_MS = 120_000;

const createSessionsEncoder = () =>
  createKeyedListDeltaEncoder<DesktopSessionSummary>((session, index) => String(session.id || `session:${index}`));
const createAgentPoolEncoder = () =>
  createKeyedListDeltaEncoder<DesktopAgentPoolRow>((agent, index) =>
    String(agent.sessionId || agent.tag || `agent:${index}`)
  );

export interface RelayClientState {
  syncing?: boolean;
  viewSync?: boolean;
  viewRecovery?: Promise<void>;
  challenge: RelayE2EEChallenge;
  channel: RelayE2EEChannel | null;
  handshakeTimer: NodeJS.Timeout;
  frameQueue: Promise<void>;
  callQueue: ReturnType<typeof createRemoteCallQueue>;
  stateLane: ReturnType<typeof createRemoteStateLane> | null;
  pendingFrames: number;
  pendingBytes: number;
  visibleSessionIds: Set<string>;
  /** Transcript delta baselines are receiver-specific. A shared encoder
   *  advances even for clients filtered out of a session, so their first
   *  later frame would otherwise be an undecodable patch. */
  sessionStateEncoders: Map<string, ReturnType<typeof createSnapshotDeltaEncoder>>;
  binaryFrames: boolean;
  listDelta: boolean;
  /** Compact transcript frames: unchanged patch sections are dropped and the
   *  envelope addresses a session by handle. */
  compactWire: boolean;
  /** The browser pages transcript history from `transcriptHasOlder`, so its
   *  sessions open on a bounded tail. A browser that predates this keeps the
   *  512-item page it pages from by count. */
  transcriptPaging: boolean;
  /** The browser's decoder applies prepend patches, so an older-history page
   *  carries only the revealed rows. An older build receives the whole list. */
  transcriptPrepend: boolean;
  /** The browser's decoder applies head patches to `promptHistoryList`, so a
   *  submit carries the new prompt only. An older build receives the field. */
  promptHistoryPatch: boolean;
  /** Push lanes this browser actually reads ('terminal', 'editor',
   *  'files'). Terminal output, diagnostics and folder events are produced
   *  by DESKTOP activity — a build, a save — and used to reach every paired
   *  phone whether or not it had those surfaces open, so a phone left
   *  connected paid for a whole build log it never displayed. null means a
   *  client that predates this and still receives everything. */
  lanes: Set<string> | null;
  /** Per-client session handles: a live frame repeats the session id ~26
   *  bytes at a time, which is most of an envelope that carries ~30 bytes of
   *  new text. The name travels once, with the handle that replaces it. */
  sessionHandles: Map<string, number>;
  sessionsEncoder: ReturnType<typeof createKeyedListDeltaEncoder<DesktopSessionSummary>>;
  agentPoolEncoder: ReturnType<typeof createKeyedListDeltaEncoder<DesktopAgentPoolRow>>;
  /** What a returning phone actually waits for: the shell paints in ~250ms
   *  and then shows nothing until the FIRST transcript frame for the session
   *  it restored. Everything in between — E2EE handshake, layout restore,
   *  the visible-session registration, the host's own read — happens here,
   *  and no counter in this process could tell that gap from a slow link. */
  openedAt: number;
  firstTranscriptReported: boolean;
  /** Issued inside this phone's encrypted channel once it announced view
   *  resumption; its lanes are parked under it when the relay drops the leg. */
  viewResumeToken?: string;
  /** The phone persists its sessions roster (remote-roster-log.ts). */
  rosterStamp?: boolean;
}

/** A push lane reaches a browser that registered it, or one that predates the
 *  lane protocol and therefore still expects everything. An empty set is a
 *  deliberate "nothing right now", not a missing registration. */
export function clientReadsLane(lanes: ReadonlySet<string> | null, lane: string): boolean {
  return lanes === null || lanes.has(lane);
}

export interface RelayClientRegistryDeps {
  host: DesktopService;
  sendEnvelope(payload: unknown): void;
  /** One inbound frame may hold this many bytes per client; the whole leg
   *  holds twice that across clients. */
  frameBudgetBytes: number;
  onClientCountChanged(): void;
  /** The last phone left: per-leg meters have nothing left to attribute. */
  onEmpty(): void;
  now?: () => number;
}

export interface RelayClientRegistry {
  readonly clients: ReadonlyMap<string, RelayClientState>;
  readonly size: number;
  get(clientId: string): RelayClientState | undefined;
  /** The registry still holds THIS state for the id — a replacement client
   *  under the same id fails the check. */
  attached(clientId: string, state: RelayClientState): boolean;
  /** Admits a client-open: refuses over the client limit (telling the relay),
   *  replaces any previous state under the id, and starts the handshake
   *  deadline. Returns the fresh state, or null when refused. */
  open(clientId: string, challenge: RelayE2EEChallenge): RelayClientState | null;
  /** `park`: the relay reported the leg gone, so an authenticated phone that
   *  announced resumption keeps its delta lanes for VIEW_RESUME_TTL_MS. */
  remove(clientId: string, park?: boolean): boolean;
  /** Drops every client (and every parked set) and notifies once. */
  clear(): void;
  /** The parked lanes for a token, at most once and only before expiry. */
  takeParkedViews(token: string): ParkedRelayViews | null;
  /** Unpair or credential change: no parked lanes may outlive it. */
  dropParkedViews(): void;
  /** Drops the client and tells the relay why. */
  close(clientId: string, reason: string): void;
  /** Counts an inbound frame against the client and leg budgets; false (and
   *  the client closed) when either would overflow. */
  admitFrame(clientId: string, state: RelayClientState, bytes: number): boolean;
  releaseFrame(state: RelayClientState, bytes: number): void;
  /** Every client's delta baselines restart: the relay leg was replaced. */
  resetDeltas(): void;
}

export function createRelayClientRegistry(deps: RelayClientRegistryDeps): RelayClientRegistry {
  const clients = new Map<string, RelayClientState>();
  let totalPendingFrames = 0;
  let totalPendingBytes = 0;
  const budgetAvailable = (state: RelayClientState, nextBytes: number): boolean =>
    state.pendingFrames < MAX_PENDING_REMOTE_FRAMES &&
    state.pendingBytes + nextBytes <= deps.frameBudgetBytes &&
    totalPendingFrames < MAX_PENDING_REMOTE_TOTAL_FRAMES &&
    totalPendingBytes + nextBytes <= deps.frameBudgetBytes * 2;
  const now = deps.now ?? Date.now;
  // Keyed by a 256-bit token only the phone's own encrypted channel ever
  // carried, so no other paired browser can name — let alone adopt — them.
  const parked = new Map<string, { views: ParkedRelayViews; expiresAt: number; timer: NodeJS.Timeout }>();
  const dropParked = (token: string): void => {
    const entry = parked.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    parked.delete(token);
  };
  const dropParkedViews = (): void => {
    for (const token of [...parked.keys()]) dropParked(token);
  };
  const park = (state: RelayClientState): void => {
    const token = state.viewResumeToken;
    // Mid-recovery encoders describe no settled stream.
    if (!state.channel || !token || state.syncing) return;
    const views: ParkedRelayViews = {
      compactWire: state.compactWire,
      transcriptPrepend: state.transcriptPrepend,
      promptHistoryPatch: state.promptHistoryPatch,
      listDelta: state.listDelta,
      stateEncoder: state.stateLane?.park() ?? null,
      sessionsEncoder: state.sessionsEncoder,
      agentPoolEncoder: state.agentPoolEncoder,
      sessionStateEncoders: new Map(state.sessionStateEncoders),
    };
    // Detached: a late write still holding the departed state can no longer
    // move what was parked.
    state.sessionsEncoder = createSessionsEncoder();
    state.agentPoolEncoder = createAgentPoolEncoder();
    state.sessionStateEncoders = new Map();
    dropParked(token);
    while (parked.size >= MAX_ACTIVE_REMOTE_CLIENTS) {
      const oldest = parked.keys().next();
      if (oldest.done) break;
      dropParked(oldest.value);
    }
    const timer = setTimeout(() => dropParked(token), VIEW_RESUME_TTL_MS);
    timer.unref?.();
    parked.set(token, { views, expiresAt: now() + VIEW_RESUME_TTL_MS, timer });
  };
  const remove = (clientId: string, parkLanes = false): boolean => {
    const state = clients.get(clientId);
    if (!state) return false;
    if (parkLanes) park(state);
    clearTimeout(state.handshakeTimer);
    state.callQueue.close();
    state.stateLane?.clear();
    clients.delete(clientId);
    if (clients.size === 0) deps.onEmpty();
    void deps.host.setVisibleSessionsForSource?.(`remote:${clientId}`, []).catch(() => {});
    return true;
  };
  const close = (clientId: string, reason: string): void => {
    if (remove(clientId)) deps.onClientCountChanged();
    deps.sendEnvelope({ type: 'close-client', clientId, reason });
  };
  return {
    clients,
    get size() {
      return clients.size;
    },
    get: (clientId) => clients.get(clientId),
    attached: (clientId, state) => clients.get(clientId) === state,
    open: (clientId, challenge) => {
      if (!clients.has(clientId) && clients.size >= MAX_ACTIVE_REMOTE_CLIENTS) {
        deps.sendEnvelope({ type: 'close-client', clientId, reason: 'remote client limit reached' });
        return null;
      }
      remove(clientId);
      const handshakeTimer = setTimeout(() => {
        close(clientId, 'relay encryption handshake timed out');
      }, E2EE_HANDSHAKE_TIMEOUT_MS);
      handshakeTimer.unref?.();
      const state: RelayClientState = {
        challenge,
        channel: null,
        handshakeTimer,
        frameQueue: Promise.resolve(),
        callQueue: createRemoteCallQueue(),
        stateLane: null,
        pendingFrames: 0,
        pendingBytes: 0,
        visibleSessionIds: new Set(),
        sessionStateEncoders: new Map(),
        binaryFrames: false,
        listDelta: false,
        compactWire: false,
        transcriptPaging: false,
        transcriptPrepend: false,
        promptHistoryPatch: false,
        lanes: null,
        sessionHandles: new Map(),
        sessionsEncoder: createSessionsEncoder(),
        agentPoolEncoder: createAgentPoolEncoder(),
        openedAt: Date.now(),
        firstTranscriptReported: false,
      };
      clients.set(clientId, state);
      deps.onClientCountChanged();
      return state;
    },
    remove,
    clear: () => {
      dropParkedViews();
      if (clients.size === 0) return;
      for (const clientId of [...clients.keys()]) remove(clientId);
      deps.onClientCountChanged();
    },
    takeParkedViews: (token) => {
      const entry = parked.get(token);
      if (!entry) return null;
      dropParked(token);
      return entry.expiresAt > now() ? entry.views : null;
    },
    dropParkedViews,
    close,
    admitFrame: (clientId, state, bytes) => {
      if (!budgetAvailable(state, bytes)) {
        close(clientId, 'remote client backlog exceeded');
        return false;
      }
      state.pendingFrames += 1;
      state.pendingBytes += bytes;
      totalPendingFrames += 1;
      totalPendingBytes += bytes;
      return true;
    },
    releaseFrame: (state, bytes) => {
      state.pendingFrames = Math.max(0, state.pendingFrames - 1);
      state.pendingBytes = Math.max(0, state.pendingBytes - bytes);
      totalPendingFrames = Math.max(0, totalPendingFrames - 1);
      totalPendingBytes = Math.max(0, totalPendingBytes - bytes);
    },
    resetDeltas: () => {
      dropParkedViews();
      for (const state of clients.values()) {
        state.stateLane?.clear();
        state.sessionStateEncoders.clear();
        state.sessionsEncoder.reset();
        state.agentPoolEncoder.reset();
      }
    },
  };
}
