import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beginProjectRecovery, recoveryIdentity, releaseRecoveryDirectory } from './project-recovery-store.ts';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..');

test('plain-Node daemon loads the unpacked desktop adapter and serves pane catalogs', async () => {
  const runtimeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-desktop-service-e2e-')));
  const environment = {
    ...process.env,
    MIXDOG_RUNTIME_ROOT: runtimeRoot,
    MIXDOG_DATA_DIR: runtimeRoot,
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    MIXDOG_DAEMON_HOST: '1',
  };
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  process.env.MIXDOG_DATA_DIR = runtimeRoot;
  const child = fork(join(REPOSITORY_ROOT, 'src', 'standalone', 'daemon.mjs'), [], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('service daemon ready timeout')), 30_000);
      child.once('exit', (code) => reject(new Error(`service daemon exited with ${code}`)));
      child.on('message', (message) => {
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        resolveReady();
      });
    });
    const clientModule = await import(
      `${pathToFileURL(join(REPOSITORY_ROOT, 'src', 'standalone', 'session-client.mjs')).href}` +
        `?desktop-service-e2e=${Date.now()}`
    );
    const discovery = clientModule.readSessionDiscovery();
    assert.ok(discovery?.port);
    const client = await clientModule.attachSession({ discovery, cwd: runtimeRoot });
    try {
      const initialized = await client.call('desktop.init', {
        desktopId: 'desktop_packaged_e2e',
        moduleUrl: pathToFileURL(join(DESKTOP_DIR, 'out', 'main', 'daemon.cjs')).href,
        options: {
          userDataPath: runtimeRoot,
          packaged: true,
          resourcesPath: DESKTOP_DIR,
          appPath: join(DESKTOP_DIR, 'app.asar'),
          rendererDir: join(DESKTOP_DIR, 'out', 'renderer'),
          runtimeRoot,
        },
      });
      const [projects, sessions] = await Promise.all([
        client.call('desktop.invoke', {
          desktopId: initialized.desktopId,
          method: 'listProjects',
          args: [],
        }),
        client.call('desktop.invoke', {
          desktopId: initialized.desktopId,
          method: 'listSessions',
          args: [],
        }),
      ]);
      assert.ok(Array.isArray(projects));
      assert.ok(Array.isArray(sessions));
      // Exercise the packaged recovery operation against a persisted partial
      // batch created in a different process (this test runner).
      const project = join(runtimeRoot, 'recovery-project');
      mkdirSync(project);
      const destination = join(project, 'a.txt');
      writeFileSync(destination, 'before');
      const journal = await beginProjectRecovery(runtimeRoot, project, [{
        relPath: 'a.txt', destination, parent: recoveryIdentity(project), mode: 0o600,
        before: Buffer.from('before'), after: Buffer.from('after'),
      }]);
      await releaseRecoveryDirectory(journal.directory);
      writeFileSync(destination, 'after');
      const recover = (request) => client.call('desktop.invoke', {
        desktopId: initialized.desktopId, method: 'invokeDesktopOperation',
        args: ['projectRecoveryIn', [project, request]],
      });
      const listed = await recover({ action: 'list' });
      assert.equal(listed.records.length, 1);
      const inspected = await recover({ action: 'inspect', id: journal.id });
      assert.equal(inspected.detail.files[0].status, 'written');
      await recover({ action: 'restore', id: journal.id, revision: inspected.detail.revision });
      assert.equal(readFileSync(destination, 'utf8'), 'before');
      const restored = await recover({ action: 'inspect', id: journal.id });
      await recover({ action: 'discard', id: journal.id, revision: restored.detail.revision });
      assert.deepEqual((await recover({ action: 'list' })).records, []);
      const submitted = await client.call('desktop.invoke', {
        desktopId: initialized.desktopId,
        method: 'submitNewTask',
        args: ['Atomic daemon prompt', { id: 'desktop-service-e2e-submit', submittedAt: Date.now() }, {}],
      });
      assert.equal(submitted.accepted, true);
      assert.match(submitted.sessionId, /^[A-Za-z0-9_-]+$/);
      assert.equal(submitted.snapshot?.sessionId, submitted.sessionId);
      assert.ok(
        submitted.snapshot?.items?.some(
          (item) =>
            item?.id === 'desktop-service-e2e-submit' && item?.kind === 'user' && item?.text === 'Atomic daemon prompt'
        ),
        'the atomic ACK must contain its own durable first user row'
      );
      await client.call('desktop.unsubscribe', { desktopId: initialized.desktopId });
    } finally {
      await client.close('desktop service e2e');
    }
  } finally {
    if (!child.killed) child.kill();
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) {
        resolveExit();
        return;
      }
      child.once('exit', resolveExit);
      setTimeout(resolveExit, 5_000).unref?.();
    });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
