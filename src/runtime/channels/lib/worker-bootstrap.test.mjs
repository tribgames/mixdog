import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('channels-worker-bootstrap');
const { DATA_DIR } = await import('./config.mjs');
const { runWorkerBootstrap } = await import('./worker-bootstrap.mjs');

// A session not touched for weeks is still the user's conversation: loading
// the channels runtime must never delete it.
test('channels boot keeps session files however long they have been untouched', () => {
  const sessions = path.join(DATA_DIR, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const old = path.join(sessions, 'sess_old.json');
  fs.writeFileSync(old, '{"id":"sess_old","messages":[]}');
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, monthAgo, monthAgo);
  runWorkerBootstrap({
    instanceId: 'test',
    isWorkerMode: true,
    pruneStalePluginDataLogSiblings: () => {},
    DEFAULT_STALE_LOG_SIBLING_MAX: 300,
  });
  assert.equal(fs.existsSync(old), true);
});
