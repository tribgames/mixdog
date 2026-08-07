// TUI parity over the session transport: the product facade creates a remote view,
// while the daemon-only module creates the source store. Boot both in the same
// isolated root and hold their snapshots to the same contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from '../src/standalone/session-protocol.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-session-parity-'));
process.env.MIXDOG_RUNTIME_ROOT = ROOT;
process.env.MIXDOG_DATA_DIR = ROOT;
// A suite started from inside mixdog can inherit the daemon-host marker.
// Product callers must still exercise the external daemon path here.
delete process.env.MIXDOG_DAEMON_HOST;
// Product callers are daemon-only. This parity test requests its local
// comparison store through the explicit test/host constructor.
process.env.MIXDOG_DAEMON_SKIP_MEMORY = '1';
// MIXDOG_DAEMON_SKIP_MEMORY only covers the DAEMON's memory runtime. The local
// comparison store is built in THIS process, and its session boot pulls core
// memory — which initdb'd a throwaway Postgres cluster into the isolated root
// and left the suite spinning for minutes. Core memory is not part of the
// snapshot contract under test, so opt out of that boot entirely.
process.env.MIXDOG_BOOT_CORE_MEMORY = '0';
// This is a store-wire parity test, not a provider/network warmup test.
// Keep short-lived local and daemon runtimes from opening catalog/usage TLS
// sockets that outlive the assertion and make Node's test runner wait.
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
process.env.MIXDOG_DISABLE_MODEL_CATALOG_WARMUP = '1';
process.env.MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS = '60000';
process.env.MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS = '60000';

const sessionModule = await import('../src/tui/session.mjs');
const localSessionModule = await import('../src/tui/session-local.mjs');
const { shutdownDaemon } = await import('../src/standalone/session-client.mjs');
const { killProcessesUnder } = await import('./lib/isolated-root-cleanup.mjs');

// Values that cannot cross a process boundary by construction; the TUI reads
// them through store METHODS, never off the snapshot.
function wireCarryable(value) {
  const type = typeof value;
  return !(type === 'function' || type === 'symbol' || type === 'undefined');
}

test('a daemon-hosted store carries the same snapshot contract as an in-process one', async (t) => {
  t.after(async () => {
    await shutdownDaemon();
    killProcessesUnder(ROOT);
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  });

  const local = await localSessionModule.createLocalSessionRuntime({ toolMode: 'full', cwd: process.cwd() });
  const localState = local.getState();
  assert.ok(localState && typeof localState === 'object', 'the in-process store publishes a snapshot');

  const contractSource = readFileSync(
    new URL('../apps/desktop/src/shared/contract.ts', import.meta.url),
    'utf8',
  );
  const capabilitiesFrom = (name) => {
    const marker = `export const ${name} = [`;
    const start = contractSource.indexOf(marker);
    const end = start < 0 ? -1 : contractSource.indexOf('] as const', start + marker.length);
    const block = start < 0 || end < 0
      ? ''
      : contractSource.slice(start + marker.length, end);
    return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  };
  const desktopCapabilities = capabilitiesFrom('DESKTOP_CAPABILITIES');
  const desktopReadCapabilities = new Set(capabilitiesFrom('DESKTOP_READ_CAPABILITIES'));
  const readActions = new Set(SESSION_READ_ACTIONS);
  const configureActions = new Set(SESSION_CONFIGURE_ACTIONS);
  assert.deepEqual(
    [...readActions, ...configureActions].filter((name) => typeof local[name] !== 'function'),
    [],
    'every finite session action exists on the daemon-hosted session runtime',
  );
  assert.deepEqual(
    desktopCapabilities.filter((name) =>
      desktopReadCapabilities.has(name) ? !readActions.has(name) : !configureActions.has(name)),
    [],
    'every desktop capability is routed through the matching finite session lane',
  );
  assert.deepEqual(
    desktopCapabilities.filter((name) => typeof local[name] !== 'function'),
    [],
    'every desktop capability exists on the daemon-hosted session runtime',
  );
  await local.dispose('parity local snapshot captured');

  const remote = await sessionModule.createSessionRuntime({ toolMode: 'full', cwd: process.cwd() });
  assert.equal(remote.isRemoteSession, true, 'the seam returns a daemon view when the daemon is requested');

  const remoteState = remote.getState();
  assert.match(
    remoteState.sessionId,
    /^sess_daemon_/,
    'the daemon reserves a durable session address before the first prompt',
  );
  const missing = Object.entries(localState)
    .filter(([key, value]) => wireCarryable(value) && !(key in remoteState))
    .map(([key]) => key);
  assert.deepEqual(missing, [], 'every serializable snapshot field survives the daemon hop');

  const mismatched = Object.entries(localState)
    // A local blank store has no durable address yet; the daemon intentionally
    // reserves one before provider startup so submit can be ACKed by sessionId.
    .filter(([key]) => key !== 'sessionId')
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
});
