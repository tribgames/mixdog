// Replay of native/core/fixtures/session-history-boundary-cases (record-session-history-boundary-cases.mjs, Node b6f10295a): which
// attachment ids a session's visible history lets the host open (a compacted one opens; a cleared, capped, foreign or guessed id is
// refused), when the stored history is read, and that no channel of the window or the phone reads the history as a transcript. The
// product's own modules over the same stored sessions, compared whole.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { historyBoundaryScenarios } from '../../../../benchmarks/rust-core/recorders/lib/history-boundary-scenarios.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-history-boundary-replay-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { DESKTOP_IPC } = await import('../shared/contract.ts');
const { fileDownloadErrorReason } = await import('../shared/file-downloads.ts');
const { registerSessionIpc } = await import('./ipc-sessions.ts');
const { createRemoteMethods } = await import('./remote-methods.ts');
const { readSessionAttachment } = await import('./session-attachments.ts');
const { readStoredSessionTranscript } = await import('../../../../src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const { loadSession, saveSessionAsync, releaseIdleSessionWriter } = await import('../../../../src/runtime/agent/orchestrator/session/store.mjs');
const { clearSessionMessages } = await import('../../../../src/runtime/agent/orchestrator/session/manager/session-crud.mjs');
const { scheduleCompactionArchive, flushCompactionArchiveWrites, stampCompactionMessageIds } = await import('../../../../src/runtime/agent/orchestrator/session/compaction-archive-capture.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const golden = JSON.parse(readFileSync(new URL('../../../../native/core/fixtures/session-history-boundary-cases/golden.json', import.meta.url), 'utf8'));
const scenarios = historyBoundaryScenarios({ dataDir, DESKTOP_IPC, fileDownloadErrorReason, registerSessionIpc, createRemoteMethods, readSessionAttachment, readStoredSessionTranscript, loadSession, saveSessionAsync, releaseIdleSessionWriter, clearSessionMessages, scheduleCompactionArchive, flushCompactionArchiveWrites, stampCompactionMessageIds });

assert.deepEqual(golden.cases.map((c) => c.case), Object.keys(scenarios), 'every recorded case is replayed, in the recorded order');
for (const recorded of golden.cases) {
  test(recorded.case, async () => {
    assert.deepEqual(exact(await scenarios[recorded.case](), { path: recorded.case }), recorded.observed);
  });
}
