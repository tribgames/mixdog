import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { registerAndSynchronizeRelayViews } from './remote-view-sync.ts';
import { createRelayClientRegistry, VIEW_RESUME_TTL_MS } from './remote-relay-clients.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { createRelayCatalogs } from './remote-relay-catalog.ts';
import { createRelaySessionWiring } from './remote-relay-session-wiring.ts';
import { encodeRelayClientSessionState } from './remote-relay-session-state.ts';
import { remoteTranscriptSnapshot } from './remote-transcript.ts';
import { createSnapshotDeltaDecoder, DELTA_HISTORY_REVISIONS, isNoDelta } from './state-delta.ts';
import { createKeyedListDeltaDecoder, isNoListDelta } from '../shared/list-delta.ts';
import { createRemoteViewBaselineCache } from '../shared/remote-view-baseline.ts';
import {
  createRelayE2EEClientHandshake,
  generateRelayE2EEServerIdentity,
  relayE2EEPairingMaterial,
} from '../shared/remote-e2ee.ts';
import { createViewResumeRequest, readViewResumeGrant, readViewResumeRequest } from '../shared/remote-view-resume.ts';
import { markCompactPayload } from '../renderer/remote-compact-frames.ts';
import { waitForQuiet, waitUntil } from '../../../../src/runtime/shared/wait-until.test-support.mjs';

const IDS = ['lead', 'side'];
const plain = (value) => JSON.parse(JSON.stringify(value));
/** The state lane coalesces behind its in-flight frame; wait until the phone's
 *  state has caught up with the host's. */
const stateDelivered = (phone, host) =>
  waitUntil(() => isDeepStrictEqual(plain(phone.view.state), plain(host.state)), { message: 'state lane drained' });
const baselineCount = (sync) => sync.frames.filter((frame) => frame.event === 'viewBaseline').length;
const percent = (part, whole) => `${((100 * part) / whole).toFixed(1)}%`;

/** The desktop side: one host, one client registry with a controllable clock. */
function fixture() {
  const item = (id, size = 900) => ({ id, kind: 'assistant', text: `${id} `.repeat(size / 4), thinkingBlocks: ['x'] });
  const history = Array.from({ length: 120 }, (_, index) => item(`lead-${index}`));
  const prompts = Array.from({ length: 50 }, (_, index) => `prompt ${index} ${'p'.repeat(1200)}`);
  // A long-lived install: the roster is the largest list a phone holds.
  const roster = Array.from({ length: 200 }, (_, index) => ({
    id: `past-${index}`,
    title: `Past session ${index}`,
    preview: `Preview of what happened in session ${index} `.repeat(4),
    cwd: `/work/project-${index % 7}`,
    working: false,
  }));
  const envelopes = [];
  const host = {
    now: 0,
    state: {
      sessionId: 'lead',
      status: 'idle',
      items: [item('app-0', 200)],
      streamingTail: null,
      promptHistoryList: prompts,
    },
    sessions: [{ id: 'lead', title: 'Lead', working: true }, { id: 'side', title: 'Side', working: false }, ...roster],
    agents: [{ sessionId: 'worker', tag: 'worker', ownerSessionId: 'lead', status: 'running' }],
    transcripts: {
      lead: {
        sessionId: 'lead',
        busy: true,
        items: history,
        streamingTail: { id: 'tail-1', kind: 'assistant', text: 'Str' },
        promptHistoryList: prompts,
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
    sendEnvelope: (envelope) => envelopes.push(envelope),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
    now: () => host.now,
  });
  return { host, registry, item, envelopes };
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
      if (!decoder) {
        decoder = createSnapshotDeltaDecoder();
        sessionDecoders.set(sessionId, decoder);
      }
      view.transcripts.set(sessionId, decoded(decoder.decode(wire)).snapshot);
    }
  };
  return {
    cache,
    view,
    apply,
    /** As remote-shim-sync.ts claims: each decoder remembers what it claimed. */
    resumeRequest: (token) =>
      createViewResumeRequest(
        token,
        token
          ? {
              state: stateDecoder.claim(),
              sessions: sessionsDecoder.claim(),
              agentPool: agentPoolDecoder.claim(),
              sessionStates: IDS.map((id) => [id, sessionDecoders.get(id)?.claim() ?? null]),
            }
          : null
      ),
  };
}

async function harness() {
  const f = fixture();
  const identity = await generateRelayE2EEServerIdentity();
  const pairing = relayE2EEPairingMaterial(identity);
  const legs = new Map();
  const sendEncryptedFrame = async (clientId, payload) => legs.get(clientId)?.deliver(payload);
  const live = (clientId, state) => f.registry.attached(clientId, state);
  // The real handshake and the real live publishers, with their own guards.
  const lifecycle = createRelayClientLifecycle({
    clients: f.registry,
    e2eeIdentity: identity,
    pairing,
    relayBinaryFrames: () => false,
    viewSyncSupported: () => true,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (envelope) => f.envelopes.push(envelope),
    sendEncryptedFrame,
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  const catalogs = createRelayCatalogs({ host: f.host, clients: f.registry.clients, live, sendEncryptedFrame });
  const wiring = createRelaySessionWiring({
    host: f.host,
    clients: f.registry,
    catalogs,
    sessionStates: {},
    pushStore: {},
    live,
    closed: () => false,
    sendEncryptedFrame,
    broadcastEncrypted: () => {},
  });
  let clients = 0;
  /** A relay leg for `phone`, opened through the E2EE handshake: frames reach
   *  it after a JSON round trip, the way encryption delivers them, unless the
   *  test loses them or holds them in flight. `bytes` counts everything the
   *  phone received on this leg. */
  const connect = async (phone) => {
    const clientId = `client-${++clients}`;
    const leg = { clientId, lose: false, inFlight: null, bytes: 0, wires: [], ready: false };
    legs.set(clientId, leg);
    const receive = (text) => {
      leg.bytes += text.length;
      const frame = JSON.parse(text);
      if (frame.type === 'e2ee-ready') leg.ready = true;
      if (frame.e === 'S') leg.wires.push(plain(frame.w));
      phone.apply(frame);
    };
    leg.deliver = (frame) => {
      if (leg.lose) return;
      const text = JSON.stringify(frame);
      if (leg.inFlight) leg.inFlight.push(text);
      else receive(text);
    };
    /** Frames sent from now on are in flight until `arrive()`. */
    leg.hold = () => {
      leg.inFlight = [];
    };
    leg.arrive = () => {
      const texts = leg.inFlight ?? [];
      leg.inFlight = null;
      for (const text of texts) receive(text);
    };
    lifecycle.open(clientId, '');
    const challenge = JSON.parse(
      f.envelopes.findLast((entry) => entry.clientId === clientId && entry.type === 'frame').data
    );
    const { hello } = await createRelayE2EEClientHandshake(pairing, challenge);
    lifecycle.receive(
      clientId,
      f.registry.get(clientId),
      JSON.stringify({ ...hello, viewSync: 1, promptHistoryPatch: 2 })
    );
    await waitUntil(() => leg.ready, { message: 'handshake' });
    const state = f.registry.get(clientId);
    leg.state = state;
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
        true,
        true
      );
      if (isNoDelta(wire)) return;
      leg.wires.push(plain(wire));
      leg.deliver({ e: 'T', s: 1, n: sessionId, w: wire });
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
    // Each step is a submit: newest-first, capped at 50.
    const promptHistoryList = [`submit ${step}`, ...lead.promptHistoryList].slice(0, 50);
    f.host.transcripts.lead = {
      ...lead,
      items: [...lead.items, f.item(`lead-answer-${step}`, 120)],
      streamingTail: { ...lead.streamingTail, text: `${lead.streamingTail.text} more ${step}` },
      promptHistoryList,
    };
    f.host.sessions = [{ ...f.host.sessions[0], working: step % 2 === 0 }, ...f.host.sessions.slice(1)];
    f.host.state = { ...f.host.state, status: `step-${step}`, promptHistoryList };
  };
  /** A desktop at work publishes its state and rosters continuously, through
   *  the same guarded publishers the relay uses — whether or not anything
   *  changed for a given phone. */
  const busy = async () => {
    wiring.broadcastState(f.host.state);
    catalogs.publishSessions(f.host.sessions);
    catalogs.publishAgentPool(f.host.agents);
    await waitForQuiet(() => [...legs.values()].reduce((total, leg) => total + leg.bytes, 0));
  };
  return { ...f, connect, assertSynchronized, advance, busy };
}

test('a short reconnect resumes every lane with deltas only and reconstructs the identical view', async () => {
  const h = await harness();
  const phone = createPhone();
  const first = await h.connect(phone);
  const joined = await first.sync(await phone.resumeRequest(null));
  const token = readViewResumeGrant(joined.value);
  assert.ok(token, 'a resume-capable phone is issued a token');
  h.assertSynchronized(phone);
  for (let step = 1; step <= 3; step++) {
    h.advance(step);
    first.publish('lead');
    first.publishSessions();
    first.state.stateLane.publish(h.host.state);
    await stateDelivered(phone, h.host);
  }
  h.assertSynchronized(phone);
  // Every submit reached both lanes as a head patch, never the whole list.
  const submits = first.wires.filter((wire) => wire.sl);
  assert.equal(submits.length, 6);
  for (const wire of first.wires) assert.equal(Object.hasOwn(wire.sc ?? {}, 'promptHistoryList'), false);
  assert.equal(first.drop(), true);

  h.advance(4);
  h.host.transcripts.side = { ...h.host.transcripts.side, busy: true };
  const second = await h.connect(phone);
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
  const full = await (await h.connect(fresh)).sync();
  h.assertSynchronized(fresh);
  assert.ok(resumed.bytes * 20 < full.bytes, `resumed ${resumed.bytes} bytes vs ${full.bytes} full`);

  // The adopted encoders keep streaming into the kept decoders.
  h.advance(5);
  second.publish('lead');
  second.publishSessions();
  second.state.stateLane.publish(h.host.state);
  await stateDelivered(phone, h.host);
  h.assertSynchronized(phone);
});

test('a cold sync sends the visible transcripts before the roster lists', async () => {
  const h = await harness();
  const phone = createPhone();
  const { frames } = await (await h.connect(phone)).sync();
  h.assertSynchronized(phone);
  const events = frames.map((frame) => (frame.event === 'viewBaseline' ? frame.payload.frame?.event : frame.event));
  const lastTranscript = events.lastIndexOf('sessionState');
  assert.ok(lastTranscript >= 0, 'the visible transcripts are sent');
  assert.ok(lastTranscript < events.indexOf('sessions'), `order: ${events.join(',')}`);
  assert.ok(lastTranscript < events.indexOf('agentPool'), `order: ${events.join(',')}`);
});

test('a frame lost in flight during the disconnect is resent as a delta; other content under its revision is rebuilt', async (t) => {
  const h = await harness();
  const phone = createPhone();
  const first = await h.connect(phone);
  const token = readViewResumeGrant((await first.sync(await phone.resumeRequest(null))).value);
  h.advance(1);
  first.lose = true; // Sent by the desktop, never received by the phone.
  first.publish('lead');
  first.drop();

  const second = await h.connect(phone);
  const resumed = await second.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  t.diagnostic(`in-window reconnect after a lost frame: sync ${resumed.bytes} B`);
  assert.equal(baselineCount(resumed), 0, 'the encoder still holds the revision the phone applied');

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
  const third = await h.connect(phone);
  const recovered = await third.sync(await phone.resumeRequest(token2));
  h.assertSynchronized(phone);
  assert.ok(
    recovered.frames.some(
      (frame) => frame.event === 'viewBaseline' && frame.payload.frame?.payload?.sessionId === 'side'
    )
  );
});

test('expired, foreign, revoked and unauthenticated lanes never resume', async () => {
  const h = await harness();
  const phone = createPhone();
  const first = await h.connect(phone);
  const token = readViewResumeGrant((await first.sync(await phone.resumeRequest(null))).value);
  first.drop();
  h.host.now += VIEW_RESUME_TTL_MS;
  const expired = await (await h.connect(phone)).sync(await phone.resumeRequest(token));
  assert.equal(expired.frames.filter((frame) => frame.event === 'viewBaseline').length, 5, 'every lane is rebuilt');
  h.assertSynchronized(phone);

  // Another paired browser cannot name this phone's lanes: it never saw the
  // token, and a guessed one finds nothing.
  const owner = await h.connect(phone);
  const ownerToken = readViewResumeGrant((await owner.sync(await phone.resumeRequest(null))).value);
  owner.drop();
  const intruder = createPhone();
  const foreign = await (await h.connect(intruder)).sync(await intruder.resumeRequest('A'.repeat(43)));
  assert.equal(foreign.frames.filter((frame) => frame.event === 'viewBaseline').length, 5);
  h.assertSynchronized(intruder);
  assert.ok(h.registry.takeParkedViews(ownerToken), 'a foreign attempt leaves the owner parked set alone');

  const revoked = await h.connect(phone);
  const revokedToken = readViewResumeGrant((await revoked.sync(await phone.resumeRequest(null))).value);
  revoked.drop();
  h.registry.dropParkedViews();
  assert.equal(h.registry.takeParkedViews(revokedToken), null, 'unpair drops parked lanes');

  const unauthenticated = await h.connect(phone);
  const unauthenticatedToken = readViewResumeGrant((await unauthenticated.sync(await phone.resumeRequest(null))).value);
  unauthenticated.state.channel = null;
  unauthenticated.drop();
  assert.equal(h.registry.takeParkedViews(unauthenticatedToken), null);

  const replaced = await h.connect(phone);
  const replacedToken = readViewResumeGrant((await replaced.sync(await phone.resumeRequest(null))).value);
  h.registry.remove(replaced.clientId); // Desktop-initiated close: nothing parks.
  assert.equal(h.registry.takeParkedViews(replacedToken), null);

  const redialed = await h.connect(phone);
  const redialedToken = readViewResumeGrant((await redialed.sync(await phone.resumeRequest(null))).value);
  redialed.drop();
  h.registry.resetDeltas(); // The desktop's own relay leg was replaced.
  assert.equal(h.registry.takeParkedViews(redialedToken), null);
});

test('a phone without a resume request keeps the full-baseline recovery and answer exactly', async () => {
  const h = await harness();
  const phone = createPhone();
  const leg = await h.connect(phone);
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
  const again = await h.connect(phone);
  const reconnect = await again.sync();
  assert.equal(reconnect.value, true);
  assert.equal(reconnect.frames.filter((frame) => frame.event === 'viewBaseline').length, 5);
  assert.ok(
    reconnect.frames.every((frame) => !Object.hasOwn(frame.payload, 'frame')),
    'unchanged keys still reuse'
  );
  h.assertSynchronized(phone);
});

/** Frames the desktop sends with no further signal: let them settle. */
const settled = () => waitForQuiet(() => 0);

/** A phone that opened (cold: no token, no cached roster), followed a few
 *  live updates and holds every one of them. */
async function joinedPhone(h) {
  const phone = createPhone();
  const first = await h.connect(phone);
  const joined = await first.sync(await phone.resumeRequest(null));
  const fullOpen = first.bytes;
  const token = readViewResumeGrant(joined.value);
  for (let step = 1; step <= 2; step++) {
    h.advance(step);
    first.publish('lead');
    first.publishSessions();
    first.state.stateLane.publish(h.host.state);
    await stateDelivered(phone, h.host);
  }
  h.assertSynchronized(phone);
  return { phone, first, token, fullOpen };
}

test('a reconnect with no missed updates costs under 5% of a full open, also while the desktop publishes', async (t) => {
  const h = await harness();
  const { phone, first, token, fullOpen } = await joinedPhone(h);
  first.drop();

  const idle = await h.connect(phone);
  const idleSync = await idle.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  idle.drop();

  // A turn streaming on the desktop: state and roster publications keep
  // coming between this leg's handshake and its view sync.
  const busy = await h.connect(phone);
  await h.busy();
  const busySync = await busy.sync(await phone.resumeRequest(readViewResumeGrant(idleSync.value)));
  h.assertSynchronized(phone);
  t.diagnostic(
    `full open ${fullOpen} B; idle reconnect ${idle.bytes} B (${percent(idle.bytes, fullOpen)}); ` +
      `busy reconnect ${busy.bytes} B (${percent(busy.bytes, fullOpen)})`
  );
  assert.equal(baselineCount(idleSync), 0);
  assert.equal(baselineCount(busySync), 0, 'no lane is rebuilt');
  assert.ok(idle.bytes * 20 < fullOpen, `idle reconnect ${idle.bytes} B of ${fullOpen} B`);
  assert.ok(busy.bytes * 20 < fullOpen, `busy reconnect ${busy.bytes} B of ${fullOpen} B`);

  // The continued lanes keep streaming into the kept decoders.
  h.advance(3);
  busy.publish('lead');
  busy.publishSessions();
  busy.state.stateLane.publish(h.host.state);
  await stateDelivered(phone, h.host);
  h.assertSynchronized(phone);
});

test('a reconnect after more than two minutes resumes with deltas, including frames lost in flight (gap)', async (t) => {
  const h = await harness();
  const { phone, first, token, fullOpen } = await joinedPhone(h);
  // Sent by the desktop as the leg died, never received by the phone.
  first.lose = true;
  h.advance(3);
  first.publish('lead');
  first.publishSessions();
  first.state.stateLane.publish(h.host.state);
  await settled();
  first.drop();
  h.host.now += 3 * 60_000;
  h.advance(4);

  const later = await h.connect(phone);
  const resumed = await later.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  t.diagnostic(
    `full open ${fullOpen} B; gap reconnect after 3 min ${later.bytes} B (${percent(later.bytes, fullOpen)})`
  );
  assert.equal(baselineCount(resumed), 0, 'every lane continues from the revision the phone holds');
  assert.ok(later.bytes * 20 < fullOpen, `gap reconnect ${later.bytes} B of ${fullOpen} B`);
});

test('an unknown revision falls back to a full snapshot for that lane only', async () => {
  const h = await harness();
  const { phone, first, token } = await joinedPhone(h);
  first.drop();
  // A revision this encoder never emitted.
  const request = await phone.resumeRequest(token);
  request.sessionStates = request.sessionStates.map(([id, revision, digest]) =>
    id === 'lead' ? [id, revision + 1000, digest] : [id, revision, digest]
  );
  const second = await h.connect(phone);
  const resumed = await second.sync(request);
  h.assertSynchronized(phone);
  const rebuilt = (sync) =>
    sync.frames
      .filter((frame) => frame.event === 'viewBaseline')
      .map(({ payload }) => payload.frame.payload?.sessionId ?? payload.frame.event);
  assert.deepEqual(rebuilt(resumed), ['lead']);

  // One the encoder no longer retains: more frames were lost than it keeps.
  second.lose = true;
  for (let step = 10; step <= 10 + DELTA_HISTORY_REVISIONS; step++) {
    h.advance(step);
    second.publish('lead');
  }
  second.drop();
  const third = await h.connect(phone);
  const recovered = await third.sync(await phone.resumeRequest(readViewResumeGrant(resumed.value)));
  h.assertSynchronized(phone);
  assert.deepEqual(rebuilt(recovered), ['lead']);
});

test('a resync on a live connection asks only for what it missed, even with frames still in flight', async (t) => {
  const h = await harness();
  const { phone, first, token, fullOpen } = await joinedPhone(h);
  // A wake that doubts the stream while nothing was missed: nothing is sent.
  const quiet = await first.sync(await phone.resumeRequest(token));
  t.diagnostic(`full open ${fullOpen} B; live resync with nothing missed ${quiet.bytes} B`);
  assert.equal(baselineCount(quiet), 0);
  assert.ok(quiet.bytes * 100 < fullOpen, `quiet resync ${quiet.bytes} B`);
  assert.equal(readViewResumeGrant(quiet.value), token, 'the leg keeps its token');
  h.assertSynchronized(phone);

  // The desktop sent updates the phone has not received yet when it claims:
  // its answer rewinds to the claimed revisions and arrives after them.
  first.hold();
  h.advance(3);
  first.publish('lead');
  first.publishSessions();
  first.state.stateLane.publish(h.host.state);
  await settled();
  const claim = await phone.resumeRequest(token);
  h.advance(4);
  const answered = await first.sync(claim);
  first.arrive();
  h.assertSynchronized(phone);
  t.diagnostic(`live resync with frames in flight ${answered.bytes} B (${percent(answered.bytes, fullOpen)})`);
  assert.equal(baselineCount(answered), 0);

  h.advance(5);
  first.publish('lead');
  first.publishSessions();
  first.state.stateLane.publish(h.host.state);
  await stateDelivered(phone, h.host);
  h.assertSynchronized(phone);
});

test('a phone that moved to a new connection retires the half-open one and resumes its lanes', async (t) => {
  const h = await harness();
  const { phone, first, token, fullOpen } = await joinedPhone(h);
  // The old leg died without the relay noticing: still attached, unreachable.
  first.lose = true;
  h.advance(3);
  const second = await h.connect(phone);
  const resumed = await second.sync(await phone.resumeRequest(token));
  h.assertSynchronized(phone);
  t.diagnostic(
    `full open ${fullOpen} B; reconnect past a half-open leg ${second.bytes} B (${percent(second.bytes, fullOpen)})`
  );
  assert.equal(baselineCount(resumed), 0);
  assert.ok(second.bytes * 20 < fullOpen, `moved reconnect ${second.bytes} B of ${fullOpen} B`);
  assert.equal(h.registry.get(first.clientId), undefined, 'the half-open leg is retired');
  assert.ok(h.envelopes.some((entry) => entry.type === 'close-client' && entry.clientId === first.clientId));
});
