import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { watchDirectory } from './directory-watch.mjs';

test('a parent watch lost and later reopened follows its child again: the child is trusted and its replacement heard', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-directory-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ancestor = join(root, 'anc');
  const child = join(ancestor, 'child');
  mkdirSync(child, { recursive: true });
  const opened = [];
  const original = fs.watch;
  t.mock.method(fs, 'watch', (target, ...rest) => {
    const watcher = original(target, ...rest);
    opened.push({ dir: String(target), watcher });
    return watcher;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const heard = [];
  let trusted = 0;
  const subscription = watchDirectory(child, ['record.json'], {
    replace: true,
    onEvent: (event, name) => heard.push([event, name]),
    onTrust: () => trusted++,
  });
  const other = watchDirectory(ancestor, ['.git'], { onEvent: () => {}, onLost: () => {} });
  t.after(() => subscription.close());
  assert.equal(subscription.trusted, true);
  opened.find((entry) => entry.dir === ancestor).watcher.emit('error', new Error('watch lost'));
  assert.equal(subscription.trusted, false, 'a replacement of the child goes unheard meanwhile');
  other.close();
  // Another subscriber watches the ancestor again (it recovered).
  const again = watchDirectory(ancestor, ['.git'], { onEvent: () => {} });
  t.after(() => again.close());
  assert.equal(subscription.trusted, true, 'trusted again');
  assert.equal(trusted, 1);
  assert.deepEqual(heard, [['rename', null]], 'what it may have missed is re-read');
  const childWatches = () => opened.filter((entry) => entry.dir === child).length;
  const before = childWatches();
  heard.length = 0;
  renameSync(child, join(ancestor, 'moved'));
  mkdirSync(child);
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const check = () => {
      if (heard.length > 0 && childWatches() > before) resolve();
      else if (Date.now() > deadline) reject(new Error('the replacement went unheard'));
      else setTimeout(check, 10);
    };
    check();
  });
});

test('a subscription made while recovery ends a vanished child is backed by a live watch, and hears its directory', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-directory-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'parent');
  const child = join(parent, 'child');
  mkdirSync(child, { recursive: true });
  const live = [];
  const original = fs.watch;
  t.mock.method(fs, 'watch', (target, ...rest) => {
    const watcher = original(target, ...rest);
    const entry = { dir: String(target), watcher };
    live.push(entry);
    watcher.once('close', () => live.splice(live.indexOf(entry), 1));
    return watcher;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const childSubscription = watchDirectory(child, ['record.json'], {
    replace: true,
    onEvent: () => {},
    onLost: () => {},
  });
  t.after(() => childSubscription.close());
  live.find((entry) => entry.dir === parent).watcher.emit('error', new Error('watch lost'));
  // The child goes before anything is heard of it; the parent is then watched
  // again, and its recovery finds the child gone.
  rmSync(child, { recursive: true });
  const heard = [];
  const subscription = watchDirectory(parent, ['probe.txt'], { onEvent: (_event, name) => heard.push(name) });
  t.after(() => subscription.close());
  const parentWatches = () => live.filter((entry) => entry.dir === parent).length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscription.trusted, parentWatches() === 1, 'trusted exactly while one live watch backs it');
  assert.equal(parentWatches(), 1, 'the watch it was given stays open');
  writeFileSync(join(parent, 'probe.txt'), 'x');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const check = () => {
      if (heard.includes('probe.txt')) resolve();
      else if (Date.now() > deadline) reject(new Error('the change went unheard'));
      else setTimeout(check, 10);
    };
    check();
  });
});

test('a watched directory deleted under its watch ends it at once instead of reporting itself without pause', {
  skip: process.platform !== 'win32' && 'only Windows reports the watched directory itself',
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-directory-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'goals');
  mkdirSync(dir);
  let raw = 0;
  const original = fs.watch;
  t.mock.method(fs, 'watch', (target, options, listener) =>
    original(target, options, (...args) => {
      raw += 1;
      listener(...args);
    })
  );
  const lost = Promise.withResolvers();
  watchDirectory(dir, ['record.json'], { onEvent: () => {}, onLost: lost.resolve });
  rmSync(dir, { recursive: true });
  const error = await Promise.race([
    lost.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the watch never ended')), 2_000)),
  ]);
  assert.equal(error.code, 'ENOENT');
  const ended = raw;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(raw, ended, 'no event after the watch ended');
});
