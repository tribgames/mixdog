import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite } from './atomic-write.mjs';

const fsp = fs.promises;
const payloads = [
  ['buffered', Buffer.from('new content')],
  ['streamed', Buffer.alloc(1024 * 1024 + 17, 0x61)],
];

function fixture(t, faultAt, code = 'EIO') {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mixdog-temp-owner-'));
  const target = join(dir, 'target.txt');
  const temp = join(dir, '.target.txt.mixdog-tmp-01010101');
  const original = Buffer.from('original target');
  fs.writeFileSync(target, original);
  const events = [];
  const failure = Object.assign(new Error(`injected ${faultAt}`), { code });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(crypto, 'randomBytes', (length) => {
    assert.equal(length, 4);
    return Buffer.alloc(length, 1);
  });
  const originalOpen = fsp.open;
  t.mock.method(fsp, 'open', async (path, flags, ...args) => {
    if (path !== temp) return originalOpen(path, flags, ...args);
    events.push(`open:${flags}`);
    if ((faultAt === 'open' && flags === 'wx') || (faultAt === 'reopen' && flags === 'r+')) throw failure;
    const handle = await originalOpen(path, flags, ...args);
    events.push('opened');
    const write = handle.writeFile.bind(handle);
    if (faultAt === 'write') t.mock.method(handle, 'writeFile', async () => {
      await write('partial');
      events.push('partial');
      throw failure;
    });
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, 'sync', async () => {
      events.push('sync');
      if (faultAt === 'sync') throw failure;
      return sync();
    });
    const close = handle.close.bind(handle);
    let didClose = false;
    t.mock.method(handle, 'close', async () => {
      await close();
      events.push('closed');
      if (faultAt === 'close' && !didClose) {
        didClose = true;
        throw failure;
      }
    });
    return handle;
  });
  const createStream = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (path, options) => {
    if (path !== temp) return createStream(path, options);
    events.push('stream');
    assert.equal(options.flags, 'wx');
    // Use a real fs.WriteStream and descriptor, injecting faults only at its
    // filesystem boundary. Close ordering matters on Windows as well as Linux.
    return createStream(path, { ...options, fs: {
      open(file, flags, mode, callback) {
        events.push('stream-open');
        if (faultAt === 'open') return queueMicrotask(() => callback(failure));
        fs.open(file, flags, mode, (error, fd) => {
          if (!error) events.push('opened');
          callback(error, fd);
        });
      },
      write(fd, buffer, offset, length, position, callback) {
        if (faultAt !== 'write') return fs.write(fd, buffer, offset, length, position, callback);
        fs.write(fd, buffer, offset, Math.min(length, 7), position, (error) => {
          events.push('partial');
          callback(error || failure);
        });
      },
      close(fd, callback) {
        fs.close(fd, (error) => {
          events.push('closed');
          callback(error || (faultAt === 'close' ? failure : null));
        });
      },
    } });
  });
  const unlink = fsp.unlink;
  t.mock.method(fsp, 'unlink', async (path) => {
    if (path === temp) events.push('unlink');
    return unlink(path);
  });
  syncBuiltinESMExports();
  const unchanged = () => assert.deepEqual(fs.readFileSync(target), original);
  return { dir, target, temp, events, failure, unchanged };
}

for (const [label, payload] of payloads) {
  for (const fsync of [false, true]) {
    test(`${label}: an existing temporary file survives an exclusive-create collision (fsync=${fsync})`, async (t) => {
      const f = fixture(t);
      const otherWriter = Buffer.from('another writer owns this temporary file');
      fs.writeFileSync(f.temp, otherWriter);
      await assert.rejects(atomicWrite(f.target, payload, { fsync }), { code: 'EEXIST' });
      f.unchanged();
      assert.deepEqual(fs.readFileSync(f.temp), otherWriter);
      assert.equal(f.events.includes('opened'), false);
      assert.equal(f.events.includes('unlink'), false, 'failed creation must not attempt cleanup');
    });
  }

  for (const code of ['EACCES', 'EIO']) {
    test(`${label}: an open ${code} is preserved without attempting unlink`, async (t) => {
      const f = fixture(t, 'open', code);
      await assert.rejects(atomicWrite(f.target, payload), (error) => error === f.failure);
      f.unchanged();
      assert.equal(f.events.includes('opened'), false);
      assert.equal(f.events.includes('unlink'), false);
      assert.equal(fs.existsSync(f.temp), false);
      assert.ok(f.events.includes(label === 'streamed' ? 'stream-open' : 'open:wx'));
    });
  }

  test(`${label}: an existing temporary symlink is neither unlinked nor followed`, async (t) => {
    const f = fixture(t);
    const referent = join(f.dir, 'other');
    fs.mkdirSync(referent);
    fs.writeFileSync(join(referent, 'keep.txt'), 'keep');
    // Directory junctions do not require Windows file-symlink privileges.
    fs.symlinkSync(referent, f.temp, process.platform === 'win32' ? 'junction' : 'dir');
    const link = fs.readlinkSync(f.temp);
    await assert.rejects(atomicWrite(f.target, payload), (error) =>
      ['EEXIST', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code));
    f.unchanged();
    assert.equal(f.events.includes('unlink'), false);
    assert.equal(fs.lstatSync(f.temp).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(f.temp), link);
    assert.equal(fs.readFileSync(join(referent, 'keep.txt'), 'utf8'), 'keep');
  });

  for (const fault of ['write', 'sync', 'close']) {
    test(`${label}: ${fault} failure closes and removes only the acquired temporary file`, async (t) => {
      const f = fixture(t, fault);
      await assert.rejects(atomicWrite(f.target, payload, { fsync: fault === 'sync' }),
        (error) => error === f.failure);
      f.unchanged();
      assert.ok(f.events.includes('opened'));
      if (fault === 'write') assert.ok(f.events.includes('partial'));
      if (fault === 'sync') assert.ok(f.events.includes('sync'));
      assert.ok(f.events.indexOf('closed') < f.events.indexOf('unlink'));
      assert.equal(f.events.filter((event) => event === 'unlink').length, 1);
      assert.equal(fs.existsSync(f.temp), false);
    });
  }

  for (const fsync of [false, true]) {
    test(`${label}: successful publication preserves payload and temporary-file lifecycle (fsync=${fsync})`, async (t) => {
      const f = fixture(t);
      await atomicWrite(f.target, payload, { fsync, mode: 0o600 });
      assert.deepEqual(fs.readFileSync(f.target), payload);
      assert.equal(fs.existsSync(f.temp), false);
      assert.equal(f.events.includes('stream'), label === 'streamed');
      assert.equal(f.events.includes('sync'), fsync);
      assert.equal(f.events.includes('unlink'), false, 'rename consumes a successful temporary file');
      if (process.platform !== 'win32') assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
    });
  }

  test(`${label}: target create-only refusal still removes our completed temporary file`, async (t) => {
    const f = fixture(t);
    await assert.rejects(atomicWrite(f.target, payload, { flags: 'wx' }),
      (error) => error.code === 'EEXIST' && error.__skip === true);
    f.unchanged();
    assert.equal(fs.existsSync(f.temp), false);
    assert.ok(f.events.includes('opened'));
    assert.equal(f.events.filter((event) => event === 'unlink').length, 1);
  });
}

test('streamed: a failed fsync reopen retains creation ownership for cleanup', async (t) => {
  const f = fixture(t, 'reopen', 'EACCES');
  await assert.rejects(atomicWrite(f.target, payloads[1][1], { fsync: true }),
    (error) => error === f.failure);
  f.unchanged();
  assert.ok(f.events.indexOf('closed') < f.events.indexOf('open:r+'));
  assert.equal(f.events.filter((event) => event === 'unlink').length, 1);
  assert.equal(fs.existsSync(f.temp), false);
});

test('streamed: multibyte strings still select streaming by byte length', async (t) => {
  const f = fixture(t);
  const text = '가'.repeat(400_000);
  assert.ok(text.length < 1024 * 1024 && Buffer.byteLength(text) > 1024 * 1024);
  await atomicWrite(f.target, text, { fsync: true });
  assert.equal(fs.readFileSync(f.target, 'utf8'), text);
  assert.ok(f.events.includes('stream'));
  assert.equal(fs.existsSync(f.temp), false);
});
