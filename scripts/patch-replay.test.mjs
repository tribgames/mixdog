import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { legacyPartialReplayReason, replayOne } from './patch-replay.mjs';

test('partial patch replay captures the pre-mutation state and never recaptures replay failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-patch-capture-'));
  const replayDir = join(root, 'replays');
  mkdirSync(replayDir);
  writeFileSync(join(root, 'good.txt'), 'one\n');
  writeFileSync(join(root, 'stale.txt'), 'actual\n');
  const previousDir = process.env.MIXDOG_PATCH_REPLAY_DIR;
  const previousCapture = process.env.MIXDOG_PATCH_REPLAY_CAPTURE;
  process.env.MIXDOG_PATCH_REPLAY_DIR = replayDir;
  process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '1';
  try {
    const result = await executePatchTool('apply_patch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: good.txt',
        '@@',
        '-one',
        '+two',
        '*** Update File: stale.txt',
        '@@',
        '-expected',
        '+next',
        '*** End Patch',
        '',
      ].join('\n'),
    }, root, { sessionId: 'session-test', toolCallId: 'call-test' });
    assert.match(result, /^Error: apply_patch file-level partial: 1\/2/m);
    const captures = readdirSync(replayDir).filter((file) => file.endsWith('.json'));
    assert.equal(captures.length, 1);
    const record = JSON.parse(readFileSync(join(replayDir, captures[0]), 'utf8'));
    assert.equal(record.snapshot_phase, 'pre');
    assert.equal(record.file_snapshots['good.txt'], 'one\n');
    assert.equal(record.file_snapshots['stale.txt'], 'actual\n');
    assert.deepEqual(record.outcome, {
      kind: 'partial',
      applied: 1,
      total: 2,
      rejected: 1,
      rejectedTargets: ['stale.txt'],
    });
    assert.equal(record.session_id, 'session-test');
    assert.equal(record.tool_call_id, 'call-test');
    assert.match(record.error_text, /expected first old line/);

    const replayed = await replayOne(record);
    assert.equal(replayed.skipped, false);
    assert.equal(replayed.ok, false);
    assert.equal(readdirSync(replayDir).filter((file) => file.endsWith('.json')).length, 1);
  } finally {
    if (previousDir === undefined) delete process.env.MIXDOG_PATCH_REPLAY_DIR;
    else process.env.MIXDOG_PATCH_REPLAY_DIR = previousDir;
    if (previousCapture === undefined) delete process.env.MIXDOG_PATCH_REPLAY_CAPTURE;
    else process.env.MIXDOG_PATCH_REPLAY_CAPTURE = previousCapture;
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy partial captures are skipped instead of producing misleading replay failures', () => {
  assert.match(legacyPartialReplayReason({
    error_first_line: 'Error: apply_patch file-level partial: 1/2 file(s) applied to disk (committed); 1 file(s) rejected',
  }), /post-mutation snapshots/);
  assert.equal(legacyPartialReplayReason({
    snapshot_phase: 'pre',
    outcome: { kind: 'partial' },
  }), null);
});

test('replay snapshots cannot write outside the throwaway replay root', async () => {
  const escaped = join(tmpdir(), `mixdog-patch-replay-escape-${process.pid}-${Date.now()}.txt`);
  try {
    const result = await replayOne({
      id: 'unsafe-snapshot',
      args: { patch: '*** Begin Patch\n*** End Patch\n' },
      file_snapshots: {
        [`../${escaped.split(/[\\/]/).at(-1)}`]: 'must not be written',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.after, /unsafe snapshot path/);
    assert.equal(existsSync(escaped), false);
  } finally {
    rmSync(escaped, { force: true });
  }
});
