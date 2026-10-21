import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readProjectPreferences, writeProjectPreferences } from './project-preferences-file.ts';

const FILE = 'desktop-projects.json';
const empty = { version: 2, aliases: {}, hidden: [] };

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-project-prefs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const asideNames = (root) => readdirSync(root).filter((name) => name.startsWith(`${FILE}.corrupt-`));

test('a missing file starts empty', async (t) => {
  assert.deepEqual(await readProjectPreferences(tempRoot(t)), empty);
});

test('a NUL-filled file starts empty, is kept aside, and the next save lands', async (t) => {
  const root = tempRoot(t);
  writeFileSync(join(root, FILE), Buffer.alloc(300));
  assert.deepEqual(await readProjectPreferences(root), empty);
  const [aside] = asideNames(root);
  assert.deepEqual(readFileSync(join(root, aside)), Buffer.alloc(300));
  const saved = { version: 2, aliases: { '/p': 'P' }, hidden: ['/h'] };
  await writeProjectPreferences(root, saved);
  assert.deepEqual(await readProjectPreferences(root), saved);
});

test('truncated JSON and a non-object root are damage, not an error', async (t) => {
  for (const content of ['{"version":2,"aliases":{"/p":', 'null', '[]']) {
    const root = tempRoot(t);
    writeFileSync(join(root, FILE), content);
    assert.deepEqual(await readProjectPreferences(root), empty, content);
    assert.equal(readFileSync(join(root, asideNames(root)[0]), 'utf8'), content);
  }
});

test('a save keeps the replaced version, which a damaged file is restored from', async (t) => {
  const root = tempRoot(t);
  const first = { version: 2, aliases: { '/a': 'A' }, hidden: [] };
  await writeProjectPreferences(root, first);
  await writeProjectPreferences(root, { version: 2, aliases: { '/b': 'B' }, hidden: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(root, `${FILE}.bak`), 'utf8')), first);
  writeFileSync(join(root, FILE), Buffer.alloc(64));
  assert.deepEqual(await readProjectPreferences(root), first);
  assert.deepEqual(JSON.parse(readFileSync(join(root, FILE), 'utf8')), first, 'the restored copy is the file again');
  assert.equal(
    readdirSync(root).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    false
  );
});
