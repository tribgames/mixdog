import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { powershellHostProgram } from '../backend/program.ts';

// Source-text on purpose. The PowerShell host program only runs on a real
// desktop, so these ordering/absence invariants inside its function bodies have no
// runnable surface in the fast lane. They read every host module plus the program text.
const hostDirectory = new URL('../', import.meta.url);
const hostFiles = (await readdir(hostDirectory, { recursive: true }))
  .map((name) => name.split('\\').join('/'))
  .filter((name) => name.endsWith('.ts') && !name.startsWith('harness/'))
  .sort();
const hostSource = [
  ...(await Promise.all(hostFiles.map((name) => readFile(new URL(name, hostDirectory), 'utf8')))),
  powershellHostProgram(),
].join('\n');

test('focus recovery falls back to the owner when the action closed its window', () => {
  const start = hostSource.indexOf('function Restore-InputRecoveryState($req)');
  assert.ok(start > 0);
  const body = hostSource.slice(start, start + 1_200);
  assert.ok(body.includes("$restoredTarget = 'owner'"));
  // The recovered owner is validated, and landing anywhere else still counts as a miss.
  assert.ok(body.includes('input recovery restore window is stale or invalid'));
  // The owner is recorded while the window still exists: a destroyed handle can no longer name it.
  assert.match(hostSource, /restore_owner_window_id\s*=\s*\$restoreOwnerId/);
  // Landing anywhere else still counts as a miss: the TypeScript verification accepts the owner only when one was recorded.
  assert.match(hostSource, /restoredTarget === 'owner' &&\s*\n\s*inputRecovery\.restoreOwnerWindowId !== ''/);
});

test('waiting on a condition never invalidates the refs the caller holds', () => {
  const start = hostSource.indexOf('function Get-WindowPredicates($req)');
  const end = hostSource.indexOf('function Get-MenuCandidates(', start);
  assert.ok(start > 0 && end > start);
  // Snapshot-Window bumps the generation and clears the map; a predicate read must do neither.
  assert.doesNotMatch(hostSource.slice(start, end), /\$state\.Map\.Clear\(\)|\$state\.Generation/);
});

test('post-mutation settle waits out its budget instead of exiting on a transition start', () => {
  const settle = hostSource.indexOf('if (settleDelayMs > 0) await sleep(');
  assert.ok(settle > 0);
  assert.doesNotMatch(hostSource.slice(Math.max(0, settle - 500), settle + 500), /(opened|closed)_windows\.length/);
});

test('capture change summary survives the invalidation a mutation performs', () => {
  const invalidation = hostSource.indexOf('if (OBSERVATION_BOUND_INPUT_ACTIONS.has(action)) {');
  assert.ok(invalidation > 0);
  assert.equal(hostSource.slice(invalidation - 400, invalidation + 200).includes('lastCaptureBySession'), false);
});
