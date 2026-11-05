// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  deleteSession,
  drainSessionStore,
  evictIdleLiveSessions,
  getSessionSaveError,
  hasPendingSessionWrite,
  loadSession,
  loadSessionStatus,
  saveSession,
  saveSessionAsync,
} from '../store.mjs';
import { forgetSessionLoadCache, sessionLoadCacheStats } from './load-cache.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';
import { releaseSessionWriter } from './session-writer-claim.mjs';
import { _sessionLogIoForTest } from './session-log-writer.mjs';
import { readDurableSessionRecord } from './transcript-durability.mjs';
import {
  _clearSessionSaveState,
  _liveSessions,
  _recordSaveDrop,
  _recordSaveFailure,
  clearSessionSaveError,
  setLiveSession,
} from './live-state.mjs';

let sequence = 0;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-load-cache-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const id = `sess_load_cache_${process.pid}_${++sequence}`;
  const path = join(root, 'sessions', `${id}.json`);
  const saved = {
    id,
    generation: 1,
    closed: false,
    messages: [{ role: 'user', content: 'saved conversation' }],
    tools: [{ name: 'saved-tool', inputSchema: { type: 'object' } }],
  };
  const write = (value) => {
    writeFileSync(`${path}.next`, typeof value === 'string' ? value : JSON.stringify(value));
    renameSync(`${path}.next`, path);
  };
  write(saved);
  t.after(() => {
    _liveSessions.delete(id);
    _clearSessionSaveState(id);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { id, path, saved, write };
}

test('restored repeated text stays byte-exact and message containers remain independent', (t) => {
  const f = fixture(t);
  const text = `${'한글 🙂 repeated text\n'.repeat(128)}\ud800\u0000`;
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'unchanged-image-bytes' } };
  const saved = {
    ...f.saved,
    messages: [
      { role: 'user', content: [{ type: 'text', text }, image] },
      { role: 'assistant', content: [{ type: 'text', text }, image] },
      { role: 'tool', content: text },
    ],
  };
  f.write(saved);
  const original = readFileSync(f.path);
  const restored = loadSession(f.id);
  assert.deepEqual(restored, saved);
  restored.messages[0].content[0].text = 'changed only in this message';
  restored.messages[0].content[1].source.data = 'changed only in this image';
  assert.equal(restored.messages[1].content[0].text, text);
  assert.equal(restored.messages[1].content[1].source.data, image.source.data);
  assert.equal(restored.messages[2].content, text);
  assert.deepEqual(readFileSync(f.path), original);
  f.write(saved);
  assert.deepEqual(loadSession(f.id), saved);
});

for (const warmDiskFirst of [false, true]) {
  test(`live data is reused without changing disk, and full disk data survives live release: warm=${warmDiskFirst}`, (t) => {
    const f = fixture(t);
    const original = readFileSync(f.path);
    if (warmDiskFirst) assert.deepEqual(loadSession(f.id), f.saved);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'unsaved-image-bytes' } };
    const live = {
      ...f.saved,
      messages: [...f.saved.messages, { role: 'user', content: [image] }],
    };
    setLiveSession(live);
    assert.equal(loadSession(f.id), live);
    live.messages.push({ role: 'assistant', content: 'unsaved reply' });
    assert.equal(loadSession(f.id), live);
    assert.equal(live.messages[1].content[0], image);
    assert.deepEqual(readFileSync(f.path), original);
    _liveSessions.delete(f.id);
    const restored = loadSession(f.id);
    assert.deepEqual(restored, f.saved);
    assert.equal(loadSession(f.id), restored);
    assert.deepEqual(readFileSync(f.path), original);
  });
}

test('a newer disk owner replaces a live snapshot with the full newer transcript', (t) => {
  const f = fixture(t);
  const live = { ...f.saved, messages: [{ role: 'assistant', content: 'old live owner' }] };
  setLiveSession(live);
  assert.equal(loadSession(f.id), live);
  const newer = { ...f.saved, generation: 2, messages: [{ role: 'user', content: 'new owner conversation' }] };
  f.write(newer);
  assert.deepEqual(loadSession(f.id), newer);
  assert.equal(_liveSessions.has(f.id), false);
});

test('unsaved dropped work survives a newer generation, then a header-only cache restores disk after unpinning', (t) => {
  const f = fixture(t);
  const live = { ...f.saved, messages: [{ role: 'assistant', content: 'only complete unsaved conversation' }] };
  setLiveSession(live);
  _recordSaveDrop(f.id);
  const newer = { ...f.saved, generation: 2 };
  f.write(newer);
  assert.equal(loadSession(f.id), live);
  _clearSessionSaveState(f.id);
  assert.deepEqual(loadSession(f.id), newer);
  assert.equal(_liveSessions.has(f.id), false);
});

for (const kind of ['malformed', 'foreign', 'duplicate-id']) {
  test(`a live validation-cache hit cannot hide ${kind} disk corruption`, (t) => {
    const f = fixture(t);
    const live = { ...f.saved };
    setLiveSession(live);
    assert.equal(loadSession(f.id), live);
    const invalid = {
      malformed: '{"broken":',
      foreign: JSON.stringify({ ...f.saved, id: 'foreign-session' }),
      'duplicate-id': `{"id":"foreign-session","id":${JSON.stringify(f.id)},"messages":[]}`,
    }[kind];
    f.write(invalid);
    assert.equal(loadSession(f.id), null);
    assert.equal(_liveSessions.get(f.id), live);
    assert.equal(readFileSync(f.path, 'utf8'), invalid);
    f.write(f.saved);
    assert.equal(loadSession(f.id), live);
  });
}

test('a NUL-filled session file is absent, can be saved over, and a delete sets it aside', async (t) => {
  const f = fixture(t);
  f.write('\0'.repeat(64));
  assert.equal(loadSession(f.id), null);
  saveSession({ ...f.saved, messages: [{ role: 'user', content: 'recreated' }] });
  assert.equal(loadSession(f.id).messages[0].content, 'recreated');
  f.write('\0'.repeat(64));
  assert.equal(await deleteSession(f.id), true);
  assert.equal(existsSync(f.path), false);
  const aside = readdirSync(dirname(f.path)).filter((name) => name.startsWith(`${f.id}.json.corrupt-`));
  assert.equal(aside.length, 1);
});

test('a debounced save that falls due while a delete runs writes nothing, and the delete leaves no lock held', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  saveSession({ ...f.saved, messages: [{ role: 'user', content: 'debounced' }] });
  const deleting = deleteSession(f.id);
  // The debounce runs out while the delete is under way.
  t.mock.timers.tick(1000);
  assert.equal(await deleting, true);
  // Another process could take the session's writer lock now.
  const lockPath = join(dirname(dirname(f.path)), 'session-writer-locks', `${f.id}.lock`);
  const other = acquireOsExclusiveLockSync(lockPath, { namespace: 'session-writer' });
  assert.equal(other.held, true, 'the delete resolved with the writer lock still held');
  other.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    readdirSync(dirname(f.path)).filter((name) => name.startsWith(f.id)),
    [],
    'a file of the deleted session is there'
  );
  assert.equal(loadSession(f.id), null);
});

test('saves made while a delete runs wait behind it, then create the session anew; the delete holds nothing after it', async (t) => {
  const f = fixture(t);
  const lockPath = join(dirname(dirname(f.path)), 'session-writer-locks', `${f.id}.lock`);
  assert.equal(await saveSessionAsync({ ...f.saved, messages: [{ role: 'user', content: 'saved' }] }), 'saved');
  const deleting = deleteSession(f.id);
  saveSession({ ...f.saved, messages: [{ role: 'user', content: 'debounced during the delete' }] });
  const during = saveSessionAsync({ ...f.saved, messages: [{ role: 'user', content: 'awaited during the delete' }] });
  assert.equal(hasPendingSessionWrite(f.id), true, 'the saves made during the delete are not accepted');
  assert.equal(await deleting, true);
  // The delete let its claim go before the saves behind it ran.
  assert.equal(await during, 'saved');
  // The awaited save is the newer one: it superseded the debounced copy.
  assert.equal(hasPendingSessionWrite(f.id), false, 'a superseded debounced copy is still pending');
  forgetSessionLoadCache(f.id);
  assert.deepEqual(
    readDurableSessionRecord(f.id).messages.map((message) => message.content),
    ['awaited during the delete']
  );
  assert.equal(await releaseSessionWriter(f.id), true);
  const other = acquireOsExclusiveLockSync(lockPath, { namespace: 'session-writer' });
  assert.equal(other.held, true);
  other.release();
});

test('a save made after a delete creates the session again from its copy, as v1.4.5 did', async (t) => {
  const f = fixture(t);
  // A copy read from the record, then the record deleted under it.
  const loaded = loadSession(f.id);
  assert.equal(await deleteSession(f.id), true);
  loaded.messages = [...loaded.messages, { role: 'assistant', content: 'after the delete' }];
  assert.equal(await saveSessionAsync(loaded, { expectedGeneration: loaded.generation }), 'saved');
  forgetSessionLoadCache(f.id);
  assert.deepEqual(
    loadSession(f.id).messages.map((message) => message.content),
    ['saved conversation', 'after the delete']
  );
  // The session is this process's again; its lock goes before the dir does.
  assert.equal(await releaseSessionWriter(f.id), true);
});

const turns = async (count) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('overlapping deletes run one after the other, a save made meanwhile lands after both, and nothing acknowledged is deleted', async (t) => {
  const f = fixture(t);
  const copy = (...contents) => ({ ...f.saved, messages: contents.map((content) => ({ role: 'user', content })) });
  assert.equal(await saveSessionAsync(copy('saved')), 'saved');
  // A batch is mid-fsync when the first delete starts: it waits for it.
  const io = _sessionLogIoForTest();
  const realFsync = io.fsync;
  let resume = null;
  io.fsync = (fd, callback) => {
    io.fsync = realFsync;
    resume = () => realFsync(fd, callback);
  };
  t.after(() => {
    io.fsync = realFsync;
  });
  const inFlight = saveSessionAsync(copy('saved', 'in flight'));
  const first = deleteSession(f.id);
  const second = deleteSession(f.id);
  let secondEnded = false;
  void second.then(() => (secondEnded = true));
  await turns(20);
  assert.equal(secondEnded, false, 'the second delete ended while the first was still under way');
  let duringOutcome = null;
  const during = saveSessionAsync(copy('during the deletes')).then((outcome) => (duringOutcome = outcome));
  await turns(20);
  assert.equal(duringOutcome, null, 'a save ran inside a delete accepted before it');
  resume();
  assert.deepEqual(await Promise.all([inFlight, first, second, during]), ['saved', true, true, 'saved']);
  // The save came after both deletes: it created the session, and nothing deleted it.
  await turns(20);
  forgetSessionLoadCache(f.id);
  assert.deepEqual(
    readDurableSessionRecord(f.id).messages.map((message) => message.content),
    ['during the deletes']
  );
  assert.equal(await releaseSessionWriter(f.id), true);
});

test('a delete whose unlink fails leaves the recorder, the live copy and its debounced save as they were', async (t) => {
  const f = fixture(t);
  const live = loadSession(f.id);
  live.messages = [...live.messages, { role: 'user', content: 'saved' }];
  assert.equal(await saveSessionAsync(live), 'saved');
  live.messages = [...live.messages, { role: 'user', content: 'queued' }];
  saveSession(live);
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = function (path, ...rest) {
    if (String(path).includes(f.id)) throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
    return realUnlink.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await deleteSession(f.id), false);
  } finally {
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
  }
  assert.equal(hasPendingSessionWrite(f.id), true, 'the debounced save was lost');
  // The exit drain writes the live copy's debounced save where the log stands.
  drainSessionStore();
  assert.equal(getSessionSaveError(f.id), null);
  forgetSessionLoadCache(f.id);
  assert.deepEqual(
    readDurableSessionRecord(f.id).messages.map((message) => message.content),
    ['saved conversation', 'saved', 'queued']
  );
});

test('a fresh save made during a delete that fails lands on the intact session', async (t) => {
  const f = fixture(t);
  const live = loadSession(f.id);
  live.messages = [...live.messages, { role: 'user', content: 'saved' }];
  assert.equal(await saveSessionAsync(live), 'saved');
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = function (path, ...rest) {
    if (String(path).includes(f.id)) throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
    return realUnlink.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  let deleted;
  const fresh = { ...live, messages: [...live.messages, { role: 'user', content: 'fresh during the delete' }] };
  try {
    const deleting = deleteSession(f.id);
    saveSession(fresh);
    deleted = await deleting;
  } finally {
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
  }
  assert.equal(deleted, false);
  await turns(5);
  // The live session is the fresh copy as it was submitted (taken when accepted).
  assert.deepEqual(
    loadSession(f.id).messages.map((message) => message.content),
    fresh.messages.map((message) => message.content),
    'the fresh copy is not the live session'
  );
  drainSessionStore();
  forgetSessionLoadCache(f.id);
  assert.deepEqual(
    readDurableSessionRecord(f.id).messages.map((message) => message.content),
    ['saved conversation', 'saved', 'fresh during the delete']
  );
});

for (const awaited of [true, false]) {
  test(`a${awaited ? 'n awaited' : ' debounced'} save accepted behind a delete that fails writes what was submitted, not what the caller changed after`, async (t) => {
    const f = fixture(t);
    const live = loadSession(f.id);
    assert.equal(await saveSessionAsync(live), 'saved');
    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = function (path, ...rest) {
      if (String(path).includes(f.id)) throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
      return realUnlink.call(this, path, ...rest);
    };
    syncBuiltinESMExports();
    let deleted;
    let saved;
    try {
      const deleting = deleteSession(f.id);
      live.title = 'intended';
      live.messages = [...live.messages, Object.freeze({ role: 'user', content: 'intended' })];
      const saving = awaited ? saveSessionAsync(live) : (saveSession(live), Promise.resolve('debounced'));
      // Changed after the save was submitted, and never submitted.
      live.messages = [];
      live.title = 'never submitted';
      [deleted, saved] = await Promise.all([deleting, saving]);
    } finally {
      fs.unlinkSync = realUnlink;
      syncBuiltinESMExports();
    }
    assert.equal(deleted, false);
    assert.equal(saved, awaited ? 'saved' : 'debounced');
    await turns(5);
    drainSessionStore();
    forgetSessionLoadCache(f.id);
    const stored = readDurableSessionRecord(f.id);
    assert.equal(stored.title, 'intended', 'the record holds a title nobody submitted');
    assert.deepEqual(
      stored.messages.map((message) => message.content),
      ['saved conversation', 'intended']
    );
  });
}

test('a session file that is not JSON can still be deleted, its bytes kept aside', async (t) => {
  const f = fixture(t);
  f.write('{"broken":');
  assert.equal(loadSession(f.id), null);
  assert.equal(await deleteSession(f.id), true);
  assert.equal(existsSync(f.path), false);
  const [aside] = readdirSync(dirname(f.path)).filter((name) => name.startsWith(`${f.id}.json.corrupt-`));
  assert.equal(readFileSync(join(dirname(f.path), aside), 'utf8'), '{"broken":');
});

test('a failed save keeps its live copy speaking for the session while unrelated corruption remains visible', (t) => {
  const f = fixture(t);
  const failed = { ...f.saved, messages: [{ role: 'assistant', content: 'failed write payload' }] };
  setLiveSession(failed);
  assert.equal(loadSession(f.id), failed);
  // The failed records stay queued and land with the next write: the live
  // copy, later state included, is the newest one.
  _recordSaveFailure(f.id, new Error('simulated save failure'));
  failed.messages = [...failed.messages, { role: 'assistant', content: 'later unsaved state' }];
  f.write('unreadable JSON');
  assert.equal(loadSession(f.id), failed);
  assert.equal(readFileSync(f.path, 'utf8'), 'unreadable JSON');
  clearSessionSaveError(f.id);
  assert.equal(loadSession(f.id), null);
  assert.equal(_liveSessions.get(f.id), failed);
});

test('retained documents stay within the byte budget, and an oversized one keeps only its header', (t) => {
  const f = fixture(t);
  const big = (label, chars) => ({ ...f.saved, messages: [{ role: 'user', content: label + 'x'.repeat(chars) }] });
  // 5M characters: one fits the 8M budget, two do not.
  const first = big('first', 5 * 1024 * 1024);
  f.write(first);
  assert.deepEqual(loadSession(f.id), first);
  assert.ok(sessionLoadCacheStats().chars >= 5 * 1024 * 1024, 'the document is retained');
  const otherId = `${f.id}_other`;
  const second = { ...big('second', 5 * 1024 * 1024), id: otherId };
  writeFileSync(join(f.path, '..', `${otherId}.json`), JSON.stringify(second));
  const entries = sessionLoadCacheStats().entries;
  assert.deepEqual(loadSession(otherId), second);
  assert.ok(sessionLoadCacheStats().chars <= 8 * 1024 * 1024, 'the older document was released');
  assert.ok(sessionLoadCacheStats().chars >= 5 * 1024 * 1024, 'the newer one is retained');
  assert.equal(sessionLoadCacheStats().entries, entries + 1, 'the released one keeps its validation header');
  // That header still serves a live copy without reading the file again.
  const live = { ...first };
  setLiveSession(live);
  assert.equal(loadSession(f.id), live);
  _liveSessions.delete(f.id);
  // Larger than the whole budget: served from disk, never retained.
  const huge = big('huge', 9 * 1024 * 1024);
  f.write(huge);
  assert.deepEqual(loadSession(f.id), huge);
  assert.ok(sessionLoadCacheStats().chars <= 8 * 1024 * 1024);
  assert.deepEqual(loadSession(f.id), huge, 'and re-read, not lost');
});

test('closing, unloading or evicting a session drops its load-cache entry', (t) => {
  const f = fixture(t);
  assert.deepEqual(loadSession(f.id), f.saved);
  const before = sessionLoadCacheStats();
  assert.ok(before.chars > 0);
  forgetSessionLoadCache(f.id);
  const after = sessionLoadCacheStats();
  assert.equal(after.entries, before.entries - 1);
  assert.ok(after.chars < before.chars);
  // The idle sweep evicts the live snapshot and the parsed document with it.
  assert.deepEqual(loadSession(f.id), f.saved);
  setLiveSession(loadSession(f.id));
  const cached = sessionLoadCacheStats().entries;
  assert.equal(evictIdleLiveSessions({ isSessionLive: () => false }) >= 1, true);
  assert.equal(sessionLoadCacheStats().entries, cached - 1);
});

test('a same-size in-place rewrite with a restored mtime is noticed through ctime', async (t) => {
  const f = fixture(t);
  const time = new Date('2025-01-01T00:00:00.000Z');
  const write = (content) => {
    writeFileSync(f.path, JSON.stringify({ ...f.saved, messages: [{ role: 'user', content }] }));
    utimesSync(f.path, time, time);
  };
  write('old!');
  assert.equal(loadSession(f.id).messages[0].content, 'old!');
  await new Promise((resolve) => setTimeout(resolve, 20));
  write('new!');
  assert.equal(loadSession(f.id).messages[0].content, 'new!');
});

test('more than eight live sessions keep their validation headers and are not re-read', (t) => {
  const f = fixture(t);
  const sessions = Array.from({ length: 12 }, (_, index) => ({ ...f.saved, id: `${f.id}_n${index}` }));
  for (const session of sessions) {
    writeFileSync(join(f.path, '..', `${session.id}.json`), JSON.stringify(session));
    t.after(() => _liveSessions.delete(session.id));
  }
  for (const session of sessions) assert.deepEqual(loadSession(session.id), session);
  for (const session of sessions) setLiveSession(session);
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).includes(f.id)) reads++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  for (let round = 0; round < 2; round++) {
    for (const session of sessions) assert.equal(loadSession(session.id), session);
  }
  assert.equal(reads, 0, 'every file is validated by its header without reading it');
  assert.ok(sessionLoadCacheStats().documents <= 8);
});

test('loadSessionStatus reuses a settled file answer and never outranks a rewrite or a live copy', (t) => {
  const f = fixture(t);
  f.write({ ...f.saved, status: 'error' });
  // Past the racy-stamp window, so the answer may be kept under the stamp.
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).includes(f.id)) reads++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    Date.now = realNow;
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  forgetSessionLoadCache(f.id);
  assert.equal(loadSessionStatus(f.id), 'error');
  const first = reads;
  forgetSessionLoadCache(f.id);
  assert.equal(loadSessionStatus(f.id), 'error');
  assert.equal(reads, first, 'an unchanged settled file is not read again');
  f.write({ ...f.saved, status: 'idle' });
  assert.equal(loadSessionStatus(f.id), 'idle');
  setLiveSession({ ...f.saved, status: 'running' });
  assert.equal(loadSessionStatus(f.id), 'running');
  _liveSessions.delete(f.id);
  f.write('{"id":');
  assert.equal(loadSessionStatus(f.id), null, 'an unreadable file speaks for no status');
});

test('a genuinely absent disk record does not discard an unsaved live conversation', (t) => {
  const f = fixture(t);
  const live = { ...f.saved, messages: [{ role: 'user', content: 'not saved yet' }] };
  setLiveSession(live);
  assert.equal(loadSession(f.id), live);
  rmSync(f.path);
  assert.equal(loadSession(f.id), live);
  _liveSessions.delete(f.id);
  assert.equal(loadSession(f.id), null);
});
