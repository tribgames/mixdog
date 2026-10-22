import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const reload = async () => {
    const next = new DesktopSessionMetadata(() => root);
    await next.load();
    return next;
  };
  return { metadata, reload };
}

const flagged = (metadata, ids) =>
  metadata
    .withArchiveFlags(ids.map((id) => ({ id })))
    .filter((row) => row.archived)
    .map((row) => row.id);

test('an archive takes the sub-agent sessions along; a restore brings back only the ones it took', async (t) => {
  const { metadata, reload } = await fixture(t);
  const ids = ['lead', 'sub-a', 'sub-b', 'sub-own'];
  // Archived on its own earlier (e.g. by the idle sweep): stays archived.
  assert.equal(await metadata.setArchived('sub-own', true), true);
  assert.equal(await metadata.setArchived('lead', true, ['sub-a', 'sub-b', 'sub-own']), true);
  assert.deepEqual(flagged(await reload(), ids), ids, 'one write, persisted');
  assert.notEqual(metadata.archived['lead'], metadata.archived['sub-own'], 'archives never share a stamp');
  assert.equal(metadata.archived['sub-a'], metadata.archived['lead']);

  // Already archived: nothing changes, descendants included.
  assert.equal(await metadata.setArchived('lead', true, ['sub-new']), false);
  assert.deepEqual(flagged(metadata, ['sub-new']), []);

  assert.equal(await metadata.setArchived('lead', false, ['sub-a', 'sub-b', 'sub-own']), true);
  assert.deepEqual(flagged(await reload(), ids), ['sub-own']);
});