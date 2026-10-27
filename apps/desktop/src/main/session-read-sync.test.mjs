import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { desktopSessionSummaries } from './desktop-state.ts';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

test('shared session read cursors persist and advance for completion-only reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  assert.equal(await metadata.markRead('session-a', 4, false), true);
  assert.equal(await metadata.markRead('session-a', 4, false), false);
  assert.equal(await metadata.markRead('session-a', 4, true), true);

  assert.deepEqual(metadata.withReadCursors([{ id: 'session-a' }]), [
    {
      id: 'session-a',
      readMessageCount: 4,
      readRevision: 2,
    },
  ]);

  const reloaded = new DesktopSessionMetadata(() => root);
  await reloaded.load();
  assert.deepEqual(reloaded.withReadCursors([{ id: 'session-a' }]), [
    {
      id: 'session-a',
      readMessageCount: 4,
      readRevision: 2,
    },
  ]);

  await reloaded.forget('session-a');
  assert.deepEqual(reloaded.withReadCursors([{ id: 'session-a' }]), [{ id: 'session-a' }]);
});

test('the catalog row carries the daemon’s compaction count only when it is a real one', () => {
  const row = (id, extra) => ({ id, title: `Conversation ${id}`, cwd: '/repos/app', messageCount: 62, ...extra });
  const summaries = desktopSessionSummaries([
    row('sess_compacted', { compactCount: 17 }),
    row('sess_fresh', { compactCount: 0 }),
    row('sess_unknown', {}),
    row('sess_nan', { compactCount: Number.NaN }),
    row('sess_negative', { compactCount: -1 }),
    row('sess_text', { compactCount: '17' }),
  ]);
  assert.deepEqual(
    summaries.map((summary) => [summary.id, summary.compactCount]),
    [
      ['sess_compacted', 17],
      ['sess_fresh', 0],
      ['sess_unknown', undefined],
      ['sess_nan', undefined],
      ['sess_negative', undefined],
      ['sess_text', undefined],
    ]
  );
});

async function metadataFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const reload = async () => {
    await metadata.flush();
    const next = new DesktopSessionMetadata(() => root);
    await next.load();
    return next;
  };
  return { metadata, reload };
}

test('a compaction restarts the cursor at 0 without counting as a read', async (t) => {
  const { metadata, reload } = await metadataFixture(t);
  // Read to the end of 417 messages, under compaction count 16.
  await metadata.markRead('s', 417, false, { compactCount: 16, messageCount: 417 });
  assert.deepEqual(metadata.reads.s, { messageCount: 417, revision: 1, epoch: 16 });

  // The next turn compacts to 66 messages: a new numbering, the same revision
  // (the surfaces take a revision advance for a read), nothing read in it yet.
  const compacted = [{ id: 's', messageCount: 66, compactCount: 17 }];
  assert.deepEqual(metadata.withReadCursors(compacted), [
    { id: 's', messageCount: 66, compactCount: 17, readMessageCount: 0, readRevision: 1 },
  ]);
  assert.equal(metadata.withReadCursors(compacted)[0].readRevision, 1, 'settled: no further change');

  // Persisted, and a real read in the new numbering advances it as usual.
  const reloaded = await reload();
  assert.deepEqual(reloaded.reads.s, { messageCount: 0, revision: 1, epoch: 17 });
  assert.equal(await reloaded.markRead('s', 66, false, { compactCount: 17, messageCount: 66 }), true);
  assert.deepEqual(reloaded.reads.s, { messageCount: 66, revision: 2, epoch: 17 });
});

test('a cursor that outlived a compaction before the compaction count was recorded follows the session down', async (t) => {
  const { metadata, reload } = await metadataFixture(t);
  // The live state: read to 417 messages, the session since compacted to 62.
  await metadata.markRead('stale', 417, false);
  await metadata.markRead('within', 10, false);
  assert.deepEqual(metadata.reads.stale, { messageCount: 417, revision: 1 });

  const rows = [
    { id: 'stale', messageCount: 62, compactCount: 17 },
    // Compacted too, but its cursor is not above its count: it is only stamped.
    { id: 'within', messageCount: 12, compactCount: 3 },
  ];
  assert.deepEqual(
    metadata
      .withReadCursors(rows)
      .map(({ id, readMessageCount, readRevision }) => [id, readMessageCount, readRevision]),
    [
      ['stale', 62, 1],
      ['within', 10, 1],
    ]
  );
  const reloaded = await reload();
  assert.deepEqual(reloaded.reads.stale, { messageCount: 62, revision: 1, epoch: 17 });
  assert.deepEqual(reloaded.reads.within, { messageCount: 10, revision: 1, epoch: 3 });
  // The session grows again: the cursor stays behind it.
  assert.deepEqual(
    reloaded.withReadCursors([{ id: 'stale', messageCount: 64, compactCount: 17 }])[0].readMessageCount,
    62
  );
});

test('a missing or invalid count never lowers a cursor; a stale local count cannot read past the session', async (t) => {
  const { metadata, reload } = await metadataFixture(t);
  await metadata.markRead('stale', 417, false);
  await metadata.markRead('stamped', 40, false, { compactCount: 2, messageCount: 40 });

  for (const messageCount of [0, undefined, Number.NaN, -3, 2.5, '62']) {
    const [stale, stamped] = metadata.withReadCursors([
      { id: 'stale', messageCount, compactCount: 17 },
      { id: 'stamped', messageCount, compactCount: 2 },
    ]);
    assert.equal(stale.readMessageCount, 417, `count ${String(messageCount)} leaves a cursor from before the epoch`);
    assert.equal(stamped.readMessageCount, 40, `count ${String(messageCount)} leaves a cursor of its epoch`);
  }
  // A row without a compaction count settles nothing either.
  assert.equal(metadata.withReadCursors([{ id: 'stale', messageCount: 62 }])[0].readMessageCount, 417);
  assert.deepEqual(metadata.reads.stale, { messageCount: 417, revision: 1 }, 'not even stamped');

  // A read judged against an invalid count leaves it unstamped too.
  assert.equal(await metadata.markRead('stale', 500, false, { compactCount: 17, messageCount: 0 }), true);
  assert.deepEqual(metadata.reads.stale, { messageCount: 500, revision: 2 });

  // A real count settles it; a surface counting in the old numbering (a local
  // seen count of 417) then cannot read past the session's 62 messages.
  assert.equal(metadata.withReadCursors([{ id: 'stale', messageCount: 62, compactCount: 17 }])[0].readMessageCount, 62);
  assert.equal(await metadata.markRead('stale', 417, false, { compactCount: 17, messageCount: 62 }), false);
  assert.deepEqual((await reload()).reads.stale, { messageCount: 62, revision: 2, epoch: 17 });
});
