import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { catalogProblems, untranslatedProblems } from './source-keys.mjs';
import { catalogState, developerOptionUiKeys, neutralAllowlist, readJson } from './catalog-state.mjs';

const DIRECT_PHONE_KEYS = [
  'Direct phone connection (test)',
  'Lets a paired phone talk to this PC directly instead of through the relay. Takes effect after you restart Mixdog.',
  'Experimental: the direct phone connection is still being tested and may make the phone connection less reliable. Restart Mixdog after changing it.',
];

test('registry-driven developer option strings are required catalog keys', () => {
  const { keys, sources, catalogs } = catalogState();
  for (const key of DIRECT_PHONE_KEYS) {
    assert.ok(developerOptionUiKeys().includes(key), key);
    assert.equal(sources.get(key), 'src/runtime/shared/developer-options.mjs');
    assert.ok(keys.has(key));
  }
  // Had a locale lacked them, or left them as English, the checker reports both.
  const allowlist = neutralAllowlist();
  for (const [name, catalog] of catalogs) {
    const without = Object.fromEntries(Object.entries(catalog).filter(([key]) => !DIRECT_PHONE_KEYS.includes(key)));
    const missing = catalogProblems(without, keys).filter(({ key }) => DIRECT_PHONE_KEYS.includes(key));
    assert.deepEqual(missing.map(({ key }) => key).sort(), [...DIRECT_PHONE_KEYS].sort(), `${name} missing`);
    const english = { ...catalog, ...Object.fromEntries(DIRECT_PHONE_KEYS.map((key) => [key, key])) };
    const untranslated = untranslatedProblems(name, english, keys, allowlist).filter(({ key }) =>
      DIRECT_PHONE_KEYS.includes(key)
    );
    assert.equal(untranslated.length, 3, `${name} untranslated`);
    for (const key of DIRECT_PHONE_KEYS) assert.notEqual(catalog[key], key, `${name} translates ${key}`);
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
