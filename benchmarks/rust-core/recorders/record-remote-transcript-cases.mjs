#!/usr/bin/env node
// Recording of apps/desktop/src/main/remote-transcript.test.mjs (b6f10295a): what a paired phone is sent of a session's transcript:
// tool output over the cap keeps head and tail, user rows and short rows are the host's own, the prompt history is bounded (a submit
// still patches it), the full output of a row is read by its id (only for a session the connection views and a row it was sent),
// and rows naming secret-bearing files travel whole, in a baseline and in a delta. The real remote methods, projection and delta
// encoder/decoder with a scripted host.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-transcript-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { remoteTranscriptScenarios } from './lib/remote-transcript-scenarios.mjs';

REPLAY_TARGETS['remote-transcript-cases'] = {
  protocolMethods: ['thread/items/read', 'thread/items/list'],
  missing: ['the phone-facing projection: capped tool output with its head, tail and omitted note, the bounded prompt history, the view/held checks of readTranscriptItem and the baseline/delta encoder are the desktop relay\'s (apps/desktop/src/main/remote-transcript.ts, remote-relay-session-state.ts); the core serves thread/items/read and thread/items/list and has no compact session-state encoder (domain_seams/remote/e2e.rs notes it)'],
};
const set = openSet('remote-transcript-cases', import.meta.url);
const modules = {
  ...(await set.load('apps/desktop/src/main/remote-methods.ts')),
  ...(await set.load('apps/desktop/src/main/remote-relay-session-state.ts')),
  ...(await set.load('apps/desktop/src/main/remote-transcript.ts')),
  ...(await set.load('apps/desktop/src/main/state-delta.ts')),
  ...(await set.load('apps/desktop/src/main/remote-session-methods.ts')),
};
for (const [name, scenario] of Object.entries(remoteTranscriptScenarios(modules))) await set.run(name, scenario);

await set.finish({
  entry: { runs: 'createRemoteMethods (readTranscriptItem), encodeRelayClientSessionState, remoteTranscriptSnapshot / remotePromptHistory / remoteToolOutput and their caps, createSnapshotDeltaDecoder, READ_NOT_HELD / READ_NOT_VIEWED', notRun: 'a scripted host serves transcripts and the connection\'s viewed and held sets', hops: 'The relay frames are recorded as the JSON a phone receives (JSON round trip).' },
  replay: { entry: 'the desktop relay\'s phone projection and transcript-item read on the product modules; compare each case whole', normalised: {} },
});
process.exit(0);
