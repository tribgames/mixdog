// `remote-streaming-mailbox-cases`, "the desktop and daemon partial-append suffix checks agree on every input": in K1 the step
// is made by the desktop alone, when its main process sends a session's state to its renderer (ipc-state-bridge.ts
// `sendSessionState` → state-delta.ts `partialAppend` → `streamingPartialSuffix`). The daemon's helper (session-state-patch.mjs) has
// no K1 counterpart: the core sends a growing line as `item/agentMessage/delta` and makes no snapshot patch. Each recorded input
// gives the desktop answer Node recorded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fromExact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { streamingPartialSuffix } from './streaming-partial.ts';

const golden = fromExact(JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/remote-streaming-mailbox-cases/golden.json', import.meta.url), 'utf8')));
const recorded = golden.cases.find((c) => c.case === 'the desktop and daemon partial-append suffix checks agree on every input').observed;

test('the desktop finds the suffix Node found for each recorded partial line', () => {
  const answers = recorded.cases.map(({ before, after }) => ({ before, after, desktop: streamingPartialSuffix(before, after) }));
  assert.deepEqual(answers, recorded.cases.map(({ before, after, desktop }) => ({ before, after, desktop })));
});
