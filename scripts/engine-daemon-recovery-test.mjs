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
delete process.env.MIXDOG_ENGINE_DAEMON;

const {
  createRemoteEngineSession,
  negotiateEngineDaemon,
  readEngineDaemonDiscovery,
  shutdownEngineDaemon,
} = await import('../src/standalone/engine-daemon-client.mjs');
const { ENGINE_DAEMON_PROTOCOL, engineRuntimeVersion } = await import('../src/standalone/engine-daemon-protocol.mjs');

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
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL, version: '0.0.1' }), 'restart');
  assert.equal(negotiateEngineDaemon({ protocol: ENGINE_DAEMON_PROTOCOL, version: '999.0.0' }), 'defer');
  // A daemon that answers nothing at all is treated as ancient, never accepted.
  assert.equal(negotiateEngineDaemon({}), 'restart');
});

test('a killed daemon is replaced and the view re-seats itself', async (t) => {
  t.after(async () => {
    await shutdownEngineDaemon();
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  });

  const engine = await createRemoteEngineSession({ cwd: process.cwd() });
  const firstEngineId = engine.engineId;
  const firstDaemon = readEngineDaemonDiscovery();
  assert.ok(firstDaemon?.pid, 'the view is attached to a live daemon');

  // Hard kill: no drain, no goodbye — exactly what a crash looks like.
  process.kill(firstDaemon.pid, 'SIGKILL');

  await waitFor(() => {
    const current = readEngineDaemonDiscovery();
    return current && Number(current.pid) !== Number(firstDaemon.pid);
  }, 'a replacement daemon takes over discovery');
  await waitFor(() => engine.engineId !== firstEngineId, 'the view re-seats onto a fresh engine');

  const state = engine.getState();
  assert.ok(state && typeof state === 'object', 'the recovered view still publishes a snapshot');
  assert.ok(Array.isArray(state.items), 'the recovered snapshot keeps the transcript contract');

  await engine.dispose('recovery test end');
});
