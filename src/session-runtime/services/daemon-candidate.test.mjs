import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { forkDaemonCandidate } from './daemon-candidate.mjs';

// No supervisor installed and a download that never finishes: the launcher
// must still start the daemon (directly, over its IPC ready handshake).
test('a launch with no supervisor installed does not wait for its download', async (t) => {
  const root = makeTempDirSync('daemon-candidate');
  const entry = join(root, 'stub-daemon.mjs');
  writeFileSync(entry, "process.send({ type: 'ready' }); setInterval(() => {}, 1000);\n");
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  let downloads = 0;
  let forked = 0;
  const logs = [];
  const outcome = await Promise.race([
    forkDaemonCandidate(
      {
        launcher: 'test',
        entry,
        cwd: root,
        env: { ...process.env },
        execArgv: [],
        spawnOptions: {},
        detached: false,
        dataDir: root,
        log: (line) => logs.push(line),
        timeoutMs: 20_000,
        onForked: (child) => {
          forked += 1;
          children.push(child);
        },
      },
      {
        installed: () => null,
        ensure: () => {
          downloads += 1;
          return new Promise(() => {});
        },
      }
    ).then(() => 'launched'),
    new Promise((resolve) => setTimeout(resolve, 5_000, 'blocked on the download')),
  ]);
  assert.equal(outcome, 'launched');
  assert.equal(forked, 1);
  assert.equal(downloads, 1, 'the download still starts, in the background');
});

test('a failed background download is logged and does not fail the launch', async (t) => {
  const root = makeTempDirSync('daemon-candidate');
  const entry = join(root, 'stub-daemon.mjs');
  writeFileSync(entry, "process.send({ type: 'ready' }); setInterval(() => {}, 1000);\n");
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const logs = [];
  await forkDaemonCandidate(
    {
      launcher: 'test',
      entry,
      cwd: root,
      env: { ...process.env },
      execArgv: [],
      spawnOptions: {},
      detached: false,
      dataDir: root,
      log: (line) => logs.push(line),
      timeoutMs: 20_000,
      onForked: (child) => children.push(child),
    },
    { installed: () => null, ensure: async () => Promise.reject(new Error('offline')) }
  );
  assert.ok(logs.some((line) => line.includes('supervisor download failed: offline')), logs.join('\n'));
});
