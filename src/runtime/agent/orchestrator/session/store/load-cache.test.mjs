import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evictIdleLiveSessions, loadSession } from '../store.mjs';
import { forgetSessionLoadCache, sessionLoadCacheStats } from './load-cache.mjs';
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

test('failed-save recovery keeps the exact failed snapshot while unrelated corruption remains visible', (t) => {
  const f = fixture(t);
  const failed = { ...f.saved, messages: [{ role: 'assistant', content: 'failed write payload' }] };
  setLiveSession(failed);
  assert.equal(loadSession(f.id), failed);
  _recordSaveFailure(f.id, new Error('simulated save failure'), null, failed);
  failed.messages.push({ role: 'assistant', content: 'later unsaved state' });
  f.write('unreadable JSON');
  assert.deepEqual(loadSession(f.id).messages, [{ role: 'assistant', content: 'failed write payload' }]);
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
