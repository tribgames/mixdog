// The restart-prefix fixture stops a turn mid-flight and prints READY only once the checkpoint record it stops at can be
// read back from the journal file. Two behaviours: (1) at READY the record is readable (the assistant message calling
// call_3 and the 'tools' phase); (2) when the journal's append fails, READY is never announced and the child fails with the
// write's own error. Without the fix the fixture waits for an idle write lane, which a failed write also leaves, and
// announces READY with no record on disk.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SESSION_DIR = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(SESSION_DIR, 'restart-prefix-parity.fixture.mjs');
const JOURNAL = pathToFileURL(join(SESSION_DIR, 'manager', 'turn-checkpoint-journal.mjs')).href;
const DEADLINE_MS = 60_000;

// Runs the killtool phase until READY or exit; the child is killed as the parent does in the recording.
function runKillTool(root, preloads = []) {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const args = [...preloads.flatMap((file) => ['--import', pathToFileURL(file).href]), FIXTURE, 'killtool', dataDir, join(root, 'out.json')];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`neither READY nor exit within ${DEADLINE_MS} ms: ${stderr.slice(-800)}`)); }, DEADLINE_MS);
    const done = (outcome) => { clearTimeout(timer); child.kill('SIGKILL'); child.once('close', () => resolve({ outcome, stdout, stderr, dataDir })); };
    child.stdout.on('data', (chunk) => { stdout += chunk; if (/^READY\r?$/m.test(stdout)) done('ready'); });
    child.once('exit', (code) => done(`exit ${code}`));
  });
}

test('READY follows the checkpoint record being readable from the journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restart-prefix-ready-'));
  try {
    const run = await runKillTool(root);
    assert.equal(run.outcome, 'ready', run.stderr.slice(-800));
    process.env.MIXDOG_DATA_DIR = run.dataDir;
    const { readTurnCheckpointHeader, replayTurnJournal } = await import(JOURNAL);
    const { readdirSync } = await import('node:fs');
    const sessionId = readdirSync(join(run.dataDir, 'turn-checkpoints')).find((name) => name.endsWith('.json')).replace(/\.json$/, '');
    const replayed = replayTurnJournal(readTurnCheckpointHeader(sessionId));
    assert.ok(replayed.turnMessages.some((m) => m.role === 'assistant' && m.toolCalls?.some((call) => call.id === 'call_3')), 'the record the turn stops at is readable at READY');
    assert.equal(replayed.interruption.phase, 'tools');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed journal append never announces READY and fails with the write error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restart-prefix-failed-append-'));
  try {
    const preload = join(root, 'fail-append.mjs');
    writeFileSync(preload, `import { _setJournalOpGateForTest } from ${JSON.stringify(JOURNAL)};\n_setJournalOpGateForTest(async (op) => { if (op.kind === 'append') throw new Error('disk full (injected)'); });\n`);
    const run = await runKillTool(root, [preload]);
    assert.notEqual(run.outcome, 'ready', 'READY was announced while the checkpoint record is not on disk');
    assert.match(run.stderr, /journal write failed[^\n]*disk full \(injected\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});