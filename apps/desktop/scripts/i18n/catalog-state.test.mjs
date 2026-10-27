import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DEVELOPER_SECTIONS } from '../../../../src/runtime/shared/developer-options.mjs';
import { catalogProblems, untranslatedProblems } from './source-keys.mjs';
import { catalogState, developerOptionUiKeys, neutralAllowlist, readJson } from './catalog-state.mjs';

const [{ label, description, warning }] = DEVELOPER_SECTIONS[0].options;
const REGISTRY_KEYS = [label, description, warning];

test('registry-driven developer option strings are required catalog keys', () => {
  const { keys, catalogs } = catalogState();
  for (const key of REGISTRY_KEYS) {
    assert.ok(developerOptionUiKeys().includes(key), key);
    assert.ok(keys.has(key));
  }
  // Had a locale lacked them, or left them as English, the checker reports both.
  const allowlist = neutralAllowlist();
  for (const [name, catalog] of catalogs) {
    const without = Object.fromEntries(Object.entries(catalog).filter(([key]) => !REGISTRY_KEYS.includes(key)));
    const missing = catalogProblems(without, keys).filter(({ key }) => REGISTRY_KEYS.includes(key));
    assert.deepEqual(missing.map(({ key }) => key).sort(), [...REGISTRY_KEYS].sort(), `${name} missing`);
    const english = { ...catalog, ...Object.fromEntries(REGISTRY_KEYS.map((key) => [key, key])) };
    const untranslated = untranslatedProblems(name, english, keys, allowlist).filter(({ key }) =>
      REGISTRY_KEYS.includes(key)
    );
    assert.equal(untranslated.length, 3, `${name} untranslated`);
    for (const key of REGISTRY_KEYS) assert.notEqual(catalog[key], key, `${name} translates ${key}`);
  }
});

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
