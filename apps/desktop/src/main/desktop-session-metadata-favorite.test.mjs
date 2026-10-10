import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-favorite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const reload = async () => {
    const next = new DesktopSessionMetadata(() => root);
    await next.load();
    return next;
  };
  return { metadata, reload, target: join(root, 'desktop-session-metadata.json') };
}

test('a favorite flag persists across a reload and is cleared when removed', async (t) => {
  const { metadata, reload, target } = await fixture(t);
  assert.equal(await metadata.setFavorite('session-a', true), true);
  assert.equal(await metadata.setFavorite('session-a', true), false, 'unchanged request reports no change');
  let reloaded = await reload();
  assert.deepEqual(reloaded.withFavoriteFlags([{ id: 'session-a' }, { id: 'session-b' }]), [
    { id: 'session-a', favorite: true },
    { id: 'session-b' },
  ]);

  assert.equal(await metadata.setFavorite('session-a', false), true);
  reloaded = await reload();
  assert.deepEqual(reloaded.withFavoriteFlags([{ id: 'session-a' }]), [{ id: 'session-a' }]);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).favorites, undefined, 'empty map is omitted from the file');
});

test('archiving keeps the favorite flag and deleting a session forgets it', async (t) => {
  const { metadata, reload } = await fixture(t);
  await metadata.setFavorite('session-a', true);
  await metadata.setArchived('session-a', true);
  await metadata.setArchived('session-a', false);
  const [row] = (await reload()).withFavoriteFlags([{ id: 'session-a' }]);
  assert.equal(row.favorite, true);

  await metadata.forget('session-a');
  assert.deepEqual((await reload()).withFavoriteFlags([{ id: 'session-a' }]), [{ id: 'session-a' }]);
});
