// Real-boot check for the engine daemon: spawn the machine-global daemon, open
// a REAL engine inside it, and prove the snapshot reaches an attached view.
// Runs against an isolated runtime root so it can never touch the user's live
// daemon, sessions, or config.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-smoke-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
// The daemon must never inherit an opt-in that would make ITS engines remote.
delete process.env.MIXDOG_ENGINE_DAEMON;

const { ensureEngineDaemon, attachEngineDaemon, shutdownEngineDaemon } =
  await import('../src/standalone/engine-daemon-client.mjs');

function fail(message) {
  console.error(`engine-daemon-smoke: ${message}`);
  process.exitCode = 1;
}

const started = Date.now();
let client = null;
try {
  const discovery = await ensureEngineDaemon({ cwd: process.cwd() });
  if (!discovery?.port) throw new Error('daemon discovery is missing a port');
  console.log(`daemon ready pid=${discovery.pid} port=${discovery.port} in ${Date.now() - started}ms`);

  const frames = [];
  client = await attachEngineDaemon({
    discovery,
    cwd: process.cwd(),
    onFrame: (frame) => frames.push(frame),
  });
  const opened = await client.call('engine.open', { cwd: process.cwd() }, { timeoutMs: 180_000 });
  if (!opened?.engineId) throw new Error('engine.open returned no engine id');
  const snapshot = opened.snapshot || {};
  if (!Array.isArray(snapshot.items)) throw new Error('engine snapshot carries no transcript items array');
  console.log(`engine opened id=${opened.engineId} session=${snapshot.sessionId || '-'} items=${snapshot.items.length}`);

  const listed = await client.call('engine.list', {});
  if (!listed?.engines?.some((row) => row.engineId === opened.engineId)) {
    throw new Error('engine.list does not report the opened engine');
  }
  const readBack = await client.call('engine.snapshot', { engineId: opened.engineId });
  if (!readBack?.snapshot) throw new Error('engine.snapshot returned nothing');

  await client.call('engine.dispose', { engineId: opened.engineId, reason: 'smoke end' }, { timeoutMs: 60_000 });
  console.log('engine-daemon smoke passed ✓');
} catch (err) {
  fail(err?.stack || err?.message || String(err));
} finally {
  try { await client?.close?.('smoke end'); } catch {}
  try { await shutdownEngineDaemon(); } catch {}
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
