// Replay of native/core/fixtures/session-host-lifecycle-cases "failed metadata flushing cannot prevent host attachment cleanup" on
// this checkout's desktop service: K1's desktop process (desktop-service.ts `SessionHost.create`) still keeps the per-session
// metadata (read cursors, favorites, titles) in `<userData>/desktop-session-metadata.json` (desktop-session-metadata.ts,
// session-metadata-file.ts). The metadata path is made a directory, a read cursor is marked (its write is deferred), and the host is
// disposed: the dispose must reject with the metadata error and the core attachment must still be closed once. Compared whole.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { SessionHost } from './session-host.ts';

const NAME = 'failed metadata flushing cannot prevent host attachment cleanup';
const golden = JSON.parse(await readFile(new URL('../../../../native/core/fixtures/session-host-lifecycle-cases/golden.json', import.meta.url), 'utf8'));

test(NAME, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-host-lifecycle-replay-'));
  let closes = 0;
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close: async () => { closes++; } }),
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'error', () => {});
  await host.listSessions();
  await mkdir(join(root, 'desktop-session-metadata.json'));
  await host.markSessionRead('session-a', 2, false);
  let outcome;
  try {
    await host.dispose();
    outcome = { resolved: true };
  } catch (error) {
    outcome = { rejected: error };
  }
  const observed = { metadataPathIsADirectory: 'desktop-session-metadata.json', disposeOutcome: outcome, closes };
  assert.deepStrictEqual(exact(observed), golden.cases.find((entry) => entry.case === NAME).observed);
});
