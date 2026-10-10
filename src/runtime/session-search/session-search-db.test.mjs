import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionSearchRows } from './session-search-db.mjs';

test('search rows keep conversation prose and drop synthetic, tool and reminder text', () => {
  const rows = sessionSearchRows('s1', [
    { role: 'user', content: 'Fix the login bug<system-reminder>internal</system-reminder>', ts: 10 },
    { role: 'tool', content: 'tool output' },
    { role: 'user', content: '[mixdog-runtime] internal nudge' },
    { role: 'assistant', content: [{ type: 'text', text: 'The login check now trims input.' }], ts: '20' },
    { role: 'assistant', content: '.' },
  ]);

  assert.deepEqual(
    rows.map(({ role, ordinal, ts, content }) => ({ role, ordinal, ts, content })),
    [
      { role: 'user', ordinal: 0, ts: 10, content: 'Fix the login bug' },
      { role: 'assistant', ordinal: 3, ts: 20, content: 'The login check now trims input.' },
    ]
  );
  assert.equal(new Set(rows.map(({ sourceRef }) => sourceRef)).size, 2);
  assert.ok(rows.every(({ sourceRef }) => sourceRef.startsWith('session:s1:')));
});

test('the same message keeps its identity across repeated ingests', () => {
  const messages = [{ role: 'user', content: 'Same prompt', ts: 5 }];

  assert.equal(sessionSearchRows('s1', messages)[0].sourceRef, sessionSearchRows('s1', messages)[0].sourceRef);
});
