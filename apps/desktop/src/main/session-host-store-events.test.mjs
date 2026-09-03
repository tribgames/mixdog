import test from 'node:test';
import assert from 'node:assert/strict';

import { catalogRelevantStoreEntry } from './session-host';

test('only catalog-bearing data directory entries trigger a store rescan', () => {
  for (const name of ['sessions', 'sessions\\abc.json', 'session-summaries.json', 'agent-workers.json', 'lead-workers.json', 'turn-checkpoints']) {
    assert.equal(catalogRelevantStoreEntry(name), true, name);
  }
  for (const name of [
    'session-summaries.json.lock',
    '.session-summaries.json.6ccfe3f4.tmp',
    'shell-jobs',
    'shell-output\\x.stdout',
    'memory-runtime-proxy.log',
    'daemon-owner.json',
  ]) {
    assert.equal(catalogRelevantStoreEntry(name), false, name);
  }
  // An unnamed event (platform gave no filename) still refreshes.
  assert.equal(catalogRelevantStoreEntry(null), true);
});
