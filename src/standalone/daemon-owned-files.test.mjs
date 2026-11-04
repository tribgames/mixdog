import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { followOwnedFiles } from './daemon-owned-files.mjs';

async function eventually(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(20);
  return check();
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-owned-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The daemon publishes daemon.json while its baseline is "missing"; a cleanup
// deletes it within the same debounce window. Missing-to-missing used to read
// as no change, and the daemon never re-published.
test('a deletion right after our own publish still reaches the handler', async (t) => {
  const dir = scratch(t);
  const discovery = join(dir, 'daemon.json');
  let changes = 0;
  const owned = followOwnedFiles({ handlers: new Map([[discovery, () => (changes += 1)]]), log: () => {} });
  t.after(() => owned.close());
  writeFileSync(discovery, '{"pid":1}');
  await owned.published(discovery);
  rmSync(discovery);
  assert.ok(await eventually(() => changes > 0), 'the deletion was judged');
});

// Fails without the cache's watch notification: a lost watch was logged to
// stderr under its directory only, and its re-attach not at all.
test('a lost ownership watch is logged by file, and a lock replaced while blind is judged at re-attach', async (t) => {
  const original = fs.watch;
  const opened = [];
  t.mock.method(fs, 'watch', (target, options, listener) => {
    const watcher = original(target, options, listener);
    opened.push({ dir: String(target), watcher, listener });
    return watcher;
  });
  t.mock.method(process.stderr, 'write', () => true);
  const dir = scratch(t);
  const sub = join(dir, 'data');
  mkdirSync(sub);
  const lock = join(sub, 'daemon-owner.lock');
  writeFileSync(lock, '');
  const lockedIno = statSync(lock).ino;
  const lines = [];
  let fenced = 0;
  const owned = followOwnedFiles({
    handlers: new Map([
      [
        lock,
        () => {
          let ino = null;
          try {
            ino = statSync(lock).ino;
          } catch {}
          if (ino !== lockedIno) fenced += 1;
        },
      ],
    ]),
    log: (line) => lines.push(line),
  });
  t.after(() => owned.close());
  opened.find((entry) => entry.dir === sub).watcher.emit('error', new Error('watch lost'));
  assert.ok(
    lines.some((line) => line.includes(lock) && /LOST/.test(line)),
    lines.join('\n')
  );
  rmSync(lock);
  writeFileSync(join(sub, 'other'), 'keeps the new file off the old inode');
  writeFileSync(lock, '');
  assert.notEqual(statSync(lock).ino, lockedIno);
  // The parent's event naming the directory is what re-attaches it.
  opened.find((entry) => entry.dir === dir).listener('rename', 'data');
  assert.ok(await eventually(() => fenced > 0), 'the replaced lock fenced');
  assert.ok(
    lines.some((line) => line.includes(lock) && /re-attached/.test(line)),
    lines.join('\n')
  );
});
