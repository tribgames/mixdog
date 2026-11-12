#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-history-boundary.test.mjs (b6f10295a): the host decides whether an attachment id belongs
// to a session whose chip the pane still shows after a compaction, from the session's stored history; an id the visible history never
// named (cleared, capped, another session's, guessed) is refused; the desktop read answers bytes and name only; no channel of the
// window, the phone or the service reaches the history as a transcript read. The real stores in a scratch data folder.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-history-boundary-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { REPLAY_TARGETS } from './lib/replay-targets.mjs';
import { historyBoundaryScenarios } from './lib/history-boundary-scenarios.mjs';

REPLAY_TARGETS['session-history-boundary-cases'] = {
  protocolMethods: ['thread/attachment/list'],
  missing: ['the desktop host\'s refusal reasons (`not-linked`) for an attachment id the session\'s visible history never named: the core answers thread/attachment/list from the session\'s own rows; the per-id open and its refusal belong to the desktop (apps/desktop/src/main/session-attachments.ts)'],
};
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-history-boundary-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('session-history-boundary-cases', import.meta.url);
const modules = {
  dataDir,
  ...(await set.load('apps/desktop/src/shared/contract.ts')),
  ...(await set.load('apps/desktop/src/shared/file-downloads.ts')),
  ...(await set.load('apps/desktop/src/main/ipc-sessions.ts')),
  ...(await set.load('apps/desktop/src/main/remote-methods.ts')),
  ...(await set.load('apps/desktop/src/main/session-attachments.ts')),
  ...(await set.load('src/runtime/agent/orchestrator/session/store-summary-reader.mjs')),
  ...(await set.load('src/runtime/agent/orchestrator/session/compaction-archive-capture.mjs')),
  ...(await set.load('src/runtime/agent/orchestrator/session/store.mjs')),
  ...(await set.load('src/runtime/agent/orchestrator/session/manager/session-crud.mjs')),
};
try {
  for (const [name, scenario] of Object.entries(historyBoundaryScenarios(modules))) await set.run(name, scenario);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

await set.finish({
  entry: { runs: 'readSessionAttachment (session-attachments.ts), registerSessionIpc, createRemoteMethods, readStoredSessionTranscript (store-summary-reader.mjs) over session files the store writes in a scratch MIXDOG_DATA_DIR: the archive\'s segments by the compaction capture (scheduleCompactionArchive, the cap by its byte cap), the hide by the real clear (clearSessionMessages), the records by saveSessionAsync', notRun: 'the test\'s last case (a scan of the app\'s source files for the name of the history read) is a property of the source tree, not of a call; no real attachment store (the blobs are a scripted map); the compactions are the capture the compaction runner calls with the messages it dropped, not a summarising run', hops: 'No wire in the Node test.' },
  replay: { entry: 'the desktop attachment read on the product modules over the same stored sessions (the core serves a session\'s attachments as thread/attachment/list); compare each case whole', normalised: {} },
});
process.exit(0);
