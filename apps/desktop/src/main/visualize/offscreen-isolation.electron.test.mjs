// Off-screen renders and file snapshots share one session each (Electron never
// frees a session), yet no render finds another's origin-scoped storage,
// whether it runs later or alongside, and repeated renders reuse their
// connections to the page server instead of leaving new ones behind.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import electron from 'electron';
import { build } from 'esbuild';

async function runFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-offscreen-isolation-'));
  try {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL('./test-fixtures/offscreen-isolation.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      supported: { 'dynamic-import': false },
      write: false,
    });
    const main = join(directory, 'index.cjs');
    await writeFile(main, outputFiles[0].contents);
    const env = { ...process.env, OFFSCREEN_ISOLATION_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = await promisify(execFile)(electron, [main], {
      env,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }).catch((error) => error);
    const stdout = String(run.stdout ?? '');
    const evidence = `\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${String(run.stderr ?? '').slice(-8000)}`;
    assert.ok(!(run instanceof Error), `fixture failed: ${String(run.message).split('\n')[0]}${evidence}`);
    const marker = stdout.split('OFFSCREEN_ISOLATION_RESULT ')[1];
    assert.ok(marker, `fixture exited without an OFFSCREEN_ISOLATION_RESULT marker${evidence}`);
    return JSON.parse(marker.split('\n')[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const NOTHING = { local: null, idb: null, cookie: '', caches: '', workers: 0 };
const wrote = (state, tag) => {
  assert.equal(state.local, tag);
  assert.equal(state.idb, tag);
  assert.match(state.cookie, new RegExp(`(?:^|; )k=${tag}(?:;|$)`));
  assert.equal(state.caches, `c-${tag}`);
};

test(
  'off-screen renders and snapshots keep origin-scoped storage to themselves and reuse page-server connections',
  // Like the lane's other suites: the Linux CI lanes have no display server.
  { timeout: 150_000, skip: process.platform !== 'win32' && 'Windows only' },
  async () => {
    const result = await runFixture();
    // The writes took: what follows is isolation, not storage that never worked.
    wrote(result.written, 'A');
    wrote(result.overlapWritten, 'W');
    assert.deepEqual(result.laterOther, NOTHING, 'another artifact rendered later');
    assert.deepEqual(result.laterSame, NOTHING, 'the same artifact rendered again');
    assert.deepEqual(result.overlapping, NOTHING, 'another artifact rendered while the writer is open');

    // Two network-allowed renders visiting one external site: the second
    // carries none of the first's cookies, by request or in script.
    const { external } = result;
    const fromB = external.seen.filter(({ tag }) => tag === 'B');
    assert.equal(fromB.length, 4, JSON.stringify(external.seen));
    for (const { path, cookie } of fromB) assert.doesNotMatch(cookie, /-A=/, `render B's ${path} carried ${cookie}`);
    assert.doesNotMatch(String(external.visitB.frameCookies), /-A=/, 'render B read render A cookies in script');

    // Another open render's origin is no address for a worker: not for a
    // dedicated one (judged as its page) nor a shared one (no window at all).
    const { workers } = result;
    assert.equal(workers.own, 200, 'a dedicated worker fetches from its own page');
    assert.match(String(workers.dedicated), /^refused/, `dedicated worker got ${workers.dedicated}`);
    assert.match(String(workers.shared), /^refused/, `shared worker got ${workers.shared}`);
    assert.match(workers.serviceWorker, /^rejected/, 'no service worker registers');

    // A page load opens up to 6 connections; one that stays per render was
    // the leak (each one's socket outlived it in the network service).
    assert.ok(
      result.thumbnailConnections <= 6,
      `${result.renders} renders opened ${result.thumbnailConnections} page-server connections`
    );

    assert.ok(result.snapshotState, 'the second snapshot reported what it found');
    wrote(result.snapshotState.after, 'artifact-b');
    assert.deepEqual(result.snapshotState.before, NOTHING, 'a snapshot of another project after one that wrote');
    assert.equal(result.snapshotPicture, 'data:image/png;base64,');
  }
);
