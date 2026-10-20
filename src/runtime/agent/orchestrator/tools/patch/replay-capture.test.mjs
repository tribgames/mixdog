import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { maybeCapturePatchReplay } from './replay-capture.mjs';

test('a captured replay record is published whole, with no temp file left behind', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-replay-capture-'));
  const previous = process.env.MIXDOG_PATCH_REPLAY_DIR;
  process.env.MIXDOG_PATCH_REPLAY_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_PATCH_REPLAY_DIR;
    else process.env.MIXDOG_PATCH_REPLAY_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  maybeCapturePatchReplay(
    {
      args: { patch: 'x' },
      basePath: dir,
      sessionId: 's',
      toolCallId: 'c',
      targets: [],
      fileSnapshots: {},
      fileSnapshotMeta: {},
      snapshotPhase: 'pre',
    },
    'boom\nsecond line'
  );
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
  const record = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(record.error_first_line, 'boom');
  assert.equal(record.tool, 'apply_patch');
});
