import { createHash, randomBytes } from 'node:crypto';
import type { DesktopService } from './desktop-service-contract';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { isNoListDelta, type KeyedListDeltaEncoder } from '../shared/list-delta';
import type { SnapshotDeltaEncoder } from './state-delta';
import { createSnapshotDeltaEncoder, isNoDelta, markCompactWire } from './state-delta';
import { synchronizeViewSnapshot } from './view-synchronizer';
import { isSessionId } from './desktop-state';
import { remoteTranscriptSnapshot } from './remote-transcript';
import { MAX_VIEW_BASELINE_BYTES, readViewBaselineOffer, VIEW_BASELINE_EVENT } from '../shared/remote-view-baseline';
import { readViewResumeRequest, viewResumeLaneMatches, type ViewResumeRequest } from '../shared/remote-view-resume';

const VIEW_REPLACED = 'Remote view was replaced during synchronization.';

interface RelayViewSyncState {
  syncing?: boolean;
  visibleSessionIds: Set<string>;
  compactWire: boolean;
  /** False for a browser that cannot page transcript history (see RelayClientState). */
  transcriptPaging?: boolean;
  /** The browser decodes prepend patches (see RelayClientState). */
  transcriptPrepend?: boolean;
  listDelta: boolean;
  sessionStateEncoders: Map<string, SnapshotDeltaEncoder>;
  sessionsEncoder: KeyedListDeltaEncoder<DesktopSessionSummary>;
  agentPoolEncoder: KeyedListDeltaEncoder<DesktopAgentPoolRow>;
  stateLane: {
    reset(snapshot: unknown, baselineSend?: (payload: unknown) => Promise<void>): Promise<void>;
    pristine(): boolean;
    resume(
      snapshot: unknown,
      parked: SnapshotDeltaEncoder,
      deliver: (payload: unknown) => Promise<void>
    ): Promise<void>;
  } | null;
  /** Issued once this phone announced resumption (see remote-view-resume.ts);
   *  its lanes are parked under it when the leg drops. */
  viewResumeToken?: string;
}

/** A departed phone's encoders, detached from its client state. */
export interface ParkedRelayViews {
  compactWire: boolean;
  transcriptPrepend: boolean;
  listDelta: boolean;
  stateEncoder: SnapshotDeltaEncoder | null;
  sessionsEncoder: KeyedListDeltaEncoder<DesktopSessionSummary>;
  agentPoolEncoder: KeyedListDeltaEncoder<DesktopAgentPoolRow>;
  sessionStateEncoders: Map<string, SnapshotDeltaEncoder>;
}

interface RelayViewResume {
  claim: ViewResumeRequest;
  parked: ParkedRelayViews;
}

interface AdoptedRelayViews {
  state: SnapshotDeltaEncoder | null;
  sessions: KeyedListDeltaEncoder<DesktopSessionSummary> | null;
  agentPool: KeyedListDeltaEncoder<DesktopAgentPoolRow> | null;
  sessionStates: Map<string, SnapshotDeltaEncoder>;
}

/** Answers `true` exactly as before for a phone that sent no resume request;
 * otherwise the token this connection's lanes will be parked under. */
export async function registerAndSynchronizeRelayViews(
  host: DesktopService,
  clientId: string,
  state: RelayViewSyncState,
  params: unknown,
  current: () => boolean,
  send: (frame: unknown) => Promise<void>,
  takeParkedViews?: (token: string) => ParkedRelayViews | null
): Promise<true | { resume: string }> {
  if (
    !Array.isArray(params) ||
    !Array.isArray(params[0]) ||
    params[0].length > 128 ||
    params[0].some((id: unknown) => !isSessionId(id))
  ) {
    throw new TypeError('View synchronization request is invalid.');
  }
  if (!current()) throw new Error(VIEW_REPLACED);
  const ids = [...new Set(params[0] as string[])];
  const claim = readViewResumeRequest(params[2]);
  // Taken exactly once: a failed recovery leaves nothing a retry could adopt.
  const parked = claim?.token && takeParkedViews ? takeParkedViews(claim.token) : null;
  state.syncing = true;
  state.visibleSessionIds = new Set(ids);
  try {
    await (host.setVisibleSessionsForSource
      ? host.setVisibleSessionsForSource(`remote:${clientId}`, ids, state.transcriptPaging !== true)
      : host.setVisibleSessions?.(ids));
    await synchronizeRelayViews(
      host,
      state,
      current,
      send,
      readViewBaselineOffer(params[1]),
      claim && parked ? { claim, parked } : null
    );
  } finally {
    state.syncing = false;
  }
  if (!claim) return true;
  state.viewResumeToken ??= randomBytes(32).toString('base64url');
  return { resume: state.viewResumeToken };
}

/** Lanes whose parked encoder last emitted exactly what the phone holds. A
 * lane this connection already sent on is excluded: the phone's decoder may
 * have been replaced by that frame after it described its state. */
async function adoptParkedViews(state: RelayViewSyncState, resume: RelayViewResume): Promise<AdoptedRelayViews> {
  const { claim, parked } = resume;
  const adopted: AdoptedRelayViews = { state: null, sessions: null, agentPool: null, sessionStates: new Map() };
  if (
    parked.compactWire !== state.compactWire ||
    parked.transcriptPrepend !== (state.transcriptPrepend === true) ||
    parked.listDelta !== state.listDelta
  ) {
    return adopted;
  }
  if (
    parked.stateEncoder &&
    state.stateLane?.pristine() &&
    (await viewResumeLaneMatches(parked.stateEncoder.resumePoint(), claim.state))
  ) {
    adopted.state = parked.stateEncoder;
  }
  if (state.listDelta) {
    if (
      !state.sessionsEncoder.emitted &&
      (await viewResumeLaneMatches(parked.sessionsEncoder.resumePoint(), claim.sessions))
    ) {
      adopted.sessions = parked.sessionsEncoder;
    }
    if (
      !state.agentPoolEncoder.emitted &&
      (await viewResumeLaneMatches(parked.agentPoolEncoder.resumePoint(), claim.agentPool))
    ) {
      adopted.agentPool = parked.agentPoolEncoder;
    }
  }
  for (const [sessionId, encoder] of parked.sessionStateEncoders) {
    if (!state.visibleSessionIds.has(sessionId) || state.sessionStateEncoders.get(sessionId)?.emitted) continue;
    if (await viewResumeLaneMatches(encoder.resumePoint(), claim.sessionStates.get(sessionId))) {
      adopted.sessionStates.set(sessionId, encoder);
    }
  }
  return adopted;
}

/** Enqueue all full baselines before reopening live publication. Encryption
 * preserves that order; the RPC receipt follows the completed socket writes.
 * No transcript payload is combined into one oversized multi-session frame.
 * A resumed lane sends only its delta from what the phone already holds. */
export async function synchronizeRelayViews(
  host: DesktopService,
  state: RelayViewSyncState,
  current: () => boolean,
  send: (frame: unknown) => Promise<void>,
  retained: ReadonlySet<string> | null = null,
  resume: RelayViewResume | null = null
): Promise<void> {
  state.syncing = true;
  const writes: Promise<void>[] = [];
  const sendBaseline = (frame: unknown): Promise<void> => {
    if (!retained) return send(frame);
    const text = JSON.stringify(frame);
    // Oversized baselines still transfer normally; the phone cannot retain
    // them, so neither a key nor the wrapper buys anything.
    if (text.length * 2 > MAX_VIEW_BASELINE_BYTES) return send(frame);
    const key = createHash('sha256').update(text).digest('hex');
    return send({
      event: VIEW_BASELINE_EVENT,
      payload: retained.has(key) ? { key } : { key, frame },
    });
  };
  // A resumed delta is never retained as a baseline: it only means anything
  // on top of the state this phone already holds.
  const sendDelta = (frame: unknown, nothing: boolean): Promise<void> => (nothing ? Promise.resolve() : send(frame));
  try {
    const adopted = resume ? await adoptParkedViews(state, resume) : null;
    await synchronizeViewSnapshot(host, [...state.visibleSessionIds], (snapshot) => {
      if (!current()) throw new Error(VIEW_REPLACED);
      state.sessionStateEncoders.clear();
      if (adopted?.sessions) state.sessionsEncoder = adopted.sessions;
      else state.sessionsEncoder.reset();
      if (adopted?.agentPool) state.agentPoolEncoder = adopted.agentPool;
      else state.agentPoolEncoder.reset();
      if (state.stateLane) {
        writes.push(
          adopted?.state
            ? state.stateLane.resume(snapshot.snapshot, adopted.state, send)
            : state.stateLane.reset(snapshot.snapshot, sendBaseline)
        );
      }
      for (const [event, encoder, items, resumed] of [
        ['sessions', state.sessionsEncoder, snapshot.sessions, !!adopted?.sessions],
        ['agentPool', state.agentPoolEncoder, snapshot.agents, !!adopted?.agentPool],
      ] as const) {
        const payload = state.listDelta ? (encoder as KeyedListDeltaEncoder<unknown>).encode(items) : items;
        writes.push(
          resumed ? sendDelta({ event, payload }, isNoListDelta(payload)) : sendBaseline({ event, payload })
        );
      }
      for (const update of snapshot.sessionStates) {
        const resumed = adopted?.sessionStates.get(update.sessionId);
        const encoder =
          resumed ??
          createSnapshotDeltaEncoder({
            compact: state.compactWire,
            prepend: state.transcriptPrepend === true,
          });
        state.sessionStateEncoders.set(update.sessionId, encoder);
        const wire = encoder.encode(remoteTranscriptSnapshot(update.snapshot));
        if (!resumed) {
          writes.push(sendBaseline({ event: 'sessionState', payload: { ...update, wire, snapshot: undefined } }));
          continue;
        }
        // This envelope carries no compact marker of its own, so the patch
        // states its shape itself; a full or null wire needs none.
        if (
          state.compactWire &&
          wire &&
          typeof wire === 'object' &&
          Object.hasOwn(wire, 'r') &&
          !Object.hasOwn(wire, 'items') &&
          !Object.hasOwn(wire, '__itemsRevision')
        ) {
          markCompactWire(wire as Record<string, unknown>);
        }
        writes.push(
          sendDelta({ event: 'sessionState', payload: { ...update, wire, snapshot: undefined } }, isNoDelta(wire))
        );
      }
      // All baseline encryptions are already queued. A later live frame now
      // follows them, including a change occurring before the receipt arrives.
      state.syncing = false;
      for (const write of writes) void write.catch(() => undefined);
    });
    await Promise.all(writes);
    if (!current()) throw new Error(VIEW_REPLACED);
  } finally {
    state.syncing = false;
  }
}
