import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

test('shared session read cursors persist and advance for completion-only reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-session-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  assert.equal(await metadata.markRead('session-a', 4, false), true);
  assert.equal(await metadata.markRead('session-a', 4, false), false);
  assert.equal(await metadata.markRead('session-a', 4, true), true);

  assert.deepEqual(metadata.withReadCursors([{ id: 'session-a' }]), [{
    id: 'session-a',
    readMessageCount: 4,
    readRevision: 2,
  }]);

  const reloaded = new DesktopSessionMetadata(() => root);
  await reloaded.load();
  assert.deepEqual(reloaded.withReadCursors([{ id: 'session-a' }]), [{
    id: 'session-a',
    readMessageCount: 4,
    readRevision: 2,
  }]);

  await reloaded.forget('session-a');
  assert.deepEqual(reloaded.withReadCursors([{ id: 'session-a' }]), [{ id: 'session-a' }]);
});
