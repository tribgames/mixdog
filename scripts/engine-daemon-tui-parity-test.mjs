// TUI parity over the engine daemon: the terminal store is created by the very
// same createEngineSession() seam, so the only thing that can break the TUI is
// state that does not survive the wire. Boot a LOCAL engine and a REMOTE one in
// the same isolated root and hold their snapshots to the same contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-parity-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
delete process.env.MIXDOG_ENGINE_DAEMON;

const engineModule = await import('../src/tui/engine.mjs');
const { shutdownEngineDaemon } = await import('../src/standalone/engine-daemon-client.mjs');

// Values that cannot cross a process boundary by construction; the TUI reads
// them through store METHODS, never off the snapshot.
function wireCarryable(value) {
  const type = typeof value;
  return !(type === 'function' || type === 'symbol' || type === 'undefined');
}

test('a daemon-hosted store carries the same snapshot contract as an in-process one', async (t) => {
  t.after(async () => {
    await shutdownEngineDaemon();
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  });

  const local = await engineModule.createEngineSession({ toolMode: 'full', cwd: process.cwd() });
  const localState = local.getState();
  assert.ok(localState && typeof localState === 'object', 'the in-process store publishes a snapshot');

  process.env.MIXDOG_ENGINE_DAEMON = 'strict';
  let remote;
  try {
    remote = await engineModule.createEngineSession({ toolMode: 'full', cwd: process.cwd() });
  } finally {
    delete process.env.MIXDOG_ENGINE_DAEMON;
  }
  assert.equal(remote.isRemoteEngine, true, 'the seam returns a daemon view when the daemon is requested');

  const remoteState = remote.getState();
  const missing = Object.entries(localState)
    .filter(([key, value]) => wireCarryable(value) && !(key in remoteState))
    .map(([key]) => key);
  assert.deepEqual(missing, [], 'every serializable snapshot field survives the daemon hop');

  const mismatched = Object.entries(localState)
    .filter(([key, value]) => wireCarryable(value) && key in remoteState)
    .filter(([key, value]) => {
      const left = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      const right = Array.isArray(remoteState[key]) ? 'array'
        : remoteState[key] === null ? 'null' : typeof remoteState[key];
      return left !== right && !(left === 'object' && right === 'null');
    })
    .map(([key]) => key);
  assert.deepEqual(mismatched, [], 'snapshot field types are preserved across the daemon hop');

  // A store METHOD must round-trip through the daemon, not just state.
  const sessions = await remote.listSessions();
  assert.ok(Array.isArray(sessions), 'listSessions() answers over the daemon');

  await remote.dispose('parity end');
  await local.dispose('parity end');
});
