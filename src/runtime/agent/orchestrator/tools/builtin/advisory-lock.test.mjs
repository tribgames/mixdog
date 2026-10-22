import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { withAdvisoryLocks } from './advisory-lock.mjs';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-advisory-lock-'));
  const user = join(root, 'user');
  const overrides = {
    HOME: user,
    USERPROFILE: user,
    LOCALAPPDATA: join(root, 'local-app-data'),
    MIXDOG_HOME: join(root, 'profile'),
    MIXDOG_DATA_DIR: join(root, 'profile', 'data'),
    MIXDOG_RUNTIME_ROOT: join(root, 'profile', 'runtime'),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const lockDir =
    process.platform === 'win32' ? join(overrides.LOCALAPPDATA, 'mixdog', 'locks') : join(user, '.mixdog', 'locks');
  return { root, lockDir };
}

test('advisory lock leaves nothing beside the target and releases its lockfile', async (t) => {
  const { root, lockDir } = sandbox(t);
  const work = join(root, 'work');
  const target = join(work, 'nested', 'new.md');
  await withAdvisoryLocks([target], async () => {
    assert.equal(readdirSync(lockDir).length, 1);
    assert.equal(existsSync(work), false);
    assert.equal(existsSync(process.env.MIXDOG_HOME), false);
    if (process.platform !== 'win32') assert.equal(statSync(lockDir).mode & 0o777, 0o700);
  });
  assert.deepEqual(readdirSync(root), [process.platform === 'win32' ? 'local-app-data' : 'user']);
  assert.deepEqual(readdirSync(lockDir), []);
});

test('a failed edit releases the shared lock and preserves the callback error', async (t) => {
  const { root, lockDir } = sandbox(t);
  const target = join(root, 'work', 'new.md');
  const reason = new Error('edit failed');
  await assert.rejects(
    withAdvisoryLocks([target], async () => {
      throw reason;
    }),
    (error) => error === reason
  );
  assert.deepEqual(readdirSync(lockDir), []);
  assert.equal(await withAdvisoryLocks([target], async () => 'acquired'), 'acquired');
});

test('an unsafe shared lock directory refuses the edit without a profile-local fallback', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, lockDir } = sandbox(t);
  const other = join(root, 'other');
  mkdirSync(other);
  mkdirSync(dirname(lockDir), { recursive: true });
  symlinkSync(other, lockDir, 'dir');
  let entered = false;
  await assert.rejects(
    withAdvisoryLocks([join(root, 'work', 'new.md')], async () => {
      entered = true;
    }),
    (error) => error.code === 'EUNSAFERUNTIME'
  );
  assert.equal(entered, false);
  assert.equal(existsSync(process.env.MIXDOG_HOME), false);
  assert.deepEqual(readdirSync(other), []);
});

test('Windows uses the local user directory when LOCALAPPDATA is unset', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { root } = sandbox(t);
  delete process.env.LOCALAPPDATA;
  const lockDir = join(process.env.USERPROFILE, 'AppData', 'Local', 'mixdog', 'locks');
  await withAdvisoryLocks([join(root, 'work', 'new.md')], async () => {
    assert.equal(readdirSync(lockDir).length, 1);
  });
  assert.deepEqual(readdirSync(lockDir), []);
});

test('a leaf symlink and its referent contend for the same lock', async (t) => {
  const { root } = sandbox(t);
  const target = join(root, 'real.md');
  const link = join(root, 'link.md');
  writeFileSync(target, 'x');
  try {
    symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    return t.skip('Windows symlink creation is not permitted on this host');
  }
  await withAdvisoryLocks([target], async () => {
    await assert.rejects(
      withAdvisoryLocks([link], async () => {}),
      (err) => err.code === 'EAGAIN'
    );
  });
});

test('two spellings of one target contend for the same lock', { skip: process.platform !== 'win32' }, async (t) => {
  const { root } = sandbox(t);
  const target = join(root, 'File.md');
  await withAdvisoryLocks([target], async () => {
    await assert.rejects(
      withAdvisoryLocks([target.toUpperCase()], async () => {}),
      (err) => err.code === 'EAGAIN'
    );
  });
});
