import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { desktopSessionSummaries } from './desktop-state.ts';
test('the catalog row carries the daemon’s compaction count only when it is a real one', () => {
  const row = (id, extra) => ({ id, title: `Conversation ${id}`, cwd: '/repos/app', messageCount: 62, ...extra });
  const summaries = desktopSessionSummaries([
    row('sess_compacted', { compactCount: 17 }),
    row('sess_fresh', { compactCount: 0 }),
    row('sess_unknown', {}),
    row('sess_nan', { compactCount: Number.NaN }),
    row('sess_negative', { compactCount: -1 }),
    row('sess_text', { compactCount: '17' }),
  ]);
  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.compactCount]),
    [
      ['sess_compacted', 17],
      ['sess_fresh', 0],
      ['sess_unknown', undefined],
      ['sess_nan', undefined],
      ['sess_negative', undefined],
      ['sess_text', undefined],
    ]
  );
});
