import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { activateRemote, isRemoteActivated } from './remote-activation';

const fresh = () => mkdtemp(join(tmpdir(), 'mixdog-activation-'));

test('fresh install is not activated and nothing is created', async () => {
  const dir = await fresh();
  assert.equal(await isRemoteActivated(dir), false);
  await assert.rejects(access(join(dir, 'relay-device.json')));
});

test('activation persists across restart', async () => {
  const dir = await fresh();
  await activateRemote(dir);
  assert.equal(await isRemoteActivated(dir), true);
  assert.equal(await isRemoteActivated(dir), true);
});

for (const name of ['relay-device.json', 'remote-client-trust.json']) {
  test(`existing ${name} counts as activated`, async () => {
    const dir = await fresh();
    await writeFile(join(dir, name), '{}');
    assert.equal(await isRemoteActivated(dir), true);
    await access(join(dir, 'remote-activated.json'));
  });
}
