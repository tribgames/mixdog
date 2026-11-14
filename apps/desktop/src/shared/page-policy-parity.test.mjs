// The Rust page server (native/core/crates/mixdog-workspace/src/pageserver) is the one implementation of the page rules, its asset policy
// included (cases.json pageAsset is replayed by its Rust tests); the storage shim keeps a TypeScript copy only because the renderer builds sandboxed srcdoc pages synchronously. Both are pinned here to the corpus and
// the script text the Rust side tests with.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandboxStorageShimScript, withHeadScript, withSandboxStorageShim } from './sandbox-storage-shim.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const pageserver = resolve(repoRoot, 'native', 'core', 'crates', 'mixdog-workspace', 'src', 'pageserver');
const cases = JSON.parse(readFileSync(resolve(pageserver, 'cases.json'), 'utf8'));
const shimJs = readFileSync(resolve(pageserver, 'shim.js'), 'utf8');

test('shim.js is byte-identical to the TypeScript SHIM_SOURCE', () => {
  assert.equal(shimJs, sandboxStorageShimScript());
});

test('the head script lands where the shared cases say', () => {
  assert.ok(cases.headScript.length > 0);
  for (const { html, out } of cases.headScript) {
    assert.equal(withHeadScript(html, 'S'), out, html);
  }
});

test('withSandboxStorageShim puts the shim.js text where the head script goes', () => {
  for (const { html, out } of cases.headScript) {
    const expected = out.replace('<script>S</script>', () => `<script>${shimJs}</script>`);
    assert.equal(withSandboxStorageShim(html), expected, html);
  }
});
