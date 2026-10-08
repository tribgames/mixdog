import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readJson } from './catalog-state.mjs';

test('catalog loading rejects duplicate keys before JSON parsing can hide them', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-i18n-keys-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.json');
  for (const text of [
    '{"Remove {{name}}":"first","Remove {{name}}":"last"}',
    '{"Agent":"first","\\u0041gent":"last"}',
    '{"nested":{"Agent":"first","Agent":"last"}}',
  ]) {
    writeFileSync(path, text);
    assert.throws(() => readJson(pathToFileURL(path)), /Duplicate JSON key .*catalog\.json/);
  }
});

test('catalog loading preserves distinct objects, arrays and literal template values', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'mixdog-i18n-keys-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.json');
  const value = { left: { Agent: '{{name}}' }, right: { Agent: 'Agent' }, list: ['Agent', 'Agent'] };
  writeFileSync(path, JSON.stringify(value));
  assert.deepEqual(readJson(pathToFileURL(path)), value);
  writeFileSync(path, '["Agent","Agent"]');
  assert.deepEqual(readJson(pathToFileURL(path)), ['Agent', 'Agent']);
  writeFileSync(path, '{"Agent": }');
  assert.throws(() => readJson(pathToFileURL(path)), SyntaxError);
});
