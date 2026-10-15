import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';
import { writeSessionMetadata } from './session-metadata-file.ts';

const LEGACY = { 'session-a': 'C:\\Work\\Alpha', 'session-b': '' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSessionMetadata(root, {
    titles: {},
    names: {},
    archived: {},
    favorites: {},
    projects: { ...LEGACY },
    reads: {},
  });
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const stored = async () => JSON.parse(await readFile(join(root, 'desktop-session-metadata.json'), 'utf8')).projects;
  return { metadata, stored };
}

test('stored legacy sidebar project assignments stay on disk untouched by other writes', async (t) => {
  const { metadata, stored } = await fixture(t);
  await metadata.setFavorite('session-a', true);
  await metadata.setName('session-b', 'Renamed');
  await metadata.setArchived('session-c', true);
  assert.deepEqual(await stored(), LEGACY);
});

test('deleting a session forgets its legacy project assignment', async (t) => {
  const { metadata, stored } = await fixture(t);
  await metadata.forget('session-a');
  assert.deepEqual(await stored(), { 'session-b': '' });
});
