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

test('a write from one service never persists its stale cache over another service sharing the directory', async (t) => {
  const { metadata, reload } = await fixture(t);
  const other = await reload(); // second desktop service, same metadata directory
  await other.setName('session-b', 'Saved by the other service');
  await other.setFavorite('session-c', true);

  assert.equal(await metadata.setFavorite('session-a', true), true);
  const reloaded = await reload();
  assert.equal(reloaded.names['session-b'], 'Saved by the other service');
  assert.deepEqual(reloaded.withFavoriteFlags([{ id: 'session-a' }, { id: 'session-c' }]), [
    { id: 'session-a', favorite: true },
    { id: 'session-c', favorite: true },
  ]);

  // An entry this service removes is removed on disk, while the other's stays.
  await metadata.setFavorite('session-a', false);
  assert.deepEqual((await reload()).withFavoriteFlags([{ id: 'session-a' }, { id: 'session-c' }]), [
    { id: 'session-a' },
    { id: 'session-c', favorite: true },
  ]);
});

test("a home thread's retirement record persists independent of its archive flag", async (t) => {
  const { metadata, reload, target } = await fixture(t);
  assert.equal(await metadata.setRetired('sess_home_gone', true), true);
  assert.equal(await metadata.setRetired('sess_home_gone', true), false, 'unchanged request reports no change');
  // A hand restore (unarchive) keeps the record.
  await metadata.setArchived('sess_home_gone', true);
  await metadata.setArchived('sess_home_gone', false);
  assert.equal(await (await reload()).isRetired('sess_home_gone'), true);
  // The catalog marks the retired home: its chat is read-only.
  assert.deepEqual((await reload()).withRetiredFlags([{ id: 'sess_home_gone' }, { id: 'sess_home_live' }]), [
    { id: 'sess_home_gone', agentDeleted: true },
    { id: 'sess_home_live' },
  ]);
  assert.equal(await metadata.setRetired('sess_home_gone', false), true);
  assert.equal(await (await reload()).isRetired('sess_home_gone'), false);
  assert.deepEqual(metadata.withRetiredFlags([{ id: 'sess_home_gone' }]), [{ id: 'sess_home_gone' }]);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).retired, undefined, 'empty map is omitted from the file');
});

test("a deleted bot's archived home keeps the bot's name across a restart; each deletion names it anew", async (t) => {
  const { metadata, reload } = await fixture(t);
  const id = 'sess_home_probe';
  assert.equal(metadata.rememberRetiredTitle(id, 'Probe'), true);
  await metadata.setArchived(id, true);
  await metadata.setRetired(id, true);
  await metadata.flush();
  const restarted = await reload();
  assert.equal(restarted.titles[id], 'Probe');
  // Listed under the bot's name, over the title its conversation got.
  assert.deepEqual(restarted.withRetiredFlags(restarted.withArchiveFlags([{ id, title: 'First question' }])), [
    { id, title: 'Probe', archived: true, agentDeleted: true },
  ]);
  // Restored, renamed, deleted again: the archive shows the newer name.
  assert.equal(restarted.rememberRetiredTitle(id, 'Probe Renamed'), true);
  assert.equal(restarted.rememberGeneratedTitle(id, 'A generated title'), false, 'a generated title never replaces it');
  // A user's own name for the chat still wins.
  await restarted.setName(id, 'Mine');
  assert.equal(restarted.rememberRetiredTitle(id, 'Other'), false);
  assert.deepEqual(restarted.withRetiredFlags([{ id, title: 'Mine' }]), [{ id, title: 'Mine', agentDeleted: true }]);
  await restarted.flush();
  assert.equal((await reload()).titles[id], 'Probe Renamed');
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
