import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { world, runSequence, settle, assertNoAuditMiss } = await import('./status-fixture.test-helpers.mjs');
const { _setRowWorkCounterForTest } = await import('./worker-index/row-reads.mjs');
const { emitSessionActivityChange, onSessionActivityChange } = await import(
  '../../../runtime/shared/session-activity-signal.mjs'
);
const { updateSessionStage, markSessionTransportActivity, markSessionStreamDelta, _clearSessionRuntime } =
  await import('../../../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
const { abortSessionTurn } = await import('../../../runtime/agent/orchestrator/session/manager/session-close.mjs');
const { _publishLiveSession } = await import(
  '../../../runtime/agent/orchestrator/session/store/session-observers.mjs'
);
const { createProgressWatchdogRegistry } = await import('../agent-watchdog-registry.mjs');
const { resolveAgentWatchdogPolicy } = await import(
  '../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs'
);
const { executeTodoTool } = await import('../../../runtime/agent/orchestrator/runtime-core/todo-list.mjs');
const { _liveSessions, _clearLiveSession } = await import(
  '../../../runtime/agent/orchestrator/session/store/live-state.mjs'
);


for (const seed of [11, 29]) {
  test(`at 300 rows / 500 tombstones / 30 scopes every answer equals the read before the status sets, announced exactly when it changed (seed ${seed})`, async (t) => {
    const w = await world(t, { seed });
    const all = w.oracle(w.contexts.at(-1));
    assert.ok(all.workers.length >= 100 && all.jobs.length >= 20, `listed: ${all.workers.length}/${all.jobs.length}`);
    const changes = await runSequence(t, w, 240, `seed ${seed}`);
    assert.ok(changes >= 40, `the events changed an answer ${changes} times`);
  });
}

// A wire client (wire.md): subscribe, request the list, buffer frames until
// the answer is applied, then apply frames in seq order; a gap or a new epoch
// resyncs.
function wireClient(agent, context) {
  const state = { workers: new Map(), jobs: new Map() };
  let phase = 'idle';
  let buffered = [];
  let held = null;
  let seq = 0;
  let epoch = '';
  let stop = null;
  let resyncs = 0;
  const apply = (frame) => {
    const list = state[frame.list];
    if (frame.removed) list.delete(frame.id);
    else list.set(frame.id, { order: frame.order, row: frame.row });
    seq = frame.seq;
  };
  const client = {
    connect() {
      stop?.();
      phase = 'awaiting';
      buffered = [];
      stop = agent.onStatusRows(context, (frame) => client.receive(frame));
      held = agent.getStatusList(context);
    },
    disconnect() {
      stop?.();
      stop = null;
      phase = 'idle';
    },
    /** The held list answer lands (it may have raced later frames). */
    answer() {
      if (phase !== 'awaiting') return;
      state.workers = new Map(held.workers.map((entry) => [entry.id, entry]));
      state.jobs = new Map(held.jobs.map((entry) => [entry.id, entry]));
      seq = held.seq;
      epoch = held.epoch;
      phase = 'live';
      for (const frame of buffered.sort((a, b) => a.seq - b.seq)) if (frame.seq > seq) client.receive(frame);
      buffered = [];
    },
    receive(frame) {
      if (phase === 'awaiting') buffered.push(frame);
      if (phase !== 'live') return;
      if (frame.epoch !== epoch || frame.seq !== seq + 1) {
        resyncs += 1;
        client.connect();
        client.answer();
        return;
      }
      apply(frame);
    },
    live: () => phase === 'live',
    lists() {
      const rows = (map) =>
        [...map.values()]
          .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
          .map((entry) => entry.row);
      return { workers: rows(state.workers), jobs: rows(state.jobs) };
    },
    resyncs: () => resyncs,
  };
  return client;
}

test('a client applying the list answer and then the row frames ends with the read, across reconnects and races', async (t) => {
  const w = await world(t, { seed: 5 });
  const { agent, contexts } = w;
  const watched = [contexts[0], contexts[1], contexts[2], contexts.at(-2), contexts.at(-1)];
  const clients = watched.map((context) => wireClient(agent, context));
  for (const client of clients) {
    client.connect();
    client.answer();
  }
  let raced = 0;
  let reconnects = 0;
  for (let step = 0; step < 200; step += 1) {
    t.mock.timers.setTime(Date.now() + 997);
    for (const client of clients) {
      const roll = w.random();
      if (roll < 0.08) {
        // Reconnect: frames sent while away are lost; the list is asked again
        // and its answer arrives after more events.
        client.disconnect();
        reconnects += 1;
      } else if (roll < 0.16 && client.live()) {
        client.connect();
        raced += 1;
      } else if (!client.live()) {
        if (roll < 0.5) client.connect();
        client.answer();
      }
    }
    const name = w.pick(w.eventNames.filter((event) => event !== 'prewarm'));
    await w.events[name]();
    await settle();
    clients.forEach((client, i) => {
      if (!client.live()) return;
      const oracle = w.oracle(watched[i]);
      assert.deepEqual(
        client.lists(),
        { workers: oracle.workers, jobs: oracle.jobs },
        `step ${step} (${name}), client ${i}`
      );
    });
  }
  assert.ok(raced >= 20 && reconnects >= 20, `raced ${raced}, reconnects ${reconnects}`);
  for (const client of clients) assert.equal(client.resyncs(), 0, 'no gap on an attached client');
});

test('a listener that changes status while a frame is delivered still hears every frame once, in seq order', async (t) => {
  const w = await world(t, { seed: 3, rows: 40, tombstones: 10, leads: 2, tagOnly: 0, tasks: 0, statuses: ['running'] });
  const { agent } = w;
  const context = w.contexts[0];
  const listed = agent.getStatus(context).workers.map((row) => row.sessionId);
  assert.ok(listed.length >= 10);
  const heard = [[], []];
  let reacting = 4;
  agent.onStatusRows(context, (frame) => {
    heard[0].push(frame.seq);
    // The reaction changes another agent and reads at once: its frame
    // is produced while this one is still being delivered.
    if (reacting > 0) {
      reacting -= 1;
      w.setStage(listed[reacting + 5], 'tool_running');
      emitSessionActivityChange(listed[reacting + 5]);
      agent.getStatus(context);
    }
  });
  agent.onStatusRows(context, (frame) => heard[1].push(frame.seq));
  const start = agent.getStatusList(context).seq;
  w.setStage(listed[0], 'streaming');
  emitSessionActivityChange(listed[0]);
  await settle();
  const expected = Array.from({ length: 5 }, (_, i) => start + 1 + i);
  assert.deepEqual(heard[0], expected);
  assert.deepEqual(heard[1], expected);
});

test('a row input that changes with no announcement is counted by the audit, apart from derivations', async (t) => {
  const w = await world(t, { seed: 4, rows: 12, tombstones: 4, leads: 2, tagOnly: 0, tasks: 0, statuses: ['running'] });
  const { agent, runtimes } = w;
  const context = w.contexts[0];
  const sid = agent.getStatus(context).workers[0].sessionId;
  const before = { ...agent._statusCounters };
  runtimes.set(sid, { ...(runtimes.get(sid) || {}), stage: 'tool_running' });
  // Another session's signal runs a pass that names only that session.
  emitSessionActivityChange(w.leadIds[1]);
  await settle();
  assert.equal(agent._statusCounters.auditHits - before.auditHits, 1);
  assert.deepEqual(
    agent._statusAuditForTest.misses().map((miss) => miss.split('@')[0]),
    [sid]
  );
  assert.equal(agent._statusCounters.derivations - before.derivations, 0, 'the pass derived nothing');
  // Its announcement brings the row up to date.
  emitSessionActivityChange(sid);
  await settle();
  assert.deepEqual(agent.getStatus(context), w.oracle(context));
  assert.deepEqual(agent._statusAuditForTest.misses(), []);
});

test('each source of a row input announces its change, and the row frame follows', async (t) => {
  const w = await world(t, { seed: 4, rows: 12, tombstones: 4, leads: 2, tagOnly: 2, tasks: 0, statuses: ['running'] });
  const { agent, runtimes, snapshots, sessions } = w;
  const context = w.contexts[0];
  const lead = w.leadIds[0];
  const worker = (i) => w.rowSids.filter((sid) => sessions.get(sid).parentSessionId === lead)[i];
  const frames = [];
  agent.onStatusRows(context, (frame) => frames.push(frame));
  // The source's own announcement runs the pass: nothing else signals.
  const frameAfter = async (sid, change) => {
    await settle();
    frames.length = 0;
    change();
    await settle();
    assertNoAuditMiss(w, `the change of ${sid}`);
    const sent = frames.filter((frame) => frame.id === sid && frame.list === 'workers');
    assert.equal(sent.length, 1, `row of ${sid}: ${JSON.stringify(frames)}`);
    return sent[0].row;
  };
  const registry = createProgressWatchdogRegistry({ mgr: w.mgr });
  const policy = resolveAgentWatchdogPolicy('worker');

  // The progress watchdog: armed on a later sweep's link, a failing check,
  // a new registration's policy, stopped.
  const c = worker(2);
  runtimes.set(c, { stage: 'requesting' });
  snapshots.set(c, { stage: 'requesting', waitingForTransport: true });
  emitSessionActivityChange(c);
  w.linkBlocked.add(c);
  // Registered but its link refused: still shown as not armed.
  const watch = registry.start(c, policy, 'worker');
  await settle();
  assertNoAuditMiss(w, 'a refused link');
  assert.match(agent.getStatus(context).workers.find((item) => item.sessionId === c).watchdog, /not armed/);
  let row = await frameAfter(c, () => {
    w.linkBlocked.delete(c);
    t.mock.timers.tick(1000);
  });
  assert.match(row.watchdog, /^armed transport=/);
  row = await frameAfter(c, () => {
    w.failing.sweep = true;
    try {
      t.mock.timers.tick(1000);
    } finally {
      w.failing.sweep = false;
    }
  });
  assert.match(row.watchdog, /^check failed: record unreadable/);
  row = await frameAfter(c, () => t.mock.timers.tick(1000));
  assert.match(row.watchdog, /^armed transport=/);
  row = await frameAfter(c, () => watch.stop());
  assert.match(row.watchdog, /not armed/);

  // The live copy (its todo) evicted.
  const d = worker(3);
  const live = { ...sessions.get(d) };
  _liveSessions.set(d, live);
  executeTodoTool(live, { op: 'init', items: ['a', 'b'] });
  await settle();
  assert.ok(agent.getStatus(context).workers.find((item) => item.sessionId === d).todo);
  row = await frameAfter(d, () => _clearLiveSession(d));
  assert.equal(row.todo, undefined);

  // A tag-bound session written in place, then saved.
  const e = w.tagOnly.find((sid) => sessions.get(sid).parentSessionId === lead);
  agent._statusInternalsForTest.tags.set(sessions.get(e).agentTag, e);
  await settle();
  row = await frameAfter(e, () => {
    Object.assign(sessions.get(e), { model: 'm3', totalInputTokens: 120, contextWindow: 2000 });
    sessions.get(e).messages.push({ role: 'user' });
    _publishLiveSession(sessions.get(e));
  });
  assert.deepEqual([row.model, row.usage?.inputTokens, row.windowCap, row.messages], ['m3', 120, 2000, 1]);
  assert.deepEqual(agent.getStatus(context), w.oracle(context));
});

test('the turn runtime announces every change of what agent status reads of it', () => {
  const id = `sess_liveness_${process.pid}`;
  const heard = [];
  const stop = onSessionActivityChange((sessionId) => {
    if (sessionId === id) heard.push(sessionId);
  });
  try {
    const step = (change) => {
      heard.length = 0;
      change();
      return heard.length;
    };
    // A runtime appearing, its stage.
    assert.ok(step(() => updateSessionStage(id, 'requesting')) >= 1);
    // The request phase alone: transport arriving, the first semantic event.
    assert.equal(step(() => markSessionTransportActivity(id)), 1);
    assert.equal(step(() => markSessionTransportActivity(id)), 0, 'no change, no announcement');
    assert.equal(step(() => updateSessionStage(id, 'streaming')), 1);
    assert.equal(step(() => void markSessionStreamDelta(id, 'text')), 1);
    // A cancelled turn, and its runtime cleared.
    assert.ok(step(() => abortSessionTurn(id, 'test')) >= 1);
    assert.equal(step(() => _clearSessionRuntime(id)), 1);
    assert.equal(step(() => _clearSessionRuntime(id)), 0);
  } finally {
    stop();
    _clearSessionRuntime(id);
  }
});

test('1,000 single-agent changes derive O(1) rows each, iterate no tombstone and serialise no whole answer', async (t) => {
  const w = await world(t, { seed: 7 });
  const { agent, contexts } = w;
  // Each scope's observer re-reads its own answer, as a session runtime does.
  for (const context of contexts) agent.onStatusChange(() => agent.getStatus(context));
  const listed = [...new Set(contexts.flatMap((context) => agent.getStatus(context).workers.map((row) => row.sessionId)))];
  assert.ok(listed.length >= 50, `listed workers: ${listed.length}`);
  // The populated index is written and served once before the count; the
  // count is of the production path (no audit).
  await w.quiesce();
  agent._statusAuditForTest.set(false);
  let tombstoneWork = 0;
  _setRowWorkCounterForTest((n) => {
    tombstoneWork += n;
  });
  t.after(() => _setRowWorkCounterForTest(null));
  const stringify = JSON.stringify;
  let wholeAnswers = 0;
  JSON.stringify = function counted(value, ...rest) {
    if (value && Array.isArray(value.workers) && Array.isArray(value.jobs)) wholeAnswers += 1;
    return stringify.call(this, value, ...rest);
  };
  t.after(() => {
    JSON.stringify = stringify;
  });
  const stages = ['connecting', 'streaming', 'tool_running', 'requesting'];
  const before = { ...agent._statusCounters };
  for (let i = 0; i < 1000; i += 1) {
    const sid = listed[i % listed.length];
    w.setStage(sid, stages[i % stages.length]);
    emitSessionActivityChange(sid);
    await settle(1);
  }
  await settle();
  const derivations = agent._statusCounters.derivations - before.derivations;
  JSON.stringify = stringify;
  assert.ok(derivations <= 2 * 1000, `1,000 changes derived ${derivations} rows`);
  assert.equal(tombstoneWork, 0, 'no tombstone (or index row) was walked');
  assert.equal(wholeAnswers, 0, 'no whole answer was serialised');
  assert.equal(agent._statusCounters.witnesses - before.witnesses, 0, 'no listed agent was compared');
  assert.equal(agent._statusCounters.jobListings - before.jobListings, 0, "no scope's job list was listed again for a stage change");
  // The read before the status sets derives every listed row of every scope per change.
  let readRows = 0;
  for (const context of contexts) {
    const answer = w.oracle(context);
    readRows += answer.workers.length + answer.jobs.length;
  }
  assert.ok(readRows >= 100 * 2, `the read derives ${readRows} rows per change; the sets at most 2`);
});
