// A statusline route a session open queued is on disk once the daemon's
// graceful shutdown returns, however slowly the disk publishes it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchObservedDaemon } from './test-fixtures/daemon-steady-harness.mjs';

const ROUTE_STORE = 'gateway-session-routes.json';

test('graceful shutdown lands the statusline route changes sessions queued', async (t) => {
  // Loaded into the daemon first: publishing the route store takes 6 s, longer
  // than the rest of a shutdown, so only a drain keeps the change.
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-route-drain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mutation = join(dir, 'slow-route-store.mjs');
  writeFileSync(
    mutation,
    [
      "import fsp from 'node:fs/promises';",
      "import { syncBuiltinESMExports } from 'node:module';",
      'const rename = fsp.rename;',
      `fsp.rename = async (from, to) => { if (String(to).endsWith('${ROUTE_STORE}')) await new Promise((r) => setTimeout(r, 6000)); return rename(from, to); };`,
      'syncBuiltinESMExports();',
      '',
    ].join('\n')
  );
  const daemon = await launchObservedDaemon({ mutation });
  let sessionId = '';
  try {
    [sessionId] = await daemon.openSessions(1);
  } catch (error) {
    await daemon.dispose();
    throw error;
  }
  await daemon.dispose({
    afterExit: (stopError) => {
      assert.equal(stopError, null, 'the daemon did not shut down gracefully');
      const store = JSON.parse(readFileSync(join(daemon.dataDir, ROUTE_STORE), 'utf8'));
      const routes = [...Object.values(store.sessionHosts || {}), ...Object.values(store.sessions || {})];
      assert.ok(
        routes.some((route) => route.sessionId === sessionId),
        `the route of ${sessionId} was lost at shutdown`
      );
    },
  });
});
