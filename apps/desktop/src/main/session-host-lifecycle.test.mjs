import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionHost } from './session-host.ts';

async function fixture(t, close) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-host-lifecycle-'));
  const host = await SessionHost.create({
    userDataPath: root, resourcesPath: root, appPath: root, packaged: false,
  }, {
    attachSessionClient: async () => ({
      list: async () => ({ sessions: [] }),
      close,
    }),
    loadProjects: async () => ({}),
    loadSessionStore: async () => ({}),
    loadStatuslineSegments: async () => ({}),
    executeCodeGraphTool: async () => ({}),
  });
  t.after(async () => {
    // A test may deliberately leave a failed metadata flush as the terminal
    // result. The assertions below own that rejection; cleanup still runs.
    await host.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { host, root };
}

test('every overlapping host disposal waits for the same attachment cleanup', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let closes = 0;
  const { host } = await fixture(t, async () => {
    closes++;
    entered.resolve();
    await release.promise;
  });
  const first = host.dispose();
  await entered.promise;
  let secondFinished = false;
  const second = host.dispose().then(() => { secondFinished = true; });
  try {
    await Promise.resolve();
    assert.equal(secondFinished, false);
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(closes, 1);
});

test('failed metadata flushing cannot prevent host attachment cleanup', async (t) => {
  let closes = 0;
  const { host, root } = await fixture(t, async () => { closes++; });
  t.mock.method(console, 'error', () => {});
  await host.listSessions();
  await mkdir(join(root, 'desktop-session-metadata.json'));
  await assert.rejects(host.markSessionRead('session-a', 2, false));
  await assert.rejects(host.dispose());
  assert.equal(closes, 1);
});
