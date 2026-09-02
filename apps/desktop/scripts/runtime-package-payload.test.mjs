import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  fastRuntimeMarker,
  prepareFastRuntimeCode,
} from './prepare-fast-runtime-code.mjs';
import { copyRuntimePackagePayload } from './runtime-package-payload.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-runtime-payload-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'runtime', 'office', 'design', 'library', 'templates'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"mixdog"}');
  await writeFile(join(root, 'src', 'entry.mjs'), 'export const ready = true;');
  await writeFile(
    join(root, 'src', 'runtime', 'office', 'design', 'library', 'templates', 'keep.pptx'),
    'template',
  );
  await writeFile(
    join(root, 'src', 'runtime', 'office', 'design', 'library', 'templates', 'drop.mixdog-edit.pptx'),
    'edit',
  );
  return {
    root,
    manifest: {
      files: [
        { path: 'package.json' },
        { path: 'src/entry.mjs' },
        { path: 'src/runtime/office/design/library/templates/keep.pptx' },
        { path: 'src/runtime/office/design/library/templates/drop.mixdog-edit.pptx' },
      ],
    },
  };
}

test('runtime payload copies published files and drops editor-only Office artifacts', async (context) => {
  const { root, manifest } = await fixture(context);
  const destination = join(root, 'payload');
  await copyRuntimePackagePayload({ rootDir: root, manifest, destination });

  assert.equal(await readFile(join(destination, 'src', 'entry.mjs'), 'utf8'),
    'export const ready = true;');
  await access(join(destination, 'src', 'runtime', 'office', 'design', 'library', 'templates', 'keep.pptx'));
  await assert.rejects(
    access(join(destination, 'src', 'runtime', 'office', 'design', 'library', 'templates', 'drop.mixdog-edit.pptx')),
    { code: 'ENOENT' },
  );
});

test('FastDirect code staging emits an atomic runtime tree with dependency identity', async (context) => {
  const { root, manifest } = await fixture(context);
  const destination = join(root, 'fast-runtime-code');
  await prepareFastRuntimeCode({
    manifest,
    dependencyHash: 'dependencies-v1',
    runtimeHash: 'runtime-v2',
    sourceRoot: root,
    destination,
  });

  const marker = JSON.parse(
    await readFile(join(destination, '.mixdog-fast-runtime.json'), 'utf8'),
  );
  assert.deepEqual(marker, fastRuntimeMarker({
    dependencyHash: 'dependencies-v1',
    runtimeHash: 'runtime-v2',
  }));
  assert.equal(
    await readFile(join(destination, 'node_modules', 'mixdog', 'src', 'entry.mjs'), 'utf8'),
    'export const ready = true;',
  );
});
