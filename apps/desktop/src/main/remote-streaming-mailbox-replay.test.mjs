// Replay of native/core/fixtures/remote-streaming-mailbox-cases (record-remote-streaming-mailbox-cases.mjs, Node b6f10295a), the six
// cases that run the relay's streaming mailbox: a text burst sends its first append at once, then one latest snapshot per batch window;
// completion, replay and unknown approval fields bypass batching and stay critical; backpressure cannot downgrade queued approval
// state and a disconnect clears delayed work; partial-line growth batches as a text append; a decoder that predates streamingPartial
// keeps painting the line-gated tail; batching reduces real compact packet bytes while keeping decoder state. The same steps the recorder
// ran (virtual clock, every step an input) on the product's own mailbox and delta codec, compared whole. The first case (the two
// partial-append suffix checks) is replayed by shared/streaming-partial-replay.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { mailboxScenarios } from '../../../../benchmarks/rust-core/recorders/lib/mailbox-scenarios.mjs';
import { createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS } from './remote-streaming-mailbox.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder, markCompactWire } from './state-delta.ts';

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/remote-streaming-mailbox-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = mailboxScenarios({ createRemoteStreamingMailbox, REMOTE_STREAM_BATCH_MS, createSnapshotDeltaEncoder, createSnapshotDeltaDecoder, markCompactWire });
const recorded = golden.cases.slice(1);

assert.deepEqual(recorded.map((c) => c.case), Object.keys(scenarios), 'every recorded case after the first is replayed, in the recorded order');
for (const entry of recorded) {
  test(entry.case, async () => {
    assert.deepEqual(exact(await scenarios[entry.case](), { path: entry.case }), entry.observed);
  });
}
