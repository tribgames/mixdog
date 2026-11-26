import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createFileSnapshotService, snapshotKind, snapshotRequestAllowed } from './file-snapshot.ts';
import { projectEntryPathIn } from './project-files.ts';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

const project = () => {
  const root = makeTempDirSync('snap');
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(root, 'notes.txt'), 'x');
  return root;
};
const service = (render, timeoutMs) => createFileSnapshotService({ confine: projectEntryPathIn, render, timeoutMs });

test('paths outside the project and other file types are refused before anything renders', async () => {
  const root = project();
  const outside = makeTempDirSync('snap-out');
  writeFileSync(join(outside, 'secret.html'), 'x');
  let rendered = 0;
  const snapshots = service(async () => {
    rendered++;
    return 'data:image/png;base64,AAAA';
  });
  await assert.rejects(
    snapshots.capture(root, `../${outside.split(/[\\/]/).pop()}/secret.html`),
    /outside the project/
  );
  await assert.rejects(snapshots.capture(root, join(outside, 'secret.html')), /outside the project/);
  await assert.rejects(snapshots.capture(root, 'notes.txt'), /no snapshot/);
  await assert.rejects(snapshots.capture(root, 'design/missing.html'));
  assert.equal(rendered, 0);
  assert.equal((await snapshots.capture(root, 'design/index.html')).dataUrl, 'data:image/png;base64,AAAA');
});

test('a granted file may load only itself; a project capture keeps the project root', async () => {
  const root = project();
  const url = (path) => new URL(`file:///${path.replace(/\\/g, '/')}`).href;
  const page = join(root, 'design', 'index.html');
  const sibling = join(root, 'design', 'sibling.png');
  writeFileSync(sibling, 'x');
  // Grant: root is the file's parent folder.
  const folder = join(root, 'design');
  assert.equal(snapshotRequestAllowed(folder, url(page), page), true);
  assert.equal(snapshotRequestAllowed(folder, url(sibling), page), false);
  assert.equal(snapshotRequestAllowed(folder, 'data:image/png;base64,AA', page), true);
  assert.equal(snapshotRequestAllowed(folder, 'https://example.com/a.png', page), false);
  // Project: any file inside the root, none outside.
  assert.equal(snapshotRequestAllowed(root, url(sibling)), true);
  assert.equal(snapshotRequestAllowed(root, url(join(root, '..', 'x.png'))), false);
  // The service passes onlyFile to the renderer for grants only.
  const seen = [];
  const snapshots = service(async (input) => {
    seen.push(input.onlyFile);
    return 'data:image/png;base64,AAAA';
  });
  await snapshots.capture(folder, 'index.html', true);
  await snapshots.capture(root, 'design/index.html');
  assert.deepEqual(seen, [page, undefined]);
});

test('a symlink out of the project is refused', async (t) => {
  const root = project();
  const outside = makeTempDirSync('snap-out');
  writeFileSync(join(outside, 'secret.html'), 'x');
  try {
    symlinkSync(outside, join(root, 'link'), 'junction');
  } catch {
    t.skip('symlinks unavailable');
    return;
  }
  await assert.rejects(service(async () => 'x').capture(root, 'link/secret.html'), /outside the project/);
});

test('a render that never settles times out and the next capture still runs', async () => {
  const root = project();
  let aborted = false;
  let calls = 0;
  const snapshots = service(({ signal }) => {
    calls += 1;
    if (calls > 1) return Promise.resolve('data:image/png;base64,OK');
    signal.addEventListener('abort', () => (aborted = true));
    return new Promise(() => {});
  }, 30);
  await assert.rejects(snapshots.capture(root, 'design/index.html'), /too long/);
  assert.equal(aborted, true);
  assert.equal((await snapshots.capture(root, 'design/index.html')).dataUrl, 'data:image/png;base64,OK');
});

test('captures run one at a time and a file version renders once', async () => {
  const root = project();
  writeFileSync(join(root, 'b.html'), '<p>b</p>');
  let active = 0;
  let peak = 0;
  let renders = 0;
  const snapshots = service(async () => {
    renders += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return `data:image/png;base64,R${renders}`;
  });
  const [a1, a2, b] = await Promise.all([
    snapshots.capture(root, 'design/index.html'),
    snapshots.capture(root, 'design/index.html'),
    snapshots.capture(root, 'b.html'),
  ]);
  assert.equal(peak, 1);
  assert.equal(renders, 2);
  assert.equal(a1, a2);
  assert.notEqual(a1.dataUrl, b.dataUrl);
  await snapshots.capture(root, 'design/index.html');
  assert.equal(renders, 2, 'cached');
  writeFileSync(join(root, 'design', 'index.html'), '<h1>changed, longer</h1>');
  await snapshots.capture(root, 'design/index.html');
  assert.equal(renders, 3, 'a changed file renders again');
});

test('the capture window may only load file: resources of the project', () => {
  const root = project();
  const url = (path) => new URL(`file:///${path.replace(/\\/g, '/')}`).href;
  assert.equal(snapshotRequestAllowed(root, url(join(root, 'design', 'index.html'))), true);
  assert.equal(snapshotRequestAllowed(root, url(join(root, '..', 'elsewhere.png'))), false);
  assert.equal(snapshotRequestAllowed(root, 'https://example.com/a.js'), false);
  assert.equal(snapshotRequestAllowed(root, 'http://127.0.0.1:3000/'), false);
  assert.equal(snapshotRequestAllowed(root, 'ws://localhost/x'), false);
  assert.equal(snapshotRequestAllowed(root, 'data:image/png;base64,AA'), true);
  assert.equal(snapshotRequestAllowed(root, 'not a url'), false);
  assert.equal(snapshotKind('a/B.HTML'), 'html');
  assert.equal(snapshotKind('a.PNG'), 'image');
  assert.equal(snapshotKind('a.js'), null);
});

test('clear releases cached snapshot data URLs so idle reclaim drops them from the heap', async () => {
  const root = project();
  let renders = 0;
  const snapshots = service(async () => {
    renders += 1;
    return `data:image/png;base64,R${renders}`;
  });
  const first = await snapshots.capture(root, 'design/index.html');
  assert.equal(renders, 1);
  assert.equal(await snapshots.capture(root, 'design/index.html'), first);
  assert.equal(renders, 1, 'served from cache before reclaim');

  snapshots.clear();
  const after = await snapshots.capture(root, 'design/index.html');
  assert.equal(renders, 2, 're-rendered after clear released the cached data URL');
  assert.notEqual(after.dataUrl, first.dataUrl);
});

test('clear detaches tail retention and prevents pre-clear queued captures from refilling the cache', async () => {
  const root = project();
  writeFileSync(join(root, 'b.html'), '<p>b</p>');
  let renders = 0;
  let active = 0;
  let peak = 0;
  let firstStarted;
  const firstWaiting = new Promise((resolve) => (firstStarted = resolve));
  let releaseFirst;

  const snapshots = service(async () => {
    renders += 1;
    active += 1;
    peak = Math.max(peak, active);
    const id = renders;
    if (id === 1) {
      firstStarted();
      await new Promise((resolve) => (releaseFirst = resolve));
    }
    active -= 1;
    return `data:image/png;base64,R${id}`;
  });

  // Start first capture and queue a second capture behind it, then call clear() before either completes.
  const firstPending = snapshots.capture(root, 'design/index.html');
  const secondPending = snapshots.capture(root, 'b.html');
  await firstWaiting;
  snapshots.clear();
  releaseFirst();

  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(peak, 1, 'captures stay serialized across clear');
  assert.equal(first.dataUrl, 'data:image/png;base64,R1');
  assert.equal(second.dataUrl, 'data:image/png;base64,R2');

  // Neither pre-clear capture may have refilled the cleared cache.
  const afterFirst = await snapshots.capture(root, 'design/index.html');
  const afterSecond = await snapshots.capture(root, 'b.html');
  assert.equal(renders, 4, 'both files re-render because pre-clear completions did not refill cache');
  assert.equal(afterFirst.dataUrl, 'data:image/png;base64,R3');
  assert.equal(afterSecond.dataUrl, 'data:image/png;base64,R4');
});
