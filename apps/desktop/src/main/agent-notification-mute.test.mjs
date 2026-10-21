import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  agentNotificationMutePath,
  createAgentNotificationMuteStore,
  readMutedAgents,
} from './agent-notification-mute.ts';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-mute-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return agentNotificationMutePath(dir);
}
const names = (file) => readdirSync(join(file, '..'));

test('a muted agent survives a restart', async (t) => {
  const file = tempFile(t);
  await createAgentNotificationMuteStore(file).setMuted('gh', true);
  assert.deepEqual([...readMutedAgents(file)], ['gh']);
  assert.equal(createAgentNotificationMuteStore(file).isMuted('gh'), true);
});

test('a NUL-filled mute list mutes nobody and is kept aside, not written over', async (t) => {
  const file = tempFile(t);
  writeFileSync(file, Buffer.alloc(100));
  assert.equal(readMutedAgents(file).size, 0);
  assert.equal(
    names(file).some((name) => name.includes('.corrupt-')),
    true
  );
  const store = createAgentNotificationMuteStore(file);
  await store.setMuted('rel', true);
  assert.deepEqual([...readMutedAgents(file)], ['rel']);
});

test('a damaged mute list gets its last good copy back', async (t) => {
  const file = tempFile(t);
  const store = createAgentNotificationMuteStore(file);
  await store.setMuted('gh', true);
  await store.setMuted('rel', true);
  writeFileSync(file, '{"muted":["gh","r');
  assert.deepEqual([...readMutedAgents(file)], ['gh']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { muted: ['gh'] });
  assert.equal(
    names(file).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    false
  );
});
