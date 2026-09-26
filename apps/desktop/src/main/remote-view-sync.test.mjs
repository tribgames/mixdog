import assert from 'node:assert/strict';
import test from 'node:test';
import { registerAndSynchronizeRelayViews } from './remote-view-sync.ts';
import { createRelayClientRegistry, VIEW_RESUME_TTL_MS } from './remote-relay-clients.ts';
import { encodeRelayClientSessionState } from './remote-relay-session-state.ts';
import { createRemoteStateLane } from './remote-state-lane.ts';
import { remoteTranscriptSnapshot } from './remote-transcript.ts';
import { createSnapshotDeltaDecoder, isNoDelta } from './state-delta.ts';
import { createKeyedListDeltaDecoder, isNoListDelta } from '../shared/list-delta.ts';
import { createRemoteViewBaselineCache } from '../shared/remote-view-baseline.ts';
import { createViewResumeRequest, readViewResumeGrant, readViewResumeRequest } from '../shared/remote-view-resume.ts';
import { markCompactPayload } from '../renderer/remote-compact-frames.ts';

const IDS = ['lead', 'side'];
const plain = (value) => JSON.parse(JSON.stringify(value));
/** The state lane coalesces behind its in-flight frame; let it drain. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The desktop side: one host, one client registry with a controllable clock. */
function fixture() {
  const item = (id, size = 900) => ({ id, kind: 'assistant', text: `${id} `.repeat(size / 4), thinkingBlocks: ['x'] });
  const history = Array.from({ length: 120 }, (_, index) => item(`lead-${index}`));
  const host = {
    now: 0,
    state: { sessionId: 'lead', status: 'idle', items: [item('app-0', 200)], streamingTail: null },
    sessions: [
      { id: 'lead', title: 'Lead', working: true },
      { id: 'side', title: 'Side', working: false },
    ],
    agents: [{ sessionId: 'worker', tag: 'worker', ownerSessionId: 'lead', status: 'running' }],
    transcripts: {
      lead: {
        sessionId: 'lead',
        busy: true,
        items: history,
        streamingTail: { id: 'tail-1', kind: 'assistant', text: 'Str' },
      },
      side: { sessionId: 'side', busy: false, items: [item('side-0'), item('side-1')], streamingTail: null },
    },
    getSnapshot: () => host.state,
    listSessions: async () => host.sessions,
    listAgentPool: async () => host.agents,
    subscribeSessions: () => () => {},
    subscribeAgentPool: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (ids, deliver) =>
      deliver(ids.map((sessionId) => ({ sessionId, snapshot: host.transcripts[sessionId], frameSource: 'replay' }))),
  };
  const registry = createRelayClientRegistry({
    host,
    sendEnvelope: () => {},
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
    now: () => host.now,
  });
  return { host, registry, item };
}

/** The phone side, decoding exactly as remote-shim.ts does. */
function createPhone() {
  const cache = createRemoteViewBaselineCache();
  const stateDecoder = createSnapshotDeltaDecoder();
  const sessionsDecoder = createKeyedListDeltaDecoder();
  const agentPoolDecoder = createKeyedListDeltaDecoder();
  const sessionDecoders = new Map();
  const view = { state: null, sessions: null, agents: null, transcripts: new Map() };
  const decoded = (result) => {
    assert.equal(result.ok, true, 'a delta must apply to exactly the state it was encoded against');
    return result;
  };
  const apply = (frame) => {
    if (frame.event === 'viewBaseline') return apply(cache.restore(frame.payload));
    if (frame.e === 'S') {
      markCompactPayload(frame.w);
      view.state = decoded(stateDecoder.decode(frame.w)).snapshot;
    } else if (frame.event === 'state') {
      view.state = decoded(stateDecoder.decode(frame.payload)).snapshot;
    } else if (frame.event === 'sessions') {
      view.sessions = decoded(sessionsDecoder.decode(frame.payload)).items;
    } else if (frame.event === 'agentPool') {
      view.agents = decoded(agentPoolDecoder.decode(frame.payload)).items;
    } else if (frame.event === 'sessionState' || frame.e === 'T') {
      const sessionId = frame.payload?.sessionId ?? frame.n;
      const wire = frame.payload?.wire ?? frame.w;
      if (frame.e === 'T') markCompactPayload(wire);
      let decoder = sessionDecoders.get(sessionId);
      if (!decoder) sessionDecoders.set(sessionId, (decoder = createSnapshotDeltaDecoder()));
      view.transcripts.set(sessionId, decoded(decoder.decode(wire)).snapshot);
    }
  };
  return {
    cache,
    view,
    apply,
    resumeRequest: (token) =>
      createViewResumeRequest(
        token,
        token
          ? {
              state: stateDecoder.resumePoint(),
              sessions: sessionsDecoder.resumePoint(),
              agentPool: agentPoolDecoder.resumePoint(),
              sessionStates: IDS.map((id) => [id, sessionDecoders.get(id)?.resumePoint() ?? null]),
            }
          : null
      ),
  };
}

function harness() {
  const f = fixture();
  let clients = 0;
  /** A relay leg for `phone`: frames reach it after a JSON round trip, the
   *  way encryption delivers them, unless the test loses them in flight. */
  const connect = (phone) => {
    const clientId = `client-${++clients}`;
    const state = f.registry.open(clientId, {});
    clearTimeout(state.handshakeTimer);
    Object.assign(state, {
      channel: {},
      viewSync: true,
      compactWire: true,
      listDelta: true,
      transcriptPaging: true,
      transcriptPrepend: true,
    });
    const leg = { clientId, state, lose: false, bytes: 0 };
    leg.deliver = (frame) => {
      if (leg.lose) return;
      const text = JSON.stringify(frame);
      leg.bytes += text.length;
      phone.apply(JSON.parse(text));
    };
    state.stateLane = createRemoteStateLane(true, async (payload) => leg.deliver(payload));
    leg.sync = async (resume) => {
      const offer = phone.cache.begin();
      const frames = [];
      try {
        const value = await registerAndSynchronizeRelayViews(
          f.host,
          clientId,
          state,
          resume === undefined ? [IDS, offer.offer] : [IDS, offer.offer, resume],
          () => f.registry.attached(clientId, state),
          async (frame) => {
            frames.push(plain(frame));
            leg.deliver(frame);
          },
          f.registry.takeParkedViews
        );
        return { value, frames, bytes: frames.reduce((total, frame) => total + JSON.stringify(frame).length, 0) };
      } finally {
        offer.finish();
      }
    };
    /** One live transcript publication, as the relay fan-out sends it. */
    leg.publish = (sessionId) => {
      const wire = encodeRelayClientSessionState(
        state.sessionStateEncoders,
        sessionId,
        f.host.transcripts[sessionId],
        true,
        true
      );
      if (!isNoDelta(wire)) leg.deliver({ e: 'T', s: 1, n: sessionId, w: wire });
    };
    /** A live roster push, as remote-relay-catalog sends it. */
    leg.publishSessions = () => {
      const payload = state.sessionsEncoder.encode(f.host.sessions);
      if (!isNoListDelta(payload)) leg.deliver({ event: 'sessions', payload });
    };
    leg.drop = () => f.registry.remove(clientId, true);
    return leg;
  };
  /** Everything the phone shows equals what a fresh full recovery shows. */
  const assertSynchronized = (phone) => {
    assert.deepEqual(plain(phone.view.state), plain(f.host.state));
    assert.deepEqual(phone.view.sessions, plain(f.host.sessions));
    assert.deepEqual(phone.view.agents, plain(f.host.agents));
    for (const id of IDS) {
      assert.deepEqual(
        plain(phone.view.transcripts.get(id)),
        plain(remoteTranscriptSnapshot(f.host.transcripts[id])),
        `${id} transcript`
      );
    }
  };
  /** The host moves on while the phone is away: a streaming turn grows, a
   *  row lands, the roster flips. */
  const advance = (step) => {
    const lead = f.host.transcripts.lead;
    f.host.transcripts.lead = {
      ...lead,
      items: [...lead.items, f.item(`lead-answer-${step}`, 120)],
      streamingTail: { ...lead.streamingTail, text: `${lead.streamingTail.text} more ${step}` },
    };
    f.host.sessions = [{ ...f.host.sessions[0], working: step % 2 === 0 }, f.host.sessions[1]];
    f.host.state = { ...f.host.state, status: `step-${step}` };
  };
  return { ...f, connect, assertSynchronized, advance };
}

test('a short reconnect resumes every lane with deltas only and reconstructs the identical view', async () => {
  const h = harness();
  const phone = createPhone();
  const first = h.connect(phone);
  const joined = await first.sync(await phone.resumeRequest(null));
  const token = readViewResumeGrant(joined.value);
  assert.ok(token, 'a resume-capable phone is issued a token');
  h.assertSynchronized(phone);
  for (let step = 1; step <= 3; step++) {
    h.advance(step);
    first.publish('lead');
    first.publishSessions();
    first.state.stateLane.publish(h.host.state);
    await settle();
  }
  h.assertSynchronized(phone);
  assert.equal(first.drop(), true);

  h.advance(4);
  h.host.transcripts.side = { ...h.host.transcripts.side, busy: true };
  const second = h.connect(phone);
  const resumed = await second.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  assert.ok(
    resumed.frames.every((frame) => frame.event !== 'viewBaseline'),
    'no lane falls back to a full baseline'
  );
  const nextToken = readViewResumeGrant(resumed.value);
  assert.ok(nextToken && nextToken !== token, 'the next connection is parked under a fresh token');
  assert.equal(h.registry.takeParkedViews(token), null, 'a parked set is adopted at most once');

  // What the same reconnect costs a phone that cannot resume.
  const fresh = createPhone();
  const full = await h.connect(fresh).sync();
  h.assertSynchronized(fresh);
  assert.ok(resumed.bytes * 20 < full.bytes, `resumed ${resumed.bytes} bytes vs ${full.bytes} full`);

  // The adopted encoders keep streaming into the kept decoders.
  h.advance(5);
  second.publish('lead');
  second.publishSessions();
  second.state.stateLane.publish(h.host.state);
  await settle();
  h.assertSynchronized(phone);
});

test('a frame lost in flight during the disconnect falls back to a full baseline for that lane only', async () => {
  const h = harness();
  const phone = createPhone();
  const first = h.connect(phone);
  const token = readViewResumeGrant((await first.sync(await phone.resumeRequest(null))).value);
  h.advance(1);
  first.lose = true; // Sent by the desktop, never received by the phone.
  first.publish('lead');
  first.drop();

  const second = h.connect(phone);
  const resumed = await second.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  const baselines = resumed.frames
    .filter((frame) => frame.event === 'viewBaseline')
    .map((frame) => frame.payload.frame);
  assert.deepEqual(
    baselines.map((frame) => frame.payload?.sessionId ?? frame.event),
    ['lead'],
    'only the lane that lost a frame is rebuilt'
  );

  // Same revision, different content: a session re-registered within the
  // connection restarts its encoder, and that encoder's first (full) frame is
  // lost. The digest, not the revision, refuses it.
  const token2 = readViewResumeGrant(resumed.value);
  second.state.sessionStateEncoders.delete('side');
  h.host.transcripts.side = { ...h.host.transcripts.side, items: [h.item('side-replaced')] };
  second.lose = true;
  second.publish('side');
  const claim = readViewResumeRequest(await phone.resumeRequest(token2));
  assert.equal(
    claim.sessionStates.get('side').revision,
    second.state.sessionStateEncoders.get('side').resumePoint().revision
  );
  second.drop();
  const third = h.connect(phone);
  const recovered = await third.sync(await phone.resumeRequest(token2));
  h.assertSynchronized(phone);
  assert.ok(
    recovered.frames.some(
      (frame) => frame.event === 'viewBaseline' && frame.payload.frame?.payload?.sessionId === 'side'
    )
  );
});

test('expired, foreign, revoked and unauthenticated lanes never resume', async () => {
  const h = harness();
  const phone = createPhone();
  const first = h.connect(phone);
  const token = readViewResumeGrant((await first.sync(await phone.resumeRequest(null))).value);
  first.drop();
  h.host.now += VIEW_RESUME_TTL_MS;
  const expired = await h.connect(phone).sync(await phone.resumeRequest(token));
  assert.equal(expired.frames.filter((frame) => frame.event === 'viewBaseline').length, 5, 'every lane is rebuilt');
  h.assertSynchronized(phone);

  // Another paired browser cannot name this phone's lanes: it never saw the
  // token, and a guessed one finds nothing.
  const owner = h.connect(phone);
  const ownerToken = readViewResumeGrant((await owner.sync(await phone.resumeRequest(null))).value);
  owner.drop();
  const intruder = createPhone();
  const foreign = await h.connect(intruder).sync(await intruder.resumeRequest('A'.repeat(43)));
  assert.equal(foreign.frames.filter((frame) => frame.event === 'viewBaseline').length, 5);
  h.assertSynchronized(intruder);
  assert.ok(h.registry.takeParkedViews(ownerToken), 'a foreign attempt leaves the owner parked set alone');

  const revoked = h.connect(phone);
  const revokedToken = readViewResumeGrant((await revoked.sync(await phone.resumeRequest(null))).value);
  revoked.drop();
  h.registry.dropParkedViews();
  assert.equal(h.registry.takeParkedViews(revokedToken), null, 'unpair drops parked lanes');

  const unauthenticated = h.connect(phone);
  const unauthenticatedToken = readViewResumeGrant((await unauthenticated.sync(await phone.resumeRequest(null))).value);
  unauthenticated.state.channel = null;
  unauthenticated.drop();
  assert.equal(h.registry.takeParkedViews(unauthenticatedToken), null);

  const replaced = h.connect(phone);
  const replacedToken = readViewResumeGrant((await replaced.sync(await phone.resumeRequest(null))).value);
  h.registry.remove(replaced.clientId); // Desktop-initiated close: nothing parks.
  assert.equal(h.registry.takeParkedViews(replacedToken), null);

  const redialed = h.connect(phone);
  const redialedToken = readViewResumeGrant((await redialed.sync(await phone.resumeRequest(null))).value);
  redialed.drop();
  h.registry.resetDeltas(); // The desktop's own relay leg was replaced.
  assert.equal(h.registry.takeParkedViews(redialedToken), null);
});

test('a phone without a resume request keeps the full-baseline recovery and answer exactly', async () => {
  const h = harness();
  const phone = createPhone();
  const leg = h.connect(phone);
  const legacy = await leg.sync();
  assert.equal(legacy.value, true);
  assert.equal(leg.state.viewResumeToken, undefined);
  assert.equal(legacy.frames.filter((frame) => frame.event === 'viewBaseline').length, 5);
  h.assertSynchronized(phone);
  // An unreadable resume parameter is ignored, never an error.
  const malformed = await leg.sync({ version: 2, token: 7 });
  assert.equal(malformed.value, true);
  h.assertSynchronized(phone);
  leg.drop();
  const again = h.connect(phone);
  const reconnect = await again.sync();
  assert.equal(reconnect.value, true);
  assert.equal(reconnect.frames.filter((frame) => frame.event === 'viewBaseline').length, 5);
  assert.ok(reconnect.frames.every((frame) => !Object.hasOwn(frame.payload, 'frame')), 'unchanged keys still reuse');
  h.assertSynchronized(phone);
});
