// The clean-up preview reads each session's last activity and title; it must
// not replay a session's whole log for them.
import '../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-wt-activity-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { loadSession } = await import('../../agent/orchestrator/session/store.mjs');
const { encodeAppend, encodeCompacted, encodePatch, encodeSessionRecord } = await import(
  '../../agent/orchestrator/session/store/session-log-format.mjs'
);
const { setLiveSession, _clearLiveSession } = await import('../../agent/orchestrator/session/store/live-state.mjs');
const { forgetSessionLoadCache } = await import('../../agent/orchestrator/session/store/load-cache.mjs');
const { storedSessionActivity } = await import('./maintenance.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

test('stored, live and missing sessions answer as before, and a stored log is not replayed', async () => {
  const id = 'sess_wt_activity_stored';
  const logPath = join(root, 'sessions', `${id}.log.jsonl`);
  const message = JSON.stringify({ role: 'user', content: 'k'.repeat(512 * 1024) });
  let text =
    encodeSessionRecord({ logId: 'L1', id, legacy: null, header: { id, title: 'first', lastUsedAt: 1000 } }) +
    encodeCompacted(1, [message]);
  for (let i = 0; i < 20; i += 1) text += encodeAppend(2 + i, 2 + i, [message]);
  text += encodePatch(22, [['title', '"renamed"'], ['lastHeartbeatAt', '5000']], []);
  writeFileSync(logPath, text);
  const size = statSync(logPath).size;

  const live = 'sess_wt_activity_live';
  setLiveSession({ id: live, owner: 'agent', title: 'in memory', lastUsedAt: 7000, messages: [] });

  let bytes = 0;
  const { readSync, readFileSync } = fs;
  fs.readSync = (...args) => {
    const got = readSync(...args);
    bytes += got;
    return got;
  };
  fs.readFileSync = (...args) => {
    const got = readFileSync(...args);
    bytes += got.length;
    return got;
  };
  syncBuiltinESMExports();
  let got;
  try {
    got = await storedSessionActivity([id, live, 'sess_wt_activity_missing', id]);
    // The header scan reads the log once, never the transcript into a session; a
    // second preview after an append only reads what was appended.
    appendFileSync(logPath, encodePatch(23, [['lastHeartbeatAt', '9000']], []) + encodeAppend(24, 23, [message]));
    bytes = 0;
    const again = await storedSessionActivity([id]);
    assert.equal(again[id].lastActiveAt, 9000);
    assert.ok(bytes < size / 10, `the second preview read ${bytes} of ${size} bytes`);
  } finally {
    fs.readSync = readSync;
    fs.readFileSync = readFileSync;
    syncBuiltinESMExports();
    _clearLiveSession(live);
  }
  assert.deepEqual(got, {
    [id]: { lastActiveAt: 5000, title: 'renamed' },
    [live]: { lastActiveAt: 7000, title: 'in memory' },
  });
  forgetSessionLoadCache(id);
  assert.equal(loadSession(id).title, 'renamed');
});
