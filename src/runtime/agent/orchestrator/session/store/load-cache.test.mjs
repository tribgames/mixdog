// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs, {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
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
import { attachmentRefForBuffer } from '../../../../attachments/store.mjs';
import {
  claimSessionWriter,
  releaseSessionWriter,
  sessionWriterHeldHere,
  sessionWriterHeldStrictlyHere,
} from './session-writer-claim.mjs';
import { _sessionLogIoForTest } from './session-log-writer.mjs';
import { abandonRecorder } from './session-writers.mjs';
import { parseSessionLog } from './session-log-reader.mjs';
import { encodePatch } from './session-log-format.mjs';
import { readDurableSessionRecord } from './transcript-durability.mjs';
import { settleSummaryIndexWrites } from '../store-summary-index.mjs';
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
  t.after(async () => {
    _liveSessions.delete(id);
    _clearSessionSaveState(id);
    await removeDataDir(root);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
  });
  return { id, root, path, saved, write };
}

// A save or delete resolves before the summary-index op it queued is written
// (store-summary-index.mjs settleSummaryIndexWrites): that write lands in the
// data dir, so it is awaited before the dir goes, while the dir is still the
// one the write resolves.
async function removeDataDir(root) {
  await settleSummaryIndexWrites();
  rmSync(root, { recursive: true, force: true });
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

test('a removed data dir stays removed: the index writes queued by saves and a delete land before it goes', async (t) => {
  const f = fixture(t);
  assert.equal(await saveSessionAsync({ ...f.saved, messages: [{ role: 'user', content: 'saved' }] }), 'saved');
  const deleting = deleteSession(f.id);
  const during = saveSessionAsync({ ...f.saved, messages: [{ role: 'user', content: 'during the delete' }] });
  assert.deepEqual(await Promise.all([deleting, during]), [true, 'saved']);
  assert.equal(await releaseSessionWriter(f.id), true);
  await removeDataDir(f.root);
  await settleSummaryIndexWrites();
  assert.equal(existsSync(f.root), false, 'a write queued before the removal created the data dir again');
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
  // The batch reaches its fsync after its check of the json, which is off the thread.
  while (resume === null) await turns(1);
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
    if (String(path).includes(f.id))
      throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
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
    if (String(path).includes(f.id))
      throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
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
      if (String(path).includes(f.id))
        throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
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

test('a live session this process is writing is never read back, however often it was written or whether it was read here before', async (t) => {
  const f = fixture(t);
  const session = { id: `${f.id}_live`, generation: 1, closed: false, messages: [{ role: 'user', content: 'x' }], beats: 0 };
  t.after(() => _liveSessions.delete(session.id));
  setLiveSession(session);
  const beat = async (count) => {
    for (let i = 0; i < count; i++) {
      session.beats += 1;
      await saveSessionAsync(session);
    }
  };
  await beat(1);
  let reads = 0;
  const original = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).includes(session.id)) reads++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  assert.equal(loadSession(session.id), session);
  assert.equal(reads, 0, 'never read here before');
  await beat(200);
  assert.equal(loadSession(session.id), session);
  assert.equal(reads, 0, 'two hundred saves since it was last asked about');
  forgetSessionLoadCache(session.id);
  assert.equal(loadSession(session.id), session);
  assert.equal(loadSessionStatus(session.id), session.status ?? null);
  assert.equal(reads, 0, 'its cache entry was dropped');
  assert.equal(await releaseSessionWriter(session.id), true);
});

test('a live session with a batch being written is served from memory by what its recorder knows, without reading its log', async (t) => {
  const f = fixture(t);
  const logPath = join(dirname(f.path), `${f.id}.log.jsonl`);
  const live = loadSession(f.id);
  live.messages = [
    ...live.messages,
    ...Array.from({ length: 200 }, (_, index) => ({ role: 'user', content: `m${index} `.padEnd(4096, 'x') })),
  ];
  assert.equal(await saveSessionAsync(live), 'saved');
  const size = fs.statSync(logPath).size;
  // The bytes read from the log, by any descriptor opened on it or by name.
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, readFileSync: fs.readFileSync };
  const fds = new Set();
  let bytes = 0;
  fs.openSync = function (file, ...rest) {
    const fd = original.openSync.call(this, file, ...rest);
    if (String(file) === logPath) fds.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    fds.delete(fd);
    return original.closeSync.call(this, fd);
  };
  fs.readSync = function (fd, ...rest) {
    const got = original.readSync.call(this, fd, ...rest);
    if (fds.has(fd)) bytes += got;
    return got;
  };
  fs.readFileSync = function (file, ...rest) {
    const got = original.readFileSync.call(this, file, ...rest);
    if (fds.has(file) || String(file) === logPath) bytes += got.length;
    return got;
  };
  syncBuiltinESMExports();
  const io = _sessionLogIoForTest();
  const realFsync = io.fsync;
  t.after(() => {
    Object.assign(fs, original);
    syncBuiltinESMExports();
    io.fsync = realFsync;
  });
  const read = [];
  for (const round of [1, 2, 3]) {
    let resume = null;
    io.fsync = (fd, callback) => {
      io.fsync = realFsync;
      resume = () => realFsync(fd, callback);
    };
    live.messages = [...live.messages, { role: 'user', content: `in flight ${round}` }];
    const saving = saveSessionAsync(live);
    // The batch is in the file and its fsync pending: the log is not in a state its recorder acknowledged.
    while (resume === null) await turns(1);
    bytes = 0;
    assert.equal(loadSession(f.id), live);
    read.push(bytes);
    resume();
    assert.equal(await saving, 'saved');
  }
  // The first load decides whether the log or the json beside it speaks, by a
  // read. From then on the recorder knows what the log holds, a batch being
  // written included: nothing of it is read.
  assert.deepEqual(read.slice(1), [0, 0], `bytes of a ${size}-byte log read to serve the copy held here (first: ${read[0]})`);
  assert.equal(await releaseSessionWriter(f.id), true);
});

for (const claimed of [false, true]) {
  const state = claimed ? 'claim was taken again after its tenure ended' : 'claim is not held here';
  test(`a live copy of a session whose ${state} is decided by a replay of its record, not by a scan that goes on`, async (t) => {
  const f = fixture(t);
  const logPath = join(dirname(f.path), `${f.id}.log.jsonl`);
  const live = loadSession(f.id);
  // The generation's record ends up far from both ends of the log, which are what a scan that goes on checks.
  for (const step of ['before', 'generation', 'after']) {
    if (step === 'generation') live.generation = 2;
    else live.messages = [...live.messages, { role: 'user', content: `${step} `.padEnd(8192, 'x') }];
    assert.equal(await saveSessionAsync(live), 'saved');
  }
  assert.equal(await releaseSessionWriter(f.id), true);
  setLiveSession(live);
  // A header scan leaves its place at the log's end.
  assert.equal(loadSessionStatus(f.id), live.status ?? null);
  // Another process owns the session now and rewrote a record in place, at the same length.
  const bytes = readFileSync(logPath);
  const rewritten = Buffer.from(bytes.toString('utf8').replace('"generation":2', '"generation":7'));
  assert.equal(rewritten.length, bytes.length);
  assert.notDeepEqual(rewritten, bytes);
  const fd = openSync(logPath, 'r+');
  writeSync(fd, rewritten, 0, rewritten.length, 0);
  closeSync(fd);
  // The claim alone vouches for nothing a reader left before it was taken.
  if (claimed) assert.equal(claimSessionWriter(f.id).held, true);
  const loaded = loadSession(f.id);
  assert.notEqual(loaded, live, 'the live copy was served for a record another owner changed');
  assert.equal(loaded.generation, 7);
  if (claimed) assert.equal(await releaseSessionWriter(f.id), true);
  });
}

// The tenure that stored the placeholder: one that recorded it on a log it
// opened and was released, one whose recorder was abandoned, one that created
// the log with the message in it.
for (const tenure of ['released', 'abandoned', 'created the log']) {
  test(`a tenure in which the attachment store refused a part (${tenure}) is not taken up from: the part is stored once the store takes it`, async (t) => {
    const f = fixture(t);
    const bytes = Buffer.from('an image the store is asked to keep');
    const ref = attachmentRefForBuffer(bytes);
    // The store's directory cannot be made: a file has its name.
    const blocked = join(f.root, 'prompt-attachments');
    writeFileSync(blocked, '');
    const created = tenure === 'created the log';
    const live = created ? { id: `${f.id}_new`, generation: 1, closed: false, messages: [] } : loadSession(f.id);
    if (created) {
      setLiveSession(live);
      t.after(() => _liveSessions.delete(live.id));
    }
    const logPath = join(dirname(f.path), `${live.id}.log.jsonl`);
    const image = { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' };
    live.messages = [...live.messages, { role: 'user', content: [image] }];
    assert.equal(await saveSessionAsync(live), 'saved');
    assert.equal(readFileSync(logPath, 'utf8').includes(ref), false);
    if (tenure === 'abandoned') await abandonRecorder(live.id, new Error('a barrier that did not land'));
    else assert.equal(await releaseSessionWriter(live.id), true);
    rmSync(blocked);
    live.messages = [...live.messages, { role: 'user', content: 'after the store came back' }];
    assert.equal(await saveSessionAsync(live), 'saved');
    assert.equal(await releaseSessionWriter(live.id), true);
    assert.equal(readFileSync(logPath, 'utf8').includes(ref), true, 'the part stayed the placeholder it was first stored as');
  });
}

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

for (const reader of ['loadSession', 'loadSessionStatus']) {
  test(`${reader} after this process's own save does not replay the log; after another writer's append it does and returns that change`, async (t) => {
    const f = fixture(t);
    const logPath = join(dirname(f.path), `${f.id}.log.jsonl`);
    // A read of the log: all of it, or a scan of its header (which opens it).
    let reads = 0;
    const original = { readFileSync: fs.readFileSync, openSync: fs.openSync };
    for (const name of Object.keys(original)) {
      fs[name] = function (file, ...rest) {
        if (String(file) === logPath) reads++;
        return original[name].call(this, file, ...rest);
      };
    }
    syncBuiltinESMExports();
    t.after(() => {
      Object.assign(fs, original);
      syncBuiltinESMExports();
    });
    const read = (id) => (reader === 'loadSession' ? loadSession(id) : loadSessionStatus(id));
    const live = loadSession(f.id);
    live.status = 'running';
    live.messages = [...live.messages, { role: 'user', content: 'turn 1' }];
    assert.equal(await saveSessionAsync(live), 'saved');
    // The first load of the new log reads it.
    assert.equal(loadSession(f.id), live);
    // One own save, then two in a row before the next load.
    for (const saves of [1, 2]) {
      for (let i = 0; i < saves; i++) {
        live.messages = [...live.messages, { role: 'assistant', content: `reply ${saves}.${i}` }];
        assert.equal(await saveSessionAsync(live), 'saved');
      }
      const before = reads;
      assert.equal(read(f.id), reader === 'loadSession' ? live : 'running');
      assert.equal(loadSession(f.id), live);
      assert.equal(loadSessionStatus(f.id), 'running');
      assert.equal(reads, before, `the log was read again after ${saves} own save(s)`);
    }
    // Another process took the session over and appended to the same log.
    const { seq } = parseSessionLog(readFileSync(logPath));
    const foreign = { generation: live.generation + 1, status: 'foreign' };
    appendFileSync(
      logPath,
      encodePatch(
        seq + 1,
        Object.entries(foreign).map(([key, value]) => [key, JSON.stringify(value)]),
        []
      )
    );
    const before = reads;
    if (reader === 'loadSession') {
      const loaded = loadSession(f.id);
      assert.notEqual(loaded, live);
      assert.deepEqual({ generation: loaded.generation, status: loaded.status }, foreign);
    } else {
      assert.equal(loadSessionStatus(f.id), 'foreign');
    }
    assert.ok(reads > before, "another writer's append was not read");
    assert.equal(await releaseSessionWriter(f.id), true);
  });
}

test("loadSession replays a log another writer rewrote at the same length while this process's save was being fsynced", async (t) => {
  const f = fixture(t);
  const logPath = join(dirname(f.path), `${f.id}.log.jsonl`);
  const live = loadSession(f.id);
  live.messages = [...live.messages, { role: 'user', content: 'turn 1' }];
  assert.equal(await saveSessionAsync(live), 'saved');
  assert.equal(loadSession(f.id), live);
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
  live.generation = 2;
  const saving = saveSessionAsync(live);
  while (resume === null) await turns(1);
  // The batch is written, its fsync pending: another process puts a valid
  // patch of the same length over it, in a later tick of the file clock.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const bytes = readFileSync(logPath);
  const rewritten = Buffer.from(bytes.toString('utf8').replace('"generation":2', '"generation":9'));
  assert.equal(rewritten.length, bytes.length);
  const fd = openSync(logPath, 'r+');
  writeSync(fd, rewritten, 0, rewritten.length, 0);
  closeSync(fd);
  resume();
  assert.equal(await saving, 'saved');
  const loaded = loadSession(f.id);
  assert.notEqual(loaded, live, 'the stale live copy was served');
  assert.equal(loaded.generation, 9);
  assert.equal(await releaseSessionWriter(f.id), true);
});

test("loadSession replays the log after this process's own save when the real writer claim's file cannot be read", async (t) => {
  const f = fixture(t);
  const logPath = join(dirname(f.path), `${f.id}.log.jsonl`);
  // A replay of the log opens it.
  let reads = 0;
  let unreadable = false;
  const originalOpen = fs.openSync;
  const originalStat = fs.statSync;
  fs.openSync = function (file, ...rest) {
    if (String(file) === logPath) reads++;
    return originalOpen.call(this, file, ...rest);
  };
  fs.statSync = function (file, ...rest) {
    if (unreadable && String(file).endsWith(`${f.id}.lock`)) {
      throw Object.assign(new Error(`EACCES: injected, stat '${file}'`), { code: 'EACCES' });
    }
    return originalStat.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.openSync = originalOpen;
    fs.statSync = originalStat;
    syncBuiltinESMExports();
  });
  const live = loadSession(f.id);
  const save = async (content) => {
    live.messages = [...live.messages, { role: 'user', content }];
    assert.equal(await saveSessionAsync(live), 'saved');
  };
  await save('turn 1');
  assert.equal(loadSession(f.id), live);
  await save('turn 2');
  let before = reads;
  assert.equal(loadSession(f.id), live);
  assert.equal(reads, before, 'the own-save shortcut did not hold with a readable claim');
  await save('turn 3');
  unreadable = true;
  // Everything but the shortcut gives the unreadable claim the benefit of the doubt.
  assert.equal(sessionWriterHeldHere(f.id), true);
  assert.equal(sessionWriterHeldStrictlyHere(f.id), false);
  before = reads;
  assert.equal(loadSession(f.id), live);
  assert.ok(reads > before, 'the log was not replayed under a claim whose file cannot be read');
  unreadable = false;
  assert.equal(sessionWriterHeldStrictlyHere(f.id), true);
  assert.equal(await releaseSessionWriter(f.id), true);
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
