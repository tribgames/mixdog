import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';
import { writeSessionMetadata } from './session-metadata-file.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  return { root, metadata, target: join(root, 'desktop-session-metadata.json') };
}

test('failed metadata writes reject and keep the latest maps available for an explicit flush', async (t) => {
  const { root, metadata, target } = await fixture(t);
  await mkdir(target);
  await assert.rejects(metadata.setName('session-a', 'Saved name'));
  await assert.rejects(metadata.flush());
  await rmdir(target);
  await metadata.flush();
  const reloaded = new DesktopSessionMetadata(() => root);
  await reloaded.load();
  assert.equal(reloaded.names['session-a'], 'Saved name');
});

for (const kind of ['archive', 'read']) {
  test(`an unchanged ${kind} request retries its previously failed save`, async (t) => {
    const { root, metadata, target } = await fixture(t);
    const update = () =>
      kind === 'archive' ? metadata.setArchived('session-a', true) : metadata.markRead('session-a', 3, false);
    await mkdir(target);
    await assert.rejects(update());
    await rmdir(target);
    assert.equal(await update(), false, 'the in-memory value was already changed');
    const reloaded = new DesktopSessionMetadata(() => root);
    await reloaded.load();
    if (kind === 'archive') assert.ok(reloaded.archived['session-a'] > 0);
    else assert.equal(reloaded.reads['session-a'].messageCount, 3);
  });
}

test('concurrent metadata publications retain one complete JSON snapshot', async (t) => {
  const { root, target } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const maps = ['first', 'second', 'third'].map((value) => ({
    titles: { session: value },
    names: { session: value },
    archived: {},
    reads: {},
  }));
  await Promise.all(maps.map((value) => writeSessionMetadata(root, value)));
  const saved = JSON.parse(await readFile(target, 'utf8'));
  assert.ok(
    maps.some((value) => saved.titles.session === value.titles.session && saved.names.session === value.names.session)
  );
});

for (const mutation of ['name', 'archive', 'forget']) {
  test(`a first ${mutation} mutation loads existing metadata before changing it`, async (t) => {
    const { root } = await fixture(t);
    await writeSessionMetadata(root, {
      titles: { keeper: 'Preserved title' },
      names: { keeper: 'Preserved name', removed: 'Old name' },
      archived: { keeper: 100 },
      reads: { keeper: { messageCount: 5, revision: 2 } },
    });
    const metadata = new DesktopSessionMetadata(() => root);
    if (mutation === 'name') await metadata.setName('changed', 'New name');
    else if (mutation === 'archive') await metadata.setArchived('changed', true);
    else await metadata.forget('removed');
    const reloaded = new DesktopSessionMetadata(() => root);
    await reloaded.load();
    assert.equal(reloaded.titles.keeper, 'Preserved title');
    assert.equal(reloaded.names.keeper, 'Preserved name');
    assert.equal(reloaded.archived.keeper, 100);
    assert.deepEqual(reloaded.reads.keeper, { messageCount: 5, revision: 2 });
    if (mutation === 'name') assert.equal(reloaded.names.changed, 'New name');
    else if (mutation === 'archive') assert.ok(reloaded.archived.changed > 0);
    else assert.equal(reloaded.names.removed, undefined);
  });
}
