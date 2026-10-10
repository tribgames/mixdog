import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// MIXDOG_DATA_DIR must be set before the store resolves the sessions dir.
const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-liveness-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { _isActivelyOwnedElsewhere } = await import('./session-owner-liveness.mjs');

const sessionsDir = join(root, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
// Windows pids are multiples of 4 and POSIX pid_max stays far below this, so
// no live process can hold it.
const DEAD_PID = 4_194_303;
let sequence = 0;
const nextSessionId = () => `sess_desktop_liveness${++sequence}`;
const sidecar = (sessionId, extension, pid) =>
  writeFileSync(join(sessionsDir, `${sessionId}${extension}`), `${Date.now()}\n${pid}\n`, 'utf8');
// What a session file looks like right after its owner process died
// mid-conversation: the persisted heartbeat is fresh.
const recentlyActive = (extra = {}) => ({ lastHeartbeatAt: Date.now() - 30_000, ...extra });

test('a restart inside the heartbeat window resumes as owner when no sidecar proves a live owner', () => {
  const sessionId = nextSessionId();
  assert.equal(_isActivelyOwnedElsewhere(recentlyActive(), sessionId), false);
});

test('a recorded host pid held by an unrelated live process is not an owner', () => {
  const sessionId = nextSessionId();
  assert.equal(_isActivelyOwnedElsewhere(recentlyActive({ clientHostPid: process.pid }), sessionId), false);
});

test('fresh presence held by a live process still attaches as a viewer', () => {
  const sessionId = nextSessionId();
  sidecar(sessionId, '.own', process.pid);
  assert.equal(_isActivelyOwnedElsewhere(recentlyActive(), sessionId), true);
});

test('fresh heartbeat held by a live process still attaches as a viewer', () => {
  const sessionId = nextSessionId();
  sidecar(sessionId, '.hb', process.pid);
  assert.equal(_isActivelyOwnedElsewhere(recentlyActive(), sessionId), true);
});

test('presence left by a dead owner is cleared and the session resumes as owner', () => {
  const sessionId = nextSessionId();
  sidecar(sessionId, '.own', DEAD_PID);
  assert.equal(_isActivelyOwnedElsewhere(recentlyActive(), sessionId), false);
  assert.equal(existsSync(join(sessionsDir, `${sessionId}.own`)), false);
});
