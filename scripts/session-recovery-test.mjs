// Daemon failure is not a session failure: a view whose daemon is killed
// re-seats itself on the replacement without the user restarting anything.
// The development wire contract stays fixed at protocol 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-session-transport-recovery-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
// Deliberately make the first daemon's revision numerically newer than its
// replacement. A correct client treats revisions as attachment-local and
// still accepts the replacement's full snapshot.
process.env.MIXDOG_SESSION_REVISION_EPOCH = '8000000000000000';
// This test HARD-KILLS the daemon; a throwaway memory runtime under it would
// be orphaned by that kill, so the isolated root runs without one.
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';

const {
  createSession,
  readSessionDiscovery,
  shutdownDaemon,
} = await import('../src/standalone/session-client.mjs');
const { SESSION_PROTOCOL } = await import('../src/standalone/session-wire.mjs');
const { killProcessesUnder } = await import('./lib/isolated-root-cleanup.mjs');

function waitFor(predicate, message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // Ref'd on purpose: the client's own recovery timers are unref'd (a real
    // host always has the TUI/Electron loop alive), so the test must hold the
    // loop open itself while the replacement daemon boots.
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

test('the session protocol remains v1', () => {
  assert.equal(SESSION_PROTOCOL, 1);
});

test('a killed daemon is replaced and the view re-seats itself', async (t) => {
  let runtime = null;
  let peer = null;
  t.after(async () => {
    try { await peer?.dispose('recovery cleanup'); } catch {}
    try { await runtime?.dispose('recovery cleanup'); } catch {}
    await shutdownDaemon();
    killProcessesUnder(ROOT);
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  });

  const recoveryLog = [];
  runtime = await createSession({
    cwd: process.cwd(),
    log: (line) => recoveryLog.push(String(line)),
  });
  const firstDaemon = readSessionDiscovery();
  assert.ok(firstDaemon?.pid, 'the view is attached to a live daemon');
  const recoveredSessionId = String(runtime.getState().sessionId || '');
  assert.ok(recoveredSessionId);

  // Hard kill: no drain, no goodbye — exactly what a crash looks like.
  process.env.MIXDOG_SESSION_REVISION_EPOCH = '1000';
  process.kill(firstDaemon.pid, 'SIGKILL');

  await waitFor(() => {
    const current = readSessionDiscovery();
    return current && Number(current.pid) !== Number(firstDaemon.pid);
  }, 'a replacement daemon takes over discovery');
  await waitFor(() => recoveryLog.some((line) => line.includes('projection recovered')),
    'the session projection re-subscribes to the replacement daemon');

  const state = runtime.getState();
  assert.ok(state && typeof state === 'object', 'the recovered view still publishes a snapshot');
  assert.ok(Array.isArray(state.items), 'the recovered snapshot keeps the transcript contract');
  assert.equal(state.sessionId, recoveredSessionId);

  // Reconnection is not complete until later notifications from another view
  // reach the original TUI projection. This is the user-visible contract that
  // a snapshot-only recovery assertion previously missed.
  peer = await createSession({ cwd: process.cwd() });
  assert.equal(await peer.resume(recoveredSessionId), true);
  assert.equal(await peer.submitAsync('visible after daemon replacement', {
    id: 'recovery-cross-view-submit',
  }), true);
  await waitFor(
    () => runtime.getState().items?.some((item) =>
      item?.id === 'recovery-cross-view-submit'
      || item?.text === 'visible after daemon replacement'),
    'the original view receives a post-restart submission from another view',
  );

  await peer.dispose('recovery peer end');
  peer = null;
  await runtime.dispose('recovery test end');
  runtime = null;
});
