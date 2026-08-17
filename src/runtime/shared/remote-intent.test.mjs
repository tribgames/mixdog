import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRemoteIntent, remoteIntentMatchesSession } from './remote-intent.mjs';

test('remote intent matches only its own session and cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-remote-intent-'));
  const path = join(dir, 'channel-remote-intent.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessionId: 'sess_link',
      transcriptPath: join(dir, 'sess_link.jsonl'),
      cwd: dir,
      updatedAt: Date.now(),
    }));
    assert.equal(readRemoteIntent(path)?.sessionId, 'sess_link');
    assert.equal(remoteIntentMatchesSession('sess_link', dir, path), true);
    assert.equal(remoteIntentMatchesSession('sess_other', dir, path), false);
    assert.equal(remoteIntentMatchesSession('sess_link', join(dir, 'nested'), path), false);
    assert.equal(remoteIntentMatchesSession('', dir, path), false);
    assert.equal(remoteIntentMatchesSession('sess_link', dir, join(dir, 'missing.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed intent record never claims a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-remote-intent-bad-'));
  const path = join(dir, 'channel-remote-intent.json');
  try {
    writeFileSync(path, JSON.stringify({ sessionId: 'sess_link' }));
    assert.equal(readRemoteIntent(path), null);
    assert.equal(remoteIntentMatchesSession('sess_link', dir, path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
