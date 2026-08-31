import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FAST_DIRECT_RUNTIME_MARKER,
  packagedRuntimeSourceRoot,
} from './runtime-layout.ts';

test('packaged runtime uses the FastDirect tree only after its marker and entry point exist', async (context) => {
  const resources = await mkdtemp(join(tmpdir(), 'mixdog-runtime-layout-'));
  context.after(() => rm(resources, { recursive: true, force: true }));
  const archiveSource = join(resources, 'runtime.asar', 'node_modules', 'mixdog', 'src');
  const fastRuntime = join(resources, 'fast-runtime');
  const fastSource = join(fastRuntime, 'node_modules', 'mixdog', 'src');

  assert.equal(packagedRuntimeSourceRoot(resources), archiveSource);

  await mkdir(fastRuntime, { recursive: true });
  await writeFile(join(fastRuntime, FAST_DIRECT_RUNTIME_MARKER), '{}');
  assert.equal(packagedRuntimeSourceRoot(resources), archiveSource);

  await mkdir(join(fastSource, 'standalone'), { recursive: true });
  await writeFile(join(fastSource, 'standalone', 'session-client.mjs'), 'export {};');
  assert.equal(packagedRuntimeSourceRoot(resources), fastSource);
});
