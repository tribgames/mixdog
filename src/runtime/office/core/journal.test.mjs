import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { listOfficeJournals, readOfficeJournal, writeOfficeJournal } from './journal.mjs';

test('a NUL-filled office journal reads as absent and does not block the listing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-office-journal-'));
  try {
    await writeOfficeJournal({ id: 'good', updatedAt: new Date().toISOString() }, dir);
    mkdirSync(join(dir, 'office-transactions'), { recursive: true });
    writeFileSync(join(dir, 'office-transactions', 'bad.json'), Buffer.alloc(32));
    assert.equal(await readOfficeJournal('bad', dir), null);
    assert.equal((await readOfficeJournal('good', dir)).id, 'good');
    assert.deepEqual(
      (await listOfficeJournals(dir)).map((record) => record.id),
      ['good']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
