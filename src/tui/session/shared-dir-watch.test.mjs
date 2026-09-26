import assert from 'node:assert/strict';
import test from 'node:test';
import { watch, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedDirWatch } from './shared-dir-watch.mjs';

function countingWatch() {
  const opened = [];
  const impl = (dir, options, onChange) => {
    const handle = watch(dir, options, onChange);
    opened.push(handle);
    return handle;
  };
  return { impl, opened };
}

const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
};

test('one real fs.watch serves every subscriber of a directory until the last release', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-shared-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { impl, opened } = countingWatch();
  const registry = createSharedDirWatch(impl);
  const seen = Array.from({ length: 32 }, () => []);
  const releases = seen.map((events) => registry.subscribe(dir, (_event, filename) => events.push(String(filename))));
  assert.equal(opened.length, 1);

  writeFileSync(join(dir, 'spool.json'), '{}');
  assert.equal(await waitFor(() => seen.every((events) => events.includes('spool.json'))), true);

  releases[0]();
  releases[0](); // idempotent: must not drop another subscriber's reference
  for (const events of seen) events.length = 0;
  writeFileSync(join(dir, 'spool.json'), '{"a":1}');
  assert.equal(await waitFor(() => seen.slice(1).every((events) => events.includes('spool.json'))), true);
  assert.deepEqual(seen[0], []);
  assert.equal(registry.watchedCount(), 1);

  for (const release of releases.slice(1)) release();
  assert.equal(registry.watchedCount(), 0);
  // A fresh subscribe after the last release opens a new handle.
  const again = registry.subscribe(dir, () => {});
  assert.equal(opened.length, 2);
  again();
});

test('a throwing subscriber does not starve the others; an erroring handle is dropped', () => {
  let onChange = null;
  const handles = [];
  const registry = createSharedDirWatch((_dir, _options, listener) => {
    onChange = listener;
    const handle = {
      closed: false,
      close() {
        handle.closed = true;
      },
      on(event, fn) {
        if (event === 'error') handle.fail = fn;
        return handle;
      },
    };
    handles.push(handle);
    return handle;
  });
  const got = [];
  registry.subscribe('/spool-dir', () => {
    throw new Error('boom');
  });
  const release = registry.subscribe('/spool-dir', (_event, filename) => got.push(filename));
  onChange('change', 'spool.json');
  assert.deepEqual(got, ['spool.json']);

  handles[0].fail(new Error('EPERM'));
  assert.equal(handles[0].closed, true);
  assert.equal(registry.watchedCount(), 0);
  release(); // releasing into a dropped handle is harmless
  registry.subscribe('/spool-dir', () => {});
  assert.equal(handles.length, 2);
});
