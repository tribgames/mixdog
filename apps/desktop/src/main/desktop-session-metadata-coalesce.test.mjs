import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

const SESSION = 'session-a';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-coalesce-'));
  const writes = { count: 0 };
  const realRename = fsPromises.rename;
  t.mock.method(fsPromises, 'rename', (src, dst) => {
    if (String(dst).endsWith('desktop-session-metadata.json')) writes.count += 1;
    return realRename(src, dst);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const reload = async () => {
    const next = new DesktopSessionMetadata(() => root);
    await next.load();
    return next;
  };
  return { metadata, reload, writes };
}

test('rapid read-cursor advances share one write', async (t) => {
  const { metadata, reload, writes } = await fixture(t);
  for (let count = 1; count <= 50; count += 1) await metadata.markRead(SESSION, count, false);
  assert.equal(metadata.reads[SESSION].messageCount, 50, 'memory is current immediately');
  assert.equal(writes.count, 0, 'nothing is written inside the window');
  await metadata.flush();
  assert.equal(writes.count, 1);
  assert.equal((await reload()).reads[SESSION].messageCount, 50);
});

test('an unchanged value writes nothing', async (t) => {
  const { metadata, writes } = await fixture(t);
  await metadata.markRead(SESSION, 4, false);
  await metadata.flush();
  const before = writes.count;
  await metadata.markRead(SESSION, 4, false);
  await metadata.markRead(SESSION, 2, false);
  await metadata.flush();
  await metadata.setName(SESSION, 'Name');
  const named = writes.count;
  await metadata.setName(SESSION, 'Name');
  assert.equal(before, 1);
  assert.equal(named, before + 1);
  assert.equal(writes.count, named);
});

test('a pending read cursor is flushed by the quit path and by the window timer', async (t) => {
  const { metadata, reload, writes } = await fixture(t);
  await metadata.markRead(SESSION, 7, false);
  await metadata.flush(); // dispose() flushes the metadata on quit
  assert.equal((await reload()).reads[SESSION].messageCount, 7);

  await metadata.markRead(SESSION, 9, false);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(writes.count, 2, 'the trailing window wrote on its own');
  assert.equal((await reload()).reads[SESSION].messageCount, 9);
});

test('a coalesced write still merges with concurrent external writes', async (t) => {
  const { metadata, reload } = await fixture(t);
  const other = await reload();
  await other.setName('session-b', 'Saved by the other service');
  await metadata.markRead(SESSION, 3, false);
  await metadata.markRead(SESSION, 5, false);
  await metadata.flush();
  const merged = await reload();
  assert.equal(merged.names['session-b'], 'Saved by the other service');
  assert.equal(merged.reads[SESSION].messageCount, 5);
});
