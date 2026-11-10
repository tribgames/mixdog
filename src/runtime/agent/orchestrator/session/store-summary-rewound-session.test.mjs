// A session whose every prompt was rewound away (desktop Esc-Esc message
// selector → rewindToItem on the first prompt) keeps its title but has zero
// user/assistant messages. It is a real conversation, not boot scratch: the
// catalog must keep listing it, otherwise the sidebar row and the open tab
// (closed on a catalog removal) vanish while the file stays on disk.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _sessionSummary } from './store-summary-index.mjs';
import { isLeadVisibleRow, normalizedRow } from './store-summary-catalog.mjs';
import { listLeadSessions } from '../../../../session-runtime/lifecycle/session-catalog.mjs';

const system = { role: 'system', content: '# Session\nCwd: C:\\work' };
const rewound = (extra = {}) => ({
  id: 'sess_desktop_rewound_first_prompt',
  updatedAt: 1,
  owner: 'cli',
  agent: 'lead',
  sourceType: 'lead',
  messages: [system],
  ...extra,
});

test('a titled session rewound to zero messages stays in both catalog filters', () => {
  const summary = _sessionSummary(rewound({ title: 'Writing a 600-Word Fox Story' }));
  assert.equal(summary.messageCount, 0);
  assert.equal(summary.preview, '');
  assert.equal(isLeadVisibleRow(normalizedRow(summary)), true);
  const rows = listLeadSessions({ listSessions: () => [rewound({ title: 'Writing a 600-Word Fox Story' })] });
  assert.deepEqual(
    rows.map((row) => [row.id, row.messageCount, row.title]),
    [['sess_desktop_rewound_first_prompt', 0, 'Writing a 600-Word Fox Story']]
  );
});

test('an untitled zero-message session is still hidden scratch', () => {
  const summary = _sessionSummary(rewound());
  assert.equal(isLeadVisibleRow(normalizedRow(summary)), false);
  assert.deepEqual(listLeadSessions({ listSessions: () => [rewound()] }), []);
});
