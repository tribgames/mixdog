// Daemon failure is not a session failure: a view whose daemon is killed
// re-seats itself on the replacement without the user restarting anything.
// Also pins the version-skew verdicts that decide WHICH daemon a view accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-recovery-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
process.env.MIXDOG_ENGINE_DAEMON = '0';
// Deliberately make the first daemon's revision numerically newer than its
// replacement. A correct client treats revisions as attachment-local and
// still accepts the replacement's full snapshot.
process.env.MIXDOG_ENGINE_REVISION_EPOCH = '8000000000000000';
// This test HARD-KILLS the daemon; a throwaway memory runtime under it would
// be orphaned by that kill, so the isolated root runs without one.
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';

const {
  createRemoteEngineSession,
  negotiateEngineDaemon,
  readEngineDaemonDiscovery,
  shutdownEngineDaemon,
} = await import('../src/standalone/engine-daemon-client.mjs');
const { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } = await import('../src/standalone/engine-daemon-protocol.mjs');
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

test('version skew decides between attaching, draining, and staying in-process', () => {
  const version = engineRuntimeVersion();
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL, version }), 'ok');
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL - 1, version }), 'restart');
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL + 1, version }), 'defer');
  // Only the WIRE protocol decides. A different build is not a reason to drain
  // a live daemon mid-turn — closing every view is what picks up new code.
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL, version: '0.0.1' }), 'ok');
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL, version: '999.0.0' }), 'ok');
  // A daemon that answers nothing at all is treated as ancient, never accepted.
  assert.equal(negotiateEngineDaemon({}), 'restart');
});

test('a killed daemon is replaced and the view re-seats itself', async (t) => {
  t.after(async () => {
    await shutdownEngineDaemon();
    killProcessesUnder(ROOT);
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  });

  const recoveryLog = [];
  const engine = await createRemoteEngineSession({
    cwd: process.cwd(),
    log: (line) => recoveryLog.push(String(line)),
  });
  const firstDaemon = readEngineDaemonDiscovery();
  assert.ok(firstDaemon?.pid, 'the view is attached to a live daemon');
  const recoveredSessionId = String(engine.getState().sessionId || '');
  assert.ok(recoveredSessionId);

  // Hard kill: no drain, no goodbye — exactly what a crash looks like.
  process.env.MIXDOG_ENGINE_REVISION_EPOCH = '1000';
  process.kill(firstDaemon.pid, 'SIGKILL');

  await waitFor(() => {
    const current = readEngineDaemonDiscovery();
    return current && Number(current.pid) !== Number(firstDaemon.pid);
  }, 'a replacement daemon takes over discovery');
  await waitFor(() => recoveryLog.some((line) => line.includes('projection recovered')),
    'the session projection re-subscribes to the replacement daemon');

  const state = engine.getState();
  assert.ok(state && typeof state === 'object', 'the recovered view still publishes a snapshot');
  assert.ok(Array.isArray(state.items), 'the recovered snapshot keeps the transcript contract');
  assert.equal(state.sessionId, recoveredSessionId);

  // Reconnection is not complete until later notifications from another view
  // reach the original TUI projection. This is the user-visible contract that
  // a snapshot-only recovery assertion previously missed.
  const peer = await createRemoteEngineSession({ cwd: process.cwd() });
  assert.equal(await peer.resume(recoveredSessionId), true);
  assert.equal(await peer.submitAsync('visible after daemon replacement', {
    id: 'recovery-cross-view-submit',
  }), true);
  await waitFor(
    () => engine.getState().items?.some((item) =>
      item?.id === 'recovery-cross-view-submit'
      || item?.text === 'visible after daemon replacement'),
    'the original view receives a post-restart submission from another view',
  );

  await peer.dispose('recovery peer end');
  await engine.dispose('recovery test end');
});
