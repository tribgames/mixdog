import assert from 'node:assert/strict';
import test from 'node:test';

import { browserPartitionUserAgent } from './user-agent.ts';

const ELECTRON_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog-desktop/0.9.171 Chrome/146.0.7680.216 Electron/41.10.6 Safari/537.36';
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.216 Safari/537.36';

test('a page is told the Chrome build rendering it, not the app embedding it', () => {
  const agent = browserPartitionUserAgent(ELECTRON_DEFAULT);
  assert.equal(agent, CHROME, 'the agent string must match the client hints this partition sends');
  assert.doesNotMatch(agent, /mixdog|electron/i, 'an app version is a fingerprint sites never need');
});

test('an agent string that already names Chrome alone is left untouched', () => {
  assert.equal(browserPartitionUserAgent(CHROME), CHROME);
});
