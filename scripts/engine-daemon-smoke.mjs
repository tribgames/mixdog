// Real-boot check for the engine daemon: spawn the machine-global daemon, open
// a REAL engine inside it, and prove the snapshot reaches an attached view.
// Runs against an isolated runtime root so it can never touch the user's live
// daemon, sessions, or config.
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-daemon-smoke-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
// The daemon must never inherit a setting that would make ITS engines remote.
process.env.MIXDOG_ENGINE_DAEMON = '0';
// Isolated root: no throwaway Postgres cluster for a transport/boot check.
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';

const { ensureEngineDaemon, attachEngineDaemon, shutdownEngineDaemon } =
  await import('../src/standalone/engine-daemon-client.mjs');
const { killProcessesUnder } = await import('./lib/isolated-root-cleanup.mjs');

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
  const created = await client.call('session.create', { cwd: process.cwd() }, { timeoutMs: 180_000 });
  if (!created?.sessionId) throw new Error('session.create returned no session id');
  const snapshot = created.full || {};
  if (!Array.isArray(snapshot.items)) throw new Error('session snapshot carries no transcript items array');
  console.log(`session created id=${created.sessionId} items=${snapshot.items.length}`);

  const readBack = await client.call('session.read', { sessionId: created.sessionId });
  if (!readBack?.full) throw new Error('session.read returned nothing');

  // ONE daemon: the channels front door must belong to the very same process
  // that just hosted this engine.
  const channelDiscovery = JSON.parse(readFileSync(join(ROOT, 'channel-daemon.json'), 'utf8'));
  if (Number(channelDiscovery.pid) !== Number(discovery.pid)) {
    throw new Error(`channels daemon pid ${channelDiscovery.pid} differs from the engine host ${discovery.pid}`);
  }
  if (Number(channelDiscovery.port) === Number(discovery.port)) {
    throw new Error('channels and engine front doors must not share a port');
  }
  console.log(`one daemon serves both front doors: pid=${discovery.pid} engine=${discovery.port} channels=${channelDiscovery.port}`);

  await client.call('session.unsubscribe', { sessionId: created.sessionId }, { timeoutMs: 60_000 });
  console.log('engine-daemon smoke passed ✓');
} catch (err) {
  fail(err?.stack || err?.message || String(err));
} finally {
  try { await client?.close?.('smoke end'); } catch {}
  try { await shutdownEngineDaemon(); } catch {}
  killProcessesUnder(ROOT);
  try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
}
