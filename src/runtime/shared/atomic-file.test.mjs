import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  withFileLock,
  withFileLockSync,
  updateJsonAtomic,
  updateJsonAtomicSync,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
} from './atomic-file.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-atomic-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'state.json'), lock: join(dir, 'state.json.lock') };
}

for (const update of [updateJsonAtomicSync, updateJsonAtomic]) {
  for (const code of ['EACCES', 'EIO']) {
    test(`${update.name} never mutates unreadable JSON after ${code}`, async (t) => {
      const { path, lock } = fixture(t);
      const source = '{"preserved":"user state"}';
      writeFileSync(path, source);
      const failure = Object.assign(new Error(`read failed: ${code}`), { code });
      const read = fs.readFileSync;
      const readAsync = fsPromises.readFile;
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      t.mock.method(fs, 'readFileSync', (target, ...args) => {
        if (target === path) throw failure;
        return read(target, ...args);
      });
      t.mock.method(fsPromises, 'readFile', async (target, ...args) => {
        if (target === path) throw failure;
        return readAsync(target, ...args);
      });
      syncBuiltinESMExports();
      let mutated = false;
      await assert.rejects(
        Promise.resolve().then(() =>
          update(
            path,
            () => {
              mutated = true;
              return { lost: true };
            },
            { fsync: false }
          )
        ),
        (error) => error === failure
      );
      assert.equal(mutated, false);
      assert.equal(read(path, 'utf8'), source);
      assert.equal(existsSync(lock), false);
    });
  }
}

test('JSON mutation retains its missing and malformed document recovery contract', async (t) => {
  const { path } = fixture(t);
  for (const update of [updateJsonAtomicSync, updateJsonAtomic]) {
    for (const malformed of [false, true]) {
      rmSync(path, { force: true });
      if (malformed) writeFileSync(path, '{malformed');
      await update(
        path,
        (value) => {
          assert.equal(value, null);
          return { recovered: true };
        },
        { fsync: false }
      );
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { recovered: true });
    }
  }
});

test('try-once async file locks retain the normal reentrant contract', async (t) => {
  const { lock } = fixture(t);
  const result = await withFileLock(
    lock,
    () =>
      withFileLock(lock, () => 42, {
        timeoutMs: 0,
      }),
    { timeoutMs: 0 }
  );
  assert.equal(result, 42);
  assert.equal(existsSync(lock), false);
});

test('detached async work cannot inherit ownership after its file lock was released', async (t) => {
  const { lock } = fixture(t);
  const startDetached = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const releaseSecond = Promise.withResolvers();
  let detached;
  let overlapped = false;
  await withFileLock(lock, () => {
    detached = startDetached.promise.then(() =>
      withFileLock(
        lock,
        () => {
          overlapped = true;
        },
        { timeoutMs: 0 }
      )
    );
  });
  const second = withFileLock(lock, async () => {
    secondEntered.resolve();
    await releaseSecond.promise;
  });
  try {
    await secondEntered.promise;
    const outcome = detached.then(
      () => null,
      (error) => error
    );
    startDetached.resolve();
    const error = await outcome;
    assert.equal(overlapped, false);
    assert.equal(error?.code, 'ELOCKCONTENDED');
  } finally {
    releaseSecond.resolve();
    await second;
  }
});

for (const acquire of [withFileLockSync, withFileLock]) {
  test(`${acquire.name} never deletes a replacement without its owner token`, async (t) => {
    const { lock } = fixture(t);
    const replacement = `${process.pid} ${Date.now()}\n`;
    await acquire(
      lock,
      () => {
        unlinkSync(lock);
        writeFileSync(lock, replacement);
      },
      { timeoutMs: 0 }
    );
    assert.equal(existsSync(lock), true);
    assert.equal(readFileSync(lock, 'utf8'), replacement);
  });
}

test('file-lock waiters do not consume the I/O slot needed by their current owner', (t) => {
  const { dir, path } = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { withFileLock, writeJsonAtomicAsync } from ${JSON.stringify(new URL('./atomic-file.mjs', import.meta.url).href)};
    const file = process.env.ATOMIC_TEST_PATH;
    const entered = Promise.withResolvers();
    const continueOwner = Promise.withResolvers();
    const owner = withFileLock(file + '.lock', async () => {
      entered.resolve();
      await continueOwner.promise;
      await writeJsonAtomicAsync(file, { owner: true }, { fsync: false });
    });
    await entered.promise;
    const waiter = writeJsonAtomicAsync(file, { waiter: true }, { lock: true, fsync: false });
    await new Promise(setImmediate);
    continueOwner.resolve();
    let timer;
    try {
      await Promise.race([
        Promise.all([owner, waiter]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('file lock / I/O admission deadlock')), 2000);
        }),
      ]);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { waiter: true });
    } finally { clearTimeout(timer); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    env: { ...process.env, MIXDOG_FILE_IO_MAX_CONCURRENCY: '1', ATOMIC_TEST_PATH: path },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

test('sync and async atomic creation preserve existing bytes and remove staging files', async (t) => {
  const { dir, path } = fixture(t);
  assert.equal(writeJsonAtomicSync(path, { first: true }, { createOnly: true }), true);
  const first = readFileSync(path, 'utf8');
  for (const write of [writeJsonAtomicSync, writeJsonAtomicAsync]) {
    assert.equal(await write(path, { replacement: true }, { createOnly: true, lock: true }), false);
    assert.equal(readFileSync(path, 'utf8'), first);
    assert.deepEqual(readdirSync(dir), ['state.json']);
  }
});

test('a failed holder releases its file lock for the next queued owner', async (t) => {
  const { lock } = fixture(t);
  const failure = new Error('mutation failed');
  const first = withFileLock(lock, () => {
    throw failure;
  });
  const next = withFileLock(lock, () => 'next owner');
  await assert.rejects(first, (error) => error === failure);
  assert.equal(await next, 'next owner');
  assert.equal(existsSync(lock), false);
});

test('sync waiters fail immediately against their own process async holder', async (t) => {
  const { lock } = fixture(t);
  await withFileLock(lock, () => {
    assert.throws(
      () =>
        withFileLockSync(lock, () => assert.fail('must not enter'), {
          timeoutMs: 10_000,
        }),
      (error) => error.code === 'ELOCKCONTENDED' && error.message.includes('async holder in this process')
    );
  });
});

test('live foreign tokens remain protected while a proven-dead owner can be reclaimed', async (t) => {
  const { lock } = fixture(t);
  writeFileSync(lock, `${process.pid} 0 foreign-token\n`);
  for (const acquire of [withFileLockSync, withFileLock]) {
    await assert.rejects(
      Promise.resolve().then(() =>
        acquire(
          lock,
          () => {
            assert.fail('a live holder must not be replaced');
          },
          { timeoutMs: 0, staleMs: 0 }
        )
      ),
      { code: 'ELOCKCONTENDED' }
    );
  }
  const deadPid = 999_999_999;
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid !== deadPid) return kill(pid, signal);
    throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
  });
  writeFileSync(lock, `${deadPid} 0 dead-token\n`);
  assert.equal(await withFileLock(lock, () => 'reclaimed', { timeoutMs: 0 }), 'reclaimed');
  assert.equal(existsSync(lock), false);
});

test('separate processes keep atomic read-modify-write updates mutually exclusive', async (t) => {
  const { dir, path } = fixture(t);
  writeJsonAtomicSync(path, { count: 0 });
  const source = `
    import { updateJsonAtomic } from ${JSON.stringify(new URL('./atomic-file.mjs', import.meta.url).href)};
    for (let index = 0; index < 8; index++) {
      await updateJsonAtomic(process.env.ATOMIC_TEST_PATH,
        (value) => ({ count: value.count + 1 }), { fsync: false });
    }
  `;
  const run = promisify(execFile);
  await Promise.all(
    Array.from({ length: 3 }, () =>
      run(process.execPath, ['--input-type=module', '-e', source], {
        cwd: dir,
        env: { ...process.env, ATOMIC_TEST_PATH: path },
        timeout: 10_000,
      })
    )
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { count: 24 });
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('secret writes fail closed without publishing when Windows ACL tooling is unavailable', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { dir, path } = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    import { existsSync, readdirSync } from 'node:fs';
    import { writeJsonAtomicSync, writeJsonAtomicAsync } from ${JSON.stringify(new URL('./atomic-file.mjs', import.meta.url).href)};
    process.env.SystemRoot = process.env.ATOMIC_MISSING_WINDOWS;
    process.env.windir = process.env.ATOMIC_MISSING_WINDOWS;
    const file = process.env.ATOMIC_TEST_PATH;
    for (const write of [writeJsonAtomicSync, writeJsonAtomicAsync]) {
      for (const lock of [false, true]) {
        try {
          await write(file, { secret: 'must-not-publish' }, { secret: true, fsync: false, lock });
          assert.fail('secret write must fail closed');
        } catch (error) { assert.equal(error.code, 'EACLNOICACLS'); }
        assert.equal(existsSync(file), false);
        assert.deepEqual(readdirSync(process.cwd()), []);
      }
    }
  `;
  const missingWindows = join(dir, 'missing-windows');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    env: {
      ...process.env,
      ATOMIC_TEST_PATH: path,
      ATOMIC_MISSING_WINDOWS: missingWindows,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

test('secret create-only publication never weakens the published file ACL during cleanup', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { dir, path } = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const path = process.env.ATOMIC_TEST_PATH;
    const execute = cp.execFileSync;
    cp.execFileSync = (command, args, options) => {
      if (String(command).toLowerCase().endsWith('icacls.exe')
        && args[0] === path && args.includes('/inheritance:r')) {
        throw new Error('fixture final-path ACL failure');
      }
      return execute(command, args, options);
    };
    syncBuiltinESMExports();
    const { writeJsonAtomicSync, writeJsonAtomicAsync } = await import(${JSON.stringify(new URL('./atomic-file.mjs', import.meta.url).href)});
    for (const write of [writeJsonAtomicSync, writeJsonAtomicAsync]) {
      let failed = false;
      try {
        assert.equal(await write(path, { secret: 'private' }, {
          createOnly: true, secret: true, lock: true, fsync: false,
        }), true);
      } catch (error) {
        failed = true;
        assert.match(error.message, /fixture final-path ACL failure/);
      }
      if (fs.existsSync(path)) {
        assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).secret, 'private');
        const inspectAcl = '$ErrorActionPreference = "Stop"; '
          + '$acl = [System.IO.File]::GetAccessControl($env:ATOMIC_TEST_PATH); '
          + '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); '
          + '[pscustomobject]@{ owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; '
          + 'rules = @($rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited } }) } '
          + '| ConvertTo-Json -Compress';
        const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const acl = JSON.parse(execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', inspectAcl], {
          encoding: 'utf8',
        }));
        assert.ok(acl.rules.length > 0);
        assert.ok(acl.rules.every((rule) => rule.sid === acl.owner && rule.inherited === false),
          'published secrets must retain owner-only permissions even if a later ACL operation fails');
        fs.rmSync(path);
      } else {
        assert.equal(failed, true);
      }
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    env: { ...process.env, ATOMIC_TEST_PATH: path },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

test('failed lock-owner writes never run the mutation or remove a replacement lock', (t) => {
  const { dir, lock } = fixture(t);
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { withFileLock, withFileLockSync } from ${JSON.stringify(new URL('./atomic-file.mjs', import.meta.url).href)};
    const lock = process.env.ATOMIC_TEST_LOCK;
    const write = fs.writeFileSync;
    const failure = Object.assign(new Error('lock owner write failed'), { code: 'ENOSPC' });
    const replacement = 'replacement owner\\n';
    for (const acquire of [withFileLockSync, withFileLock]) {
      for (const replace of [false, true]) {
        fs.writeFileSync = (target, ...args) => {
          if (typeof target !== 'number') return write(target, ...args);
          if (replace) {
            fs.unlinkSync(lock);
            write(lock, replacement);
          }
          throw failure;
        };
        syncBuiltinESMExports();
        let called = false;
        try {
          await assert.rejects(Promise.resolve().then(() => acquire(lock, () => {
            called = true;
          }, { timeoutMs: 0 })), (error) => error === failure);
          assert.equal(called, false);
          assert.equal(fs.existsSync(lock), replace);
          if (replace) assert.equal(fs.readFileSync(lock, 'utf8'), replacement);
        } finally {
          fs.writeFileSync = write;
          syncBuiltinESMExports();
          fs.rmSync(lock, { force: true });
        }
      }
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    env: { ...process.env, ATOMIC_TEST_LOCK: lock },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
