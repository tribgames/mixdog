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
import { mailboxScenarios } from './lib/mailbox-scenarios.mjs';

const set = openSet('remote-streaming-mailbox-cases', import.meta.url);
const { createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS } = await set.load('apps/desktop/src/main/remote-streaming-mailbox.ts');
const { createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire } = await set.load('apps/desktop/src/main/state-delta.ts');
const { streamingPartialSuffix: desktopSuffix } = await set.load('apps/desktop/src/shared/streaming-partial.ts');
const { streamingPartialSuffix: daemonSuffix } = await set.load('src/standalone/session-state-patch.mjs');

await set.run('the desktop and daemon partial-append suffix checks agree on every input', () => {
  const line = { id: 'a', from: 3, text: 'abc' };
  const cases = [
    [line, { ...line, text: 'abcde' }], [line, { ...line, text: 'abc' }], [line, { ...line, text: 'ab' }], [line, { ...line, text: 'xbcde' }], [line, { ...line, from: 4, text: 'abcde' }],
    [line, { ...line, id: 'b', text: 'abcde' }], [line, { ...line, tail: { id: 'a' }, text: 'abcde' }], [{ ...line, text: '' }, { ...line, text: 'x' }], [line, { id: 'a', from: 3, text: 7 }],
    [null, line], [line, undefined], ['abc', 'abcd'], [[], []],
  ];
  return { cases: cases.map(([before, after]) => ({ before, after, desktop: desktopSuffix(before, after), daemon: daemonSuffix(before, after) })) };
});
const scenarios = mailboxScenarios({ createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS, createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire });
for (const [name, scenario] of Object.entries(scenarios)) await set.run(name, scenario);

await set.finish({
  entry: { hops: "No wire in the Node test: the mailbox sender is a local callback; frames are recorded as values. The packet byte count is the length of the JSON text of the frame the relay would send (declared, not a hop).", runs: 'createRemoteStreamingMailbox (remote-streaming-mailbox.ts) with an injected timer pair on a virtual clock (the test\'s own: advance() runs due callbacks), createSnapshotDeltaEncoder/Decoder (state-delta.ts), streamingPartialSuffix of desktop shared/streaming-partial.ts and the daemon session-state-patch.mjs', notRun: 'the relay transport; the sender callback is a local array' },
  replay: { entry: 'mixdog-app-server thread feed batching: replay the steps against the Rust mailbox on a virtual clock; compare the frames (sequence, value, critical) and pending-timer counts after every step, and for the encoder cases the wires', normalised: {} },
});
process.exit(0);
