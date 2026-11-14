import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source-text on purpose: the gate imports electron, which a plain node test cannot load.
test('the gate returns null when packaged and imports the probe dynamically', async () => {
  const source = await readFile(new URL('./jitter-probe-gate.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(app\.isPackaged\) return null;/);
  assert.match(source, /return import\('\.\/jitter-probe'\);/);
  assert.doesNotMatch(source, /^import .*jitter-probe/m);
});

test('electron-builder leaves the jitter-probe chunks out of the package', async () => {
  const yml = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(yml, /^ {2}- '!out\/main\/\*\*\/jitter-probe\*'$/m);
});

test('no main-process file statically imports a jitter-probe module', async () => {
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(new URL('.', import.meta.url))) {
    if (!name.endsWith('.ts') || name.startsWith('jitter-probe')) continue;
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import [^\n]*from '\.\/jitter-probe(?!-gate')/m, name);
  }
});
