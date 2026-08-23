import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import {
  applyRendererDelta,
  buildRendererManifest,
  createRendererDelta,
  validateRendererManifest,
} from './renderer-delta.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-renderer-delta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    ['base', 'current', 'delta', 'output'].map((name) => [name, join(root, name)]),
  );
  await Promise.all([mkdir(paths.base), mkdir(paths.current)]);
  return paths;
}

test('renderer delta copies only changed files and reconstructs the exact tree', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.base, 'same.js'), 'same');
  await writeFile(join(paths.base, 'changed.js'), 'before');
  await writeFile(join(paths.base, 'removed.js'), 'removed');
  await writeFile(join(paths.current, 'same.js'), 'same');
  await writeFile(join(paths.current, 'changed.js'), 'after');
  await mkdir(join(paths.current, 'assets'));
  await writeFile(join(paths.current, 'assets', 'new.css'), 'new');
  const baseManifest = await buildRendererManifest(paths.base);
  const manifestPath = join(paths.current, 'renderer-manifest.json');

  const result = await createRendererDelta({
    root: paths.current,
    baseManifest,
    deltaDir: paths.delta,
    manifestPath,
  });

  assert.equal(result.changedFiles, 2);
  await assert.rejects(readFile(join(paths.delta, 'same.js')), /ENOENT/);
  assert.equal(await readFile(join(paths.delta, 'changed.js'), 'utf8'), 'after');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await applyRendererDelta({
    baseDir: paths.base,
    deltaDir: paths.delta,
    manifest,
    outputDir: paths.output,
  });
  const rebuilt = await buildRendererManifest(paths.output);
  const expected = validateRendererManifest(manifest);
  assert.equal(rebuilt.treeHash, expected.treeHash);
  assert.deepEqual(rebuilt.files, expected.files);
  // The manifest names the base it was computed against; apply refuses any
  // other tree, so a stale cached delta cannot reconstruct an old renderer.
  assert.match(expected.base, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(join(paths.output, 'removed.js')), /ENOENT/);
});

test('renderer reconstruction rejects a mismatched reused base file', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.base, 'same.js'), 'same');
  await writeFile(join(paths.current, 'same.js'), 'same');
  const baseManifest = await buildRendererManifest(paths.base);
  const manifestPath = join(paths.current, 'renderer-manifest.json');
  await createRendererDelta({
    root: paths.current,
    baseManifest,
    deltaDir: paths.delta,
    manifestPath,
  });
  await writeFile(join(paths.base, 'same.js'), 'corrupted');

  await assert.rejects(
    applyRendererDelta({
      baseDir: paths.base,
      deltaDir: paths.delta,
      manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
      outputDir: paths.output,
    }),
    /failed verification/,
  );
});

test('hardlinked reconstruction never mutates the installed base', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.base, 'same.js'), 'same');
  await writeFile(join(paths.base, 'changed.js'), 'before');
  await writeFile(join(paths.current, 'same.js'), 'same');
  await writeFile(join(paths.current, 'changed.js'), 'after');
  const manifestPath = join(paths.current, 'renderer-manifest.json');
  await createRendererDelta({
    root: paths.current,
    baseManifest: await buildRendererManifest(paths.base),
    deltaDir: paths.delta,
    manifestPath,
  });

  await applyRendererDelta({
    baseDir: paths.base,
    deltaDir: paths.delta,
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    outputDir: paths.output,
    hardlinkBase: true,
  });

  assert.equal(await readFile(join(paths.base, 'changed.js'), 'utf8'), 'before');
  assert.equal(await readFile(join(paths.output, 'changed.js'), 'utf8'), 'after');
  assert.equal(await readFile(join(paths.output, 'same.js'), 'utf8'), 'same');
});

test('renderer manifests reject traversal paths', () => {
  assert.throws(() => validateRendererManifest({
    schemaVersion: 1,
    treeHash: '0'.repeat(64),
    files: [{ path: '../escape.js', size: 1, sha256: '0'.repeat(64) }],
  }), /Unsafe renderer manifest path/);
});
