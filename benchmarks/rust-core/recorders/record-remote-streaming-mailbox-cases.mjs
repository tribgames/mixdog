#!/usr/bin/env node
// Recording of apps/desktop/src/main/remote-streaming-mailbox.test.mjs (b6f10295a): the relay's streaming mailbox
// (remote-streaming-mailbox.ts createRemoteStreamingMailbox) on a virtual clock whose every step is recorded as an input, the
// snapshot delta encoder/decoder (state-delta.ts) and the two partial-append suffix checks (desktop shared/streaming-partial.ts and
// the daemon's session-state-patch.mjs). Per case: the publish / advance / acknowledge / clear steps and, after each, the frames
// the mailbox sent (sequence, value, critical).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-streaming-mailbox-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('remote-streaming-mailbox-cases', import.meta.url);
const { createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS } = await set.load('apps/desktop/src/main/remote-streaming-mailbox.ts');
const { createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire } = await set.load('apps/desktop/src/main/state-delta.ts');
const { streamingPartialSuffix: desktopSuffix } = await set.load('apps/desktop/src/shared/streaming-partial.ts');
const { streamingPartialSuffix: daemonSuffix } = await set.load('src/standalone/session-state-patch.mjs');

function clock() {
  let now = 0;
  const pending = new Map();
  return {
    timers: { setTimeout(callback, ms) { const id = { unref() {} }; pending.set(id, { callback, at: now + ms }); return id; }, clearTimeout(id) { pending.delete(id); } },
    advance(ms) { now += ms; for (const [id, entry] of [...pending]) { if (entry.at > now) continue; pending.delete(id); entry.callback(); } },
    get pending() { return pending.size; },
    get now() { return now; },
  };
}
const items = [{ id: 'user', kind: 'user', text: 'input' }];
const update = (text, fields = {}) => ({ sessionId: 's', frameSource: 'live', snapshot: { busy: true, items, streamingTail: { id: 'tail', kind: 'assistant', text }, ...fields } });
const copy = (value) => structuredClone(value);

/** A mailbox on a virtual clock; `ack` is whether the sender acknowledges each frame at once. */
function rig({ ack }) {
  const time = clock();
  const frames = [];
  const steps = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value, critical) => {
    frames.push({ sequence, value: copy(value), critical });
    if (ack) mailbox.acknowledge(sequence);
  }, time.timers);
  const log = (step, extra = {}) => steps.push({ step, atMs: time.now, pendingTimers: time.pending, frameCount: frames.length, ...extra });
  return {
    frames, steps, time, mailbox,
    publish(value, label) { mailbox.publish(value); log(`publish ${label}`, { published: copy(value) }); },
    advance(ms) { time.advance(ms); log(`advance ${ms}`); },
    acknowledge(sequence) { mailbox.acknowledge(sequence); log(`acknowledge ${sequence}`); },
    clear() { mailbox.clear(); log('clear'); },
  };
}

await set.run('the desktop and daemon partial-append suffix checks agree on every input', () => {
  const line = { id: 'a', from: 3, text: 'abc' };
  const cases = [
    [line, { ...line, text: 'abcde' }], [line, { ...line, text: 'abc' }], [line, { ...line, text: 'ab' }], [line, { ...line, text: 'xbcde' }], [line, { ...line, from: 4, text: 'abcde' }],
    [line, { ...line, id: 'b', text: 'abcde' }], [line, { ...line, tail: { id: 'a' }, text: 'abcde' }], [{ ...line, text: '' }, { ...line, text: 'x' }], [line, { id: 'a', from: 3, text: 7 }],
    [null, line], [line, undefined], ['abc', 'abcd'], [[], []],
  ];
  return { cases: cases.map(([before, after]) => ({ before, after, desktop: desktopSuffix(before, after), daemon: daemonSuffix(before, after) })) };
});
await set.run('a text burst sends its first append at once, then one latest snapshot per batch window', () => {
  const r = rig({ ack: true });
  r.publish(update(''), "''"); r.publish(update('한'), "'한'");
  r.publish(update('한글'), "'한글'");
  r.advance(REMOTE_STREAM_BATCH_MS - 1); r.advance(1);
  r.advance(REMOTE_STREAM_BATCH_MS);
  r.publish(update('한글 다음'), "'한글 다음'");
  return { batchMs: REMOTE_STREAM_BATCH_MS, steps: r.steps, frames: r.frames };
});
await set.run('completion, replay, and unknown approval fields bypass batching and remain critical', () => {
  const r = rig({ ack: true });
  r.publish(update(''), "''"); r.publish(update('pending text'), "'pending text'"); r.publish(update('pending text more'), "'pending text more'");
  r.publish(update('pending text more', { futureApproval: { id: 'approval' } }), 'with futureApproval');
  r.publish(update('complete', { busy: false }), "'complete' busy false");
  r.publish({ ...update('replay'), frameSource: 'replay' }, "replay 'replay'");
  return { steps: r.steps, frames: r.frames };
});
await set.run('backpressure cannot downgrade queued approval state and disconnect clears delayed work', () => {
  const r = rig({ ack: false });
  const approval = { id: 'approval' };
  r.publish(update(''), "''"); r.publish(update('', { futureApproval: approval }), 'approval'); r.publish(update('continued', { futureApproval: approval }), "'continued' approval");
  r.advance(REMOTE_STREAM_BATCH_MS);
  r.acknowledge(r.frames[0].sequence);
  r.publish(update('continued text', { futureApproval: approval }), "'continued text' approval");
  r.clear();
  r.advance(100);
  r.acknowledge(r.frames[1].sequence);
  return { steps: r.steps, frames: r.frames };
});
await set.run('partial-line growth batches as a text append; a partial for another row does not', () => {
  const r = rig({ ack: true });
  const partial = (text, from = 6, id = 'tail') => ({ streamingPartial: { id, from, text } });
  r.publish(update('line1\n'), "'line1\\n'"); r.publish(update('line1\n', partial('pa')), "partial 'pa'"); r.publish(update('line1\n', partial('partial')), "partial 'partial'");
  r.publish(update('line1\npartial line\n', partial('ne', 19)), "tail moved, partial 'ne' from 19");
  r.advance(REMOTE_STREAM_BATCH_MS);
  r.publish(update('line1\npartial line\n', partial('x', 0, 'other')), "partial for row 'other'");
  return { steps: r.steps, frames: r.frames };
});
await set.run('a decoder that predates streamingPartial keeps painting the line-gated tail', () => {
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  const sends = [];
  const send = (snapshot) => {
    const wire = encoder.encode(snapshot);
    if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
    const result = decoder.decode(copy(wire));
    sends.push({ snapshot, wire: copy(wire), ok: result.ok, received: result.snapshot });
    return result.snapshot;
  };
  const tail = (text) => ({ id: 'tail', kind: 'assistant', text, streaming: true });
  send({ busy: true, items, streamingTail: tail('one\n') });
  const received = send({ busy: true, items, streamingTail: tail('one\n'), streamingPartial: { id: 'tail', from: 4, text: 'tw' } });
  const settled = send({ busy: false, items: [...items, { ...tail('one\ntwo'), streaming: false }], streamingTail: null });
  return { sends, received, settled };
});
await set.run('batching reduces real compact packet bytes while preserving decoder state', () => {
  const time = clock();
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  let bytes = 0; let packets = 0; let received;
  const sent = [];
  let mailbox;
  mailbox = createRemoteStreamingMailbox((sequence, value) => {
    const wire = encoder.encode(value.snapshot);
    if (packets > 0) bytes += Buffer.byteLength(JSON.stringify({ e: 'T', s: 1, w: wire })) + 82;
    packets += 1;
    if (!Object.hasOwn(wire, '__itemsRevision')) markCompactWire(wire);
    const result = decoder.decode(copy(wire));
    received = result.snapshot;
    sent.push({ atMs: time.now, wire: copy(wire), ok: result.ok });
    mailbox.acknowledge(sequence);
  }, time.timers);
  mailbox.publish(update(''));
  let text = '';
  const publishes = [];
  for (let i = 0; i < 100; i += 1) { text += '응답 '; mailbox.publish(update(text)); publishes.push({ i, atMs: time.now, textChars: text.length }); time.advance(4); }
  time.advance(REMOTE_STREAM_BATCH_MS);
  return { batchMs: REMOTE_STREAM_BATCH_MS, publishEveryMs: 4, publishes: 100, packets, bytes, received, text, sent };
});

await set.finish({
  entry: { hops: "No wire in the Node test: the mailbox sender is a local callback; frames are recorded as values. The packet byte count is the length of the JSON text of the frame the relay would send (declared, not a hop).", runs: 'createRemoteStreamingMailbox (remote-streaming-mailbox.ts) with an injected timer pair on a virtual clock (the test\'s own: advance() runs due callbacks), createSnapshotDeltaEncoder/Decoder (state-delta.ts), streamingPartialSuffix of desktop shared/streaming-partial.ts and the daemon session-state-patch.mjs', notRun: 'the relay transport; the sender callback is a local array' },
  replay: { entry: 'mixdog-app-server thread feed batching: replay the steps against the Rust mailbox on a virtual clock; compare the frames (sequence, value, critical) and pending-timer counts after every step, and for the encoder cases the wires', normalised: {} },
});
process.exit(0);
