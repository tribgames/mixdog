import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { disposableProfile, PROFILE_DIR_ENV } from './disposable-profile.ts';

test('a profile the process made is removed, so a failed run leaves nothing behind', async () => {
  const profile = disposableProfile({});
  writeFileSync(join(profile.dir, 'held.bin'), 'x');
  assert.ok(existsSync(profile.dir));
  await profile.remove();
  assert.equal(existsSync(profile.dir), false);
});

test('a runner-owned profile is left to the runner, which removes it when the process is killed', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'mixdog-profile-owner-'));
  try {
    const profile = disposableProfile({ [PROFILE_DIR_ENV]: owned });
    assert.equal(profile.dir, owned);
    await profile.remove();
    assert.ok(existsSync(owned));
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});
