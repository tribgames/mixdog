import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-attachment-census-'));
process.env.MIXDOG_DATA_DIR = dataDir;

// Every census read goes through fs/promises readFile; count them per path.
const readPaths = [];
const realReadFile = fsp.readFile;
fsp.readFile = function countedReadFile(path, ...rest) {
  readPaths.push(String(path));
  return realReadFile.call(this, path, ...rest);
};
syncBuiltinESMExports();

const { collectPromptAttachments } = await import('./store.mjs');

const DAY = 24 * 60 * 60 * 1000;
const MIN_AGE = DAY;
const shaDir = join(dataDir, 'prompt-attachments', 'sha256');
const sessionsDir = join(dataDir, 'sessions');
const checkpointsDir = join(dataDir, 'turn-checkpoints');
const pendingFile = join(dataDir, 'session-pending-messages.json');
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(checkpointsDir, { recursive: true });

const refOf = (name) => createHash('sha256').update(name).digest('hex');
const blobPath = (ref) => join(shaDir, ref.slice(0, 2), ref);

function blob(name, ageMs) {
  const ref = refOf(name);
  mkdirSync(join(shaDir, ref.slice(0, 2)), { recursive: true });
  writeFileSync(blobPath(ref), name);
  const at = new Date(Date.now() - ageMs);
  utimesSync(blobPath(ref), at, at);
  return ref;
}

const blobs = () =>
  fs
    .readdirSync(shaDir)
    .flatMap((prefix) => fs.readdirSync(join(shaDir, prefix)))
    .sort();

// Pre-change census, verbatim minus the unlink: the names it would delete, or
// null when it would bail out as incomplete.
async function oracleWouldDelete(now, minAgeMs) {
  const referenced = new Set();
  const paths = [];
  for (const dir of [sessionsDir, checkpointsDir]) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) paths.push(join(dir, entry.name));
    }
  }
  paths.push(pendingFile);
  for (const path of paths) {
    let raw;
    try {
      raw = fs.readFileSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return null;
    }
    const key = Buffer.from('"attachmentRef"');
    const space = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
    let at = raw.indexOf(key);
    while (at !== -1) {
      let i = at + key.length;
      while (space(raw[i])) i += 1;
      if (raw[i] === 0x3a) {
        i += 1;
        while (space(raw[i])) i += 1;
        if (raw[i] === 0x22 && raw[i + 65] === 0x22) {
          const ref = raw.toString('latin1', i + 1, i + 65);
          if (/^[a-f0-9]{64}$/.test(ref)) referenced.add(ref);
        }
      }
      at = raw.indexOf(key, at + key.length);
    }
  }
  const cutoff = now - minAgeMs;
  return blobs().filter((name) => !referenced.has(name) && statSync(join(shaDir, name.slice(0, 2), name)).mtimeMs <= cutoff);
}

async function censusMatchesOracle() {
  const now = Date.now();
  const before = blobs();
  const expected = await oracleWouldDelete(now, MIN_AGE);
  const result = await collectPromptAttachments({ now, minAgeMs: MIN_AGE });
  const deleted = before.filter((name) => !blobs().includes(name));
  if (expected === null) {
    assert.equal(result.incomplete, true);
    assert.deepEqual(deleted, []);
  } else {
    assert.equal(result.incomplete, undefined);
    assert.deepEqual(deleted, expected);
  }
  return { result, deleted };
}

const sessionJson = (id, refs) =>
  JSON.stringify({ id, messages: refs.map((ref) => ({ content: [{ type: 'file', attachmentRef: ref }] })) });

test('census decisions match the previous implementation as reference files change', async () => {
  const inSession = blob('in-session', 2 * DAY);
  const inCheckpoint = blob('in-checkpoint', 2 * DAY);
  const inPending = blob('in-pending', 2 * DAY);
  const orphan = blob('orphan', 2 * DAY);
  const young = blob('young-orphan', 60_000);
  const nonJson = blob('only-in-txt', 2 * DAY);
  const swapOut = blob('swap-out', 2 * DAY);
  const swapIn = blob('swap-in', 2 * DAY);
  writeFileSync(join(sessionsDir, 'a.json'), sessionJson('a', [inSession]));
  writeFileSync(join(sessionsDir, 'swap.json'), sessionJson('swap', [swapOut, swapIn]));
  writeFileSync(join(sessionsDir, 'notes.txt'), sessionJson('txt', [nonJson]));
  // Pretty-printed JSON: whitespace around the colon still counts.
  writeFileSync(join(checkpointsDir, 'c.json'), JSON.stringify({ parts: [{ attachmentRef: inCheckpoint }] }, null, 2));
  writeFileSync(pendingFile, JSON.stringify({ queue: [{ attachmentRef: inPending }] }));

  let run = await censusMatchesOracle();
  assert.deepEqual(run.deleted, [nonJson, orphan].sort());
  assert.ok(blobs().includes(young), 'blobs younger than the minimum age survive');

  // Same size and restored mtime: only dev/ino/ctime can reveal the change.
  const swapPath = join(sessionsDir, 'swap.json');
  const { mtime } = statSync(swapPath);
  writeFileSync(swapPath, sessionJson('swap', [swapIn, swapIn]));
  utimesSync(swapPath, mtime, mtime);
  // A new session starts referencing a blob; another drops its reference.
  const adopted = blob('adopted', 2 * DAY);
  writeFileSync(join(sessionsDir, 'b.json'), sessionJson('b', [adopted]));
  writeFileSync(join(checkpointsDir, 'c.json'), '{}');
  run = await censusMatchesOracle();
  assert.deepEqual(run.deleted, [inCheckpoint, swapOut].sort());
  assert.ok(blobs().includes(adopted));

  // An unreadable reference file deletes nothing, cached or not.
  const dropped = blob('dropped', 2 * DAY);
  rmSync(pendingFile);
  mkdirSync(pendingFile);
  run = await censusMatchesOracle();
  assert.equal(run.result.incomplete, true);
  assert.ok(blobs().includes(dropped) && blobs().includes(inPending));
  rmSync(pendingFile, { recursive: true });

  // Removed files stop protecting their blobs.
  rmSync(join(sessionsDir, 'a.json'));
  run = await censusMatchesOracle();
  assert.deepEqual(run.deleted, [dropped, inPending, inSession].sort());
});

test('unchanged reference files are not re-read, in this or a fresh process', async () => {
  const kept = blob('kept', 2 * DAY);
  writeFileSync(join(sessionsDir, 'k.json'), sessionJson('k', [kept]));
  await censusMatchesOracle();

  readPaths.length = 0;
  await censusMatchesOracle();
  const referenceReads = () =>
    readPaths.filter((path) => path.startsWith(sessionsDir) || path.startsWith(checkpointsDir) || path === pendingFile);
  // The oracle reads with readFileSync, so any census read shows up here.
  assert.deepEqual(referenceReads(), []);

  // A fresh module instance (another process) uses the persisted cache.
  const fresh = await import(`./store.mjs?census=${Date.now()}`);
  readPaths.length = 0;
  await fresh.collectPromptAttachments({ now: Date.now(), minAgeMs: MIN_AGE });
  assert.deepEqual(referenceReads(), []);
  assert.ok(blobs().includes(kept));

  // One changed file is the only one read again.
  writeFileSync(join(sessionsDir, 'k.json'), sessionJson('k2', [kept]));
  readPaths.length = 0;
  await censusMatchesOracle();
  assert.deepEqual(referenceReads(), [join(sessionsDir, 'k.json')]);
});

test('an unusable persisted cache only costs a full re-read', async () => {
  writeFileSync(join(dataDir, 'prompt-attachments', 'gc-reference-cache.json'), '{not json');
  const fresh = await import(`./store.mjs?corrupt=${Date.now()}`);
  const orphan = blob('late-orphan', 2 * DAY);
  const before = blobs();
  const expected = await oracleWouldDelete(Date.now(), MIN_AGE);
  readPaths.length = 0;
  const result = await fresh.collectPromptAttachments({ now: Date.now(), minAgeMs: MIN_AGE });
  assert.equal(result.incomplete, undefined);
  assert.deepEqual(
    before.filter((name) => !blobs().includes(name)),
    expected
  );
  assert.deepEqual(expected, [orphan]);
  assert.ok(readPaths.some((path) => path.startsWith(sessionsDir)));
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
