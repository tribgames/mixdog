import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createScreenAccessSettingsStore } from './screen-access-settings.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'mixdog-screen-settings-'));

test('whole-PC screen control is off by default with no grants', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    assert.deepEqual(await store.read(), { enabled: false, grants: {} });
    assert.equal(await store.isEnabled(), false);
    // A grant is inert while the switch is off, even if set.
    await store.setGrant('client-a', 'control');
    assert.equal(await store.grantFor('client-a'), 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('enabling the switch exposes stored grants and survives reopen', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    await store.setEnabled(true);
    await store.setGrant('client-a', 'view');
    await store.setGrant('client-b', 'control');
    assert.equal(await store.grantFor('client-a'), 'view');
    assert.equal(await store.grantFor('client-b'), 'control');
    assert.equal(await store.grantFor('client-c'), 'none');

    const reopened = createScreenAccessSettingsStore(dir);
    const view = await reopened.read();
    assert.equal(view.enabled, true);
    assert.deepEqual(view.grants, { 'client-a': 'view', 'client-b': 'control' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lowering a grant to none and forgetting a client both clear it', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    await store.setEnabled(true);
    await store.setGrant('client-a', 'control');
    await store.setGrant('client-a', 'none');
    assert.equal(await store.grantFor('client-a'), 'none');

    await store.setGrant('client-b', 'view');
    await store.forget('client-b');
    assert.deepEqual((await store.read()).grants, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turning the switch off keeps grants but denies them until on again', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    await store.setEnabled(true);
    await store.setGrant('client-a', 'control');
    await store.setEnabled(false);
    assert.equal(await store.grantFor('client-a'), 'none');
    // The grant was preserved, not erased.
    assert.deepEqual((await store.read()).grants, { 'client-a': 'control' });
    await store.setEnabled(true);
    assert.equal(await store.grantFor('client-a'), 'control');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every saved change is signalled so a live session re-checks its grant', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    const seen = [];
    const off = store.onChange((settings) => seen.push(settings));
    await store.setEnabled(true);
    await store.setGrant('client-a', 'control');
    await store.forget('client-a');
    assert.deepEqual(
      seen.map((settings) => [settings.enabled, settings.grants['client-a'] ?? 'none']),
      [
        [true, 'none'],
        [true, 'control'],
        [true, 'none'],
      ]
    );
    off();
    await store.setEnabled(false);
    assert.equal(seen.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed stored grants are dropped on read', async () => {
  const dir = await tmp();
  try {
    const store = createScreenAccessSettingsStore(dir);
    await store.setEnabled(true);
    await store.setGrant('client-a', 'view');
    // Hand-written junk in the file must not leak through.
    const { writeSecretFile } = await import('../secret-file.ts');
    await writeSecretFile(join(dir, 'remote-screen-settings.json'), JSON.stringify({ enabled: true, grants: { 'client-a': 'owner', 'client-b': 'control', '': 'view' } }));
    assert.deepEqual((await store.read()).grants, { 'client-b': 'control' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
