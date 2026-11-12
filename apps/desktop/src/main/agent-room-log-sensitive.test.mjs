// The room list's preview follows the row as the log stored it: a member's
// speech whose sensitive values the daemon replaced shows the marker there.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoomLog } from './agent-room-log.ts';

test('the preview is the stored row, a sensitive value as the marker', async () => {
  const rooms = { abc123: { id: 'abc123' } };
  const log = createRoomLog(
    {
      appendRows: async (_id, rows) => ({ rows: rows.map((row) => ({ ...row, text: row.text.replace('482913', '[redacted]') })) }),
      readItems: async () => [],
      republishCatalog: () => {},
    },
    () => rooms
  );
  await log.post('abc123', [{ id: 's1', kind: 'speech', speaker: 'gh', at: 1, text: 'the code is 482913' }]);
  assert.equal(rooms.abc123.lastPreview, 'the code is [redacted]');
});
