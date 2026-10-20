import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { deleteRecord, getRecord, putRecord, readRegistry, readRegistrySync, registryPath } from './registry.mjs';
import { cleanupTempDirs, useTempDataDir } from './test-support.mjs';

beforeEach(useTempDataDir);
after(cleanupTempDirs);

const asideCopies = () =>
  readdirSync(dirname(registryPath()))
    .filter((name) => name.startsWith('registry.json.corrupt-'))
    .map((name) => join(dirname(registryPath()), name));

for (const [name, damaged] of [
  ['NUL-filled', Buffer.alloc(96)],
  ['empty', Buffer.alloc(0)],
  ['truncated', Buffer.from('{"version":1,"entries":{"a":{"id":"a"')],
  ['wrong-shaped', Buffer.from('{"version":1,"entries":[]}')],
]) {
  test(`a ${name} registry is kept aside and never blocks worktree operations`, async () => {
    await putRecord({ id: 'a', path: '/a' });
    writeFileSync(registryPath(), damaged);
    assert.deepEqual(readRegistrySync(), { version: 1, entries: {} });
    writeFileSync(registryPath(), damaged);
    assert.deepEqual(await readRegistry(), { version: 1, entries: {} });
    writeFileSync(registryPath(), damaged);
    assert.equal(await getRecord('a'), null);
    assert.ok(
      asideCopies().some((copy) => readFileSync(copy).equals(damaged)),
      'the damaged bytes are kept'
    );

    await putRecord({ id: 'b', path: '/b' });
    assert.equal((await getRecord('b')).path, '/b');
    writeFileSync(registryPath(), damaged);
    await putRecord({ id: 'c', path: '/c' });
    await deleteRecord('c');
    assert.deepEqual(Object.keys((await readRegistry()).entries), []);
  });
}

test('a damaged registry is restored from its backup', async () => {
  await putRecord({ id: 'a', path: '/a' });
  await putRecord({ id: 'b', path: '/b' });
  writeFileSync(registryPath(), Buffer.alloc(64));
  assert.equal((await getRecord('a')).path, '/a', 'the last good copy is back');
  assert.equal(await getRecord('b'), null, 'the write after that copy is the only loss');
  await putRecord({ id: 'd', path: '/d' });
  assert.deepEqual(Object.keys((await readRegistry()).entries).sort(), ['a', 'd']);
});
