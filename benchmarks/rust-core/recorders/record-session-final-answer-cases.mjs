#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-final-answer.test.mjs (b6f10295a): the answer a finished turn announces (its identity, its
// text, its status) from a stored or live session, the cases that stay pending, and the host's read of the requested session (no
// selection, no state publication, the abort signal handed on, a missing session tagged by name).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-final-answer-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { finalAnswerScenarios } from './lib/final-answer-scenarios.mjs';

REPLAY_TARGETS['session-final-answer-cases'] = {
  protocolMethods: ['thread/finalAnswer/read'],
};
const set = openSet('session-final-answer-cases', import.meta.url);
const modules = {
  ...(await set.load('apps/desktop/src/main/session-final-answer.ts')),
  ...(await set.load('apps/desktop/src/main/session-host.ts')),
  ...(await set.load('src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs')),
};
for (const [name, scenario] of Object.entries(finalAnswerScenarios(modules))) await set.run(name, scenario);

await set.finish({
  entry: { runs: 'sessionFinalAnswer, isSessionMissingError, SESSION_NOT_AVAILABLE_CODE (session-final-answer.ts), SessionHost.prototype.readSessionFinalAnswer called on a stand-in `this` with a scripted readSession, restoreTranscriptItems', notRun: 'no real session host: readSession is scripted and its argument list recorded', hops: 'No wire in the Node test.' },
  replay: { entry: 'the desktop\'s final-answer announcement and its host read on the product modules (the core serves the read as thread/finalAnswer/read); compare each case whole', normalised: {} },
});
process.exit(0);
