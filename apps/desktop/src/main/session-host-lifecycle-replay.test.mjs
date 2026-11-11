// Replay of native/core/fixtures/session-host-lifecycle-cases "failed metadata flushing cannot prevent host attachment cleanup" on
// this checkout's desktop service: K1's desktop process (desktop-service.ts `SessionHost.create`) still keeps the per-session
// metadata (read cursors, favorites, titles) in `<userData>/desktop-session-metadata.json` (desktop-session-metadata.ts,
// session-metadata-file.ts). The metadata path is made a directory, a read cursor is marked (its write is deferred), and the host is
// disposed: the dispose must reject with the metadata error and the core attachment must still be closed once. Compared whole.
// Also "every overlapping host disposal waits for the same attachment cleanup": two disposals at once through the same host
// (session-host.ts `dispose`, memoised in `disposePromise`) while the attachment cleanup is held; each wait is bounded.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exact } from '../../../../benchmarks/rust-core/recorders/lib/exact.mjs';
import { within } from '../../../../benchmarks/rust-core/recorders/lib/recorder-error.mjs';
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

const OVERLAP = 'every overlapping host disposal waits for the same attachment cleanup';

test(OVERLAP, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'session-host-lifecycle-replay-'));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const events = [];
  let closes = 0;
  const close = async () => {
    closes++;
    events.push('cleanup entered');
    entered.resolve();
    await release.promise;
    events.push('cleanup returned');
  };
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    {
      attachSessionClient: async () => ({ list: async () => ({ sessions: [] }), close }),
      loadProjects: async () => ({}),
      loadSessionStore: async () => ({}),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async () => ({}),
    }
  );
  t.after(async () => {
    release.resolve();
    await within('the host disposal at cleanup', host.dispose().catch(() => {}), 10_000);
    await rm(root, { recursive: true, force: true });
  });
  const first = host.dispose().then(() => {
    events.push('first dispose finished');
  });
  await within('the host to start the attachment cleanup', entered.promise, 5000);
  const second = host.dispose().then(() => {
    events.push('second dispose finished');
  });
  events.push('cleanup released');
  release.resolve();
  await within('both overlapping disposals to finish', Promise.all([first, second]), 5000);
  assert.deepStrictEqual(exact({ events, closes }), golden.cases.find((entry) => entry.case === OVERLAP).observed);
});
