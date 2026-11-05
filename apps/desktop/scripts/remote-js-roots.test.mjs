import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { deriveRemoteRoots, fitsTarget, trimManifest } from './remote-js-roots.mjs';

const write = (root, file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

test('roots are the packages the entry points reach: static, dynamic, createRequire and worker files', () => {
  const root = makeTempDirSync('roots');
  write(root, 'src/ext-host/worker.mjs', `import { a } from 'alpha';\nimport fs from 'node:fs';\nimport './methods.mjs';\n`);
  write(root, 'src/ext-host/methods.mjs', `export const load = () => import('@scope/beta/sub.js');\nconst w = new URL('../runtime/office/w.mjs', import.meta.url);\nimport { h } from '../runtime/shared/helper.mjs';\n`);
  write(root, 'src/runtime/office/w.mjs', `const r = createRequire(import.meta.url);\nr; const t = require('gamma');\n`);
  // A helper outside the extension host's directories: its packages count, its own imports are not followed.
  write(root, 'src/runtime/shared/helper.mjs', `import 'delta';\nimport './barrel.mjs';\n`);
  write(root, 'src/runtime/shared/barrel.mjs', `import 'never-reached';\n`);
  write(root, 'src/ext-host/unused.mjs', `import 'orphan';\n`);
  write(root, 'src/ext-host/x.e2e.test.mjs', `import 'test-only';\n`);
  write(root, 'src/skill-script-entry.mjs', `await import('./runtime/shared/skill.mjs');\n`);
  write(root, 'src/runtime/shared/skill.mjs', `import 'epsilon';\n`);
  const { roots } = deriveRemoteRoots({ packageRootDir: root });
  assert.deepEqual([...roots.keys()].sort(), ['@scope/beta', 'alpha', 'delta', 'epsilon', 'gamma']);
});

test('the real package: the 13 roots, nothing that only the agent runtime or the desktop loads', () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const names = [...deriveRemoteRoots({ packageRootDir: repo }).roots.keys()].sort();
  for (const needed of ['pdfjs-dist', 'pdf-lib', 'sharp', 'tesseract.js', 'puppeteer-core', '@napi-rs/canvas', 'jsdom', 'pptxgenjs']) {
    assert.ok(names.includes(needed), needed);
  }
  for (const absent of ['onnxruntime-node', '@huggingface/transformers', 'openai', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'electron']) {
    assert.equal(names.includes(absent), false, absent);
  }
});

const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'x', dependencies: { a: '^1', unused: '^1' }, devDependencies: { dev: '1' } },
    'node_modules/a': { version: '1.0.0', dependencies: { b: '^1' }, optionalDependencies: { 'a-linux-x64': '1', 'a-linuxmusl-x64': '1', 'a-darwin-arm64': '1', 'a-wasm32': '1' } },
    'node_modules/b': { version: '1.0.0', dependencies: { c: '^2' } },
    'node_modules/b/node_modules/c': { version: '2.0.0' },
    'node_modules/c': { version: '1.0.0' },
    'node_modules/a-linux-x64': { os: ['linux'], cpu: ['x64'] },
    'node_modules/a-linuxmusl-x64': { os: ['linux'], cpu: ['x64'] },
    'node_modules/a-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
    'node_modules/a-wasm32': {},
    'node_modules/unused': { version: '1.0.0' },
  },
};
const manifest = { dependencies: { a: '^1', unused: '^1' }, overrides: { a: '^1', unused: '^1' }, scripts: { x: 'y' } };

test('the trim keeps the roots and what they reach, resolving nested copies, for one platform', () => {
  const linux = trimManifest({ manifest, lock, roots: ['a'], target: { os: 'linux', cpu: 'x64', libc: 'glibc' } });
  assert.deepEqual(Object.keys(linux.lock.packages).sort(), ['', 'node_modules/a', 'node_modules/a-linux-x64', 'node_modules/b', 'node_modules/b/node_modules/c']);
  assert.deepEqual(linux.manifest.dependencies, { a: '^1' });
  assert.deepEqual(linux.lock.packages[''].dependencies, { a: '^1' });
  assert.deepEqual(linux.manifest.overrides, { a: '^1' });
  assert.equal(linux.manifest.scripts, undefined);
  const mac = trimManifest({ manifest, lock, roots: ['a'], target: { os: 'darwin', cpu: 'arm64' } });
  assert.ok(mac.lock.packages['node_modules/a-darwin-arm64']);
  assert.equal(mac.lock.packages['node_modules/a-linux-x64'], undefined);
});

test('a reached package that is not a dependency, or not locked, stops the stage', () => {
  assert.throws(() => trimManifest({ manifest, lock, roots: ['ghost'] }), /ghost is reached .* not a dependency/);
  assert.throws(() => trimManifest({ manifest: { dependencies: { ghost: '1' } }, lock, roots: ['ghost'] }), /ghost is reached .* not in package-lock/);
});

test('musl and wasm builds fit no glibc or macOS target; os, cpu and libc fields are honoured', () => {
  assert.equal(fitsTarget('@img/sharp-linuxmusl-x64', { os: ['linux'], cpu: ['x64'] }, { os: 'linux', cpu: 'x64', libc: 'glibc' }), false);
  assert.equal(fitsTarget('@img/sharp-wasm32', {}, { os: 'linux', cpu: 'x64', libc: 'glibc' }), false);
  assert.equal(fitsTarget('@img/sharp-linux-x64', { os: ['linux'], cpu: ['x64'] }, { os: 'linux', cpu: 'x64', libc: 'glibc' }), true);
  assert.equal(fitsTarget('p', { os: ['linux'], cpu: ['x64'], libc: ['musl'] }, { os: 'linux', cpu: 'x64', libc: 'glibc' }), false);
  assert.equal(fitsTarget('p', { os: ['!win32'] }, { os: 'darwin', cpu: 'arm64' }), true);
  assert.equal(fitsTarget('p', { os: ['!win32'] }, { os: 'win32', cpu: 'x64' }), false);
});
