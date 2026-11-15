import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { devJsRuntimeManifest, OFFICE_TEMPLATE_FILES, OFFICE_TEMPLATES_DIR, OFFICE_TEMPLATES_SOURCE } from './core-layout.mjs';
import { modulesTree, put } from './core-layout-fixture.mjs';
import { writeDevInstall } from './dev-core-install.mjs';

function devTree() {
  const top = makeTempDirSync('dev-core-install');
  modulesTree(join(top, 'modules'), 'linux', 'x64');
  put(join(top, 'target/debug/mixdogd'));
  put(join(top, 'node'));
  return {
    top,
    options: {
      exe: join(top, 'target/debug/mixdogd'),
      ortLibrary: join(top, 'modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1'),
      packageRoot: join(top, 'modules/mixdog'),
      program: join(top, 'node'),
    },
  };
}

test('the dev install writes the layout core-layout.mjs describes, for a package root holding what the core reads', async () => {
  const { top, options } = devTree();
  const { file, manifest } = await writeDevInstall(options);
  assert.equal(file, join(top, 'target/debug/js-runtime.json'));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), manifest);
  assert.deepEqual(manifest, devJsRuntimeManifest({ program: options.program, packageRoot: options.packageRoot, ortLibrary: options.ortLibrary }));
});

test('the dev install puts the Office templates beside the binary', async () => {
  const { top, options } = devTree();
  await writeDevInstall(options);
  for (const file of OFFICE_TEMPLATE_FILES) {
    assert.deepEqual(readFileSync(join(top, 'target/debug', OFFICE_TEMPLATES_DIR, file)), readFileSync(join(OFFICE_TEMPLATES_SOURCE, file)));
  }
});

test('a package root without a directory the core reads is refused', async () => {
  const { options } = devTree();
  rmSync(join(options.packageRoot, 'src/workflows'), { recursive: true });
  await assert.rejects(writeDevInstall(options), /--package-root: .*workflows does not exist/);
});
