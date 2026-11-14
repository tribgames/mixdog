import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { DIRECT_KEYS, HOST_KEYS, OPTIONAL_UNPROVIDED } from './desktop-api-split.ts';
import { HOST_EXTRA_IPC } from './contract-ipc-host.ts';

const contractPath = new URL('./contract.ts', import.meta.url);
const sourceFile = ts.createSourceFile('contract.ts', fs.readFileSync(contractPath, 'utf8'), ts.ScriptTarget.ES2022, true);

function desktopApiMembers() {
  for (const node of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'DesktopApi') {
      return node.members.map((member) => member.name.text);
    }
  }
  throw new Error('DesktopApi not found in contract.ts');
}

const groups = [
  ...Object.entries(DIRECT_KEYS).map(([name, keys]) => [`direct.${name}`, keys]),
  ...Object.entries(HOST_KEYS).map(([name, keys]) => [`host.${name}`, keys]),
  ['optionalUnprovided', OPTIONAL_UNPROVIDED],
];

test('the groups together equal the members of DesktopApi', () => {
  const classified = groups.flatMap(([, keys]) => keys);
  assert.deepEqual([...new Set(classified)].sort(), [...new Set(desktopApiMembers())].sort());
});

test('no key is in two groups', () => {
  const seen = new Map();
  for (const [name, keys] of groups) {
    for (const key of keys) {
      assert.equal(seen.get(key), undefined, `${key} is in ${seen.get(key)} and ${name}`);
      seen.set(key, name);
    }
  }
});

test('the direct half has the seven groups and sections holds only the key sections', () => {
  assert.deepEqual(Object.keys(DIRECT_KEYS), ['sessions', 'files', 'scm', 'terminal', 'settings', 'capabilities', 'sections']);
  assert.deepEqual([...DIRECT_KEYS.sections], ['sections']);
  assert.equal(Object.values(DIRECT_KEYS).flat().length, 190);
});

test('the preload provides every member outside OPTIONAL_UNPROVIDED', () => {
  const preload = ['index.ts', 'browser-texture.ts']
    .map((name) => fs.readFileSync(new URL(`../preload/${name}`, import.meta.url), 'utf8'))
    .join(' ');
  const unprovided = new Set(OPTIONAL_UNPROVIDED);
  for (const key of desktopApiMembers()) {
    if (unprovided.has(key)) continue;
    const mentioned = new RegExp("(^|[^A-Za-z0-9_])" + key + "([^A-Za-z0-9_]|$)").test(preload);
    assert.ok(mentioned, `${key} is classified as provided but the preload never mentions it`);
  }
});

test('host extra channels are unique', () => {
  const values = Object.values(HOST_EXTRA_IPC);
  assert.equal(new Set(values).size, values.length);
});
