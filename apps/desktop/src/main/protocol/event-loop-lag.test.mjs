// The bound that lets a process own the client library (desktop-services.md §12): under reconnect storms with a
// large app snapshot and several sessions streaming at once, the event loop is never blocked for more than 50 ms.
//
// What runs: the real client library folding frames from its mock transport, a store listener standing for the
// consumer of every change, and a real event-loop delay monitor (perf_hooks `monitorEventLoopDelay`) over the whole storm. The scripted
// core streams every session from its own immediate-loop in bursts of 200 frames (one burst is delivered in a single
// synchronous run, as the frames of one socket read are), drops the socket in the middle of the stream, and the next
// generation re-handshakes, re-sends the ~1 MB app snapshot and re-folds the sessions while the streams of the other
// sessions keep going. No frame is awaited between bursts. Frames are built before the monitor starts.
//
// `structuredClone` stands in for Electron's IPC serialisation (both are V8's structured-clone algorithm); the listener
// runs it on every changed section, so its cost is inside the measured turns.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';
import { SECTION_NAMES } from '../../shared/contract-sections.ts';

const MAX_LOOP_BLOCK_MS = 50;
const THREADS = ['t1', 't2', 't3', 't4'];
const STORMS = 5;
const BURST_FRAMES = 200;
/** Bursts each session has queued on a generation; the socket drops after the first few, mid-stream. */
const BURSTS_BEFORE_DROP = 12;
const APP_SECTIONS = 1400;
const options = JSON.parse(
  readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const thread = (id) => ({ id, preview: '', title: id, updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });
const text = (n) => 'x'.repeat(n);
const immediate = () => new Promise((done) => setImmediate(done));

/** Names the task that owns each loop turn over 16 ms: work is timed under a label where this test can wrap it, and a turn
 *  with little labelled time belongs to the library's own fold. A turn is the gap between two 1 ms ticks. */
function createTurnLog() {
  const spent = new Map();
  const stack = [];
  const turns = [];
  let last = performance.now();
  let timer = null;
  const collections = [];
  const observer = new PerformanceObserver((list) => collections.push(...list.getEntries()));
  const tick = () => {
    const now = performance.now();
    const ms = now - last - 1;
    if (ms > 16) turns.push({ ms, from: last, to: now, spans: new Map(spent) });
    spent.clear();
    last = now;
  };
  return {
    start() {
      last = performance.now();
      timer = setInterval(tick, 1);
      observer.observe({ entryTypes: ['gc'] });
    },
    stop() {
      clearInterval(timer);
      collections.push(...observer.takeRecords());
      observer.disconnect();
    },
    /** Runs `fn` under `label`; time spent in a nested `timed` belongs to the nested label only. */
    timed(label, fn) {
      const frame = { child: 0 };
      stack.push(frame);
      const started = performance.now();
      try {
        return fn();
      } finally {
        const total = performance.now() - started;
        stack.pop();
        spent.set(label, (spent.get(label) ?? 0) + total - frame.child);
        if (stack.length > 0) stack[stack.length - 1].child += total;
      }
    },
    /** The turns, longest first, each with its labelled spans and the unlabelled remainder (the library's fold). */
    report: () =>
      turns
        .map(({ ms, from, to, spans }) => {
          // Garbage collection inside the turn is its own owner; it is not part of the labelled work.
          const gc = collections.reduce((sum, entry) => sum + Math.max(0, Math.min(to, entry.startTime + entry.duration) - Math.max(from, entry.startTime)), 0);
          const labelled = [...spans.values()].reduce((a, b) => a + b, 0);
          return { ms, owners: [...spans, ['garbage collection', gc], ['library fold step', Math.max(0, ms - labelled - gc)]].sort((a, b) => b[1] - a[1]) };
        })
        .sort((a, b) => b.ms - a.ms),
  };
}

// ~1 MB of sections in one app snapshot.
const APP_SNAPSHOT = JSON.stringify({
  method: 'app/snapshot',
  params: {
    sections: Array.from({ length: APP_SECTIONS }, (_, i) => ({
      section: SECTION_NAMES[i % 6],
      key: `k${i}`,
      revision: 1,
      value: { row: i, body: text(700) },
    })),
  },
  feed: { id: 'app', epoch: 'ae', seq: 1 },
});
const threadSnapshot = (id, epoch) =>
  JSON.stringify({
    method: 'thread/snapshot',
    params: {
      thread: thread(id),
      items: Array.from({ length: 300 }, (_, i) => ({ id: `${id}-${i}`, type: 'agentMessage', text: text(900) })),
    },
    feed: { id, epoch, seq: 1 },
  });

/** The frames one session streams on generation `generation`: deltas, an item every twentieth frame. */
function streamFrames(id, generation) {
  const frames = [];
  for (let n = 0; n < BURST_FRAMES * BURSTS_BEFORE_DROP + 1; n++) {
    const completed = n % 20 === 19;
    frames.push(
      JSON.stringify({
        method: completed ? 'item/completed' : 'item/agentMessage/delta',
        params: completed
          ? { item: { id: `${id}-g${generation}-${n}`, type: 'agentMessage', text: text(900) } }
          : { itemId: `${id}-live`, delta: text(40) },
        feed: { id, epoch: `e${generation}`, seq: n + 2 },
      })
    );
  }
  return frames;
}
const poolFrames = (generation) =>
  Array.from({ length: BURSTS_BEFORE_DROP * 4 }, (_, n) =>
    JSON.stringify({
      method: 'agent/pool/updated',
      params: { section: 'agentPool', key: null, revision: generation * 1000 + n + 2, value: [n] },
      feed: { id: 'app', epoch: 'ae', seq: n + 2 },
    })
  );

test('reconnect storms over concurrent streams in several sessions never block the main loop past 50 ms', async () => {
  const net = new MockNetwork();
  const turnLog = createTurnLog();
  const send = (conn, frame, label) => turnLog.timed(label, () => conn.serverSendRaw(frame));
  const generations = Array.from({ length: STORMS + 1 }, (_, g) => ({
    n: g + 1,
    // Built one generation ahead (see prepare), so the heap the collector walks stays the size of a real session's.
    streams: new Map(),
    pool: [],
    framesSent: 0,
    appSnapshots: 0,
    threadSnapshots: 0,
  }));
  let current = null;
  /** Builds a generation's frames, one session per turn, before the generation that needs them. */
  const prepare = async (gen) => {
    for (const id of THREADS) {
      gen.streams.set(id, streamFrames(id, gen.n));
      await immediate();
    }
    gen.pool = poolFrames(gen.n);
  };

  /** One session's (or the pool's) stream: a burst per macrotask until the socket of its generation is gone. */
  const stream = async (conn, gen, frames) => {
    for (let at = 0; at < frames.length && current === conn; at += BURST_FRAMES) {
      for (const frame of frames.slice(at, at + BURST_FRAMES)) send(conn, frame, 'stream frames (parse + fold)');
      gen.framesSent += Math.min(BURST_FRAMES, frames.length - at);
      await immediate();
    }
  };

  /** The scripted core of one generation: answers every client request in its own loop turn, streams as soon as a session is attached. */
  const serve = async (conn, gen) => {
    for (;;) {
      const frame = JSON.parse(await conn.nextSent());
      // Each client request is answered by its own socket read: its reply and the snapshot behind it arrive together,
      // but two requests never share a loop turn.
      await immediate();
      if (frame.method === 'initialize') {
        send(conn, JSON.stringify({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: `s${gen.n}` } }), 'handshake frame');
      } else if (frame.method === 'app/subscribe') {
        send(conn, JSON.stringify({ id: frame.id, result: { subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 2 } } }), 'handshake frame');
        send(conn, APP_SNAPSHOT, 'app snapshot frame (parse + stage start)');
        gen.appSnapshots += 1;
        void stream(conn, gen, gen.pool);
      } else if (frame.method === 'thread/resume') {
        const id = frame.params.threadId;
        send(conn, JSON.stringify({ id: frame.id, result: { thread: thread(id), subscription: { id: `sub-${id}`, mode: 'snapshot', epoch: `e${gen.n}`, startSeq: 2 } } }), 'handshake frame');
        send(conn, threadSnapshot(id, `e${gen.n}`), 'thread snapshot frame (parse + fold)');
        gen.threadSnapshots += 1;
        void stream(conn, gen, gen.streams.get(id));
      }
    }
  };

  const connecting = connect({
    target: { id: 'core' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: {
      initial: (snapshot) => turnLog.timed('thread reducer', () => sessionReducer.initial(snapshot)),
      apply: (state, notification) => turnLog.timed('thread reducer', () => sessionReducer.apply(state, notification)),
    },
    clock: { sleep: () => Promise.resolve() },
    random: () => 0.5,
  });
  await prepare(generations[0]);
  current = await net.accept();
  void serve(current, generations[0]);
  const client = await connecting;

  // The incremental fold and the chunked replace finish over several turns; the next storm waits for them (a drop mid-fold discards it, and a newer replace supersedes an unfinished one).
  let folded = 0;
  client.store.subscribe((change) => void (change.type === 'appSnapshot' && folded++));
  const delivered = { count: 0 };
  // Every store listener (the consumer's section watchers) runs under one label.
  const subscribe = client.store.subscribe.bind(client.store);
  client.store.subscribe = (listener) => subscribe((change) => turnLog.timed('store listeners', () => listener(change)));
  client.store.subscribe((change) => {
    if (change.type === 'appSnapshot') return;
    turnLog.timed('IPC clone: delta', () => structuredClone(change));
    delivered.count += 1;
  });
  await client.subscribeApp();
  for (const id of THREADS) await client.resumeThread(id, { lastItems: 50 });
  // The first generation is the warm-up: it runs with the real code paths but outside the measurement.
  await immediate();

  const monitor = monitorEventLoopDelay({ resolution: 1 });
  monitor.enable();
  turnLog.start();
  for (let storm = 0; storm < STORMS; storm++) {
    const gen = generations[storm];
    // Let this generation stream, then drop the socket in the middle of it: every session is mid-stream.
    while (gen.framesSent < THREADS.length * BURST_FRAMES * 3) await immediate();
    const next = generations[storm + 1];
    await prepare(next);
    const previous = current;
    const foldedBefore = folded;
    previous.serverClose(1006);
    gen.streams.clear();
    gen.pool = [];
    current = await net.accept();
    void serve(current, next);
    // The new generation's re-handshake, ~1 MB snapshot and session re-folds run while its streams start.
    while (next.threadSnapshots < THREADS.length || next.framesSent < THREADS.length * BURST_FRAMES * 3 || folded === foldedBefore) {
      await immediate();
    }
  }
  monitor.disable();
  turnLog.stop();
  // The last reconnect's snapshot folds over several turns.
  for (let i = 0; i < 2000 && folded < STORMS; i++) await immediate();

  const worstMs = monitor.max / 1e6;
  const longTurns = turnLog.report();
  for (const turn of longTurns.slice(0, 5)) {
    const owners = turn.owners.filter(([, ms]) => ms >= 1).map(([label, ms]) => `${label} ${ms.toFixed(1)}`);
    console.log(`# turn ${turn.ms.toFixed(1)} ms: ${owners.join('; ')}`);
  }
  // Not vacuous: one handshake and one app snapshot per generation, every session re-folded each time, every storm
  // streamed mid-session, and the store held the whole snapshot after each reconnect.
  assert.ok(generations.every((g, i) => i === 0 || (g.appSnapshots === 1 && g.threadSnapshots === THREADS.length)));
  assert.ok(generations.slice(1).every((g) => g.framesSent >= THREADS.length * BURST_FRAMES * 3), 'every storm streamed');
  const held = SECTION_NAMES.flatMap((name) => client.store.sections(name)).length;
  assert.ok(held >= APP_SECTIONS, 'the large snapshot is in the store');
  assert.ok(delivered.count > 0 && folded >= STORMS, 'the store was folded after every reconnect and its changes were delivered');
  assert.ok(worstMs <= MAX_LOOP_BLOCK_MS, `the main loop was blocked ${worstMs.toFixed(1)} ms (limit ${MAX_LOOP_BLOCK_MS})`);
  console.log(`# worst main-loop delay ${worstMs.toFixed(1)} ms over ${STORMS} storms`);
});








