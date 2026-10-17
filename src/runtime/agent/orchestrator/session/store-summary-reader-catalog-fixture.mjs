// Shared fixture of the ordinary-catalog tests: a scratch data dir, the
// writers that touch it (index-updating, rename-only, in-place) and a spy on
// the filesystem work the cold reader does.
import assert from 'node:assert/strict';
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { encodeSummaryOps } from './store-summary-log.mjs';
import { listStoredSessionSummaries } from './store-summary-reader.mjs';

const roots = [];
let root = '';
test.after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Point the reader at a fresh data dir with an empty sessions directory. */
export function isolateDataDir(prefix) {
  root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, 'sessions'));
  process.env.MIXDOG_DATA_DIR = root;
}

export const sessionsDir = () => join(root, 'sessions');
export const fileOf = (id) => join(sessionsDir(), `${id}.json`);
export const indexPath = () => join(root, 'session-summaries.json');
export const logPath = () => join(root, 'session-summaries.log');

const record = (id, text) =>
  JSON.stringify({
    id,
    owner: 'user',
    agent: 'lead',
    closed: false,
    generation: 1,
    updatedAt: 1,
    messages: [{ role: 'user', content: text }],
  });

/** The store's writers replace a record by temp file + rename. */
export function replace(id, text) {
  writeFileSync(`${fileOf(id)}.tmp`, record(id, text));
  renameSync(`${fileOf(id)}.tmp`, fileOf(id));
}

/** A writer outside the store that rewrites the record in place. */
export const rewriteInPlace = (id, text) => writeFileSync(fileOf(id), record(id, text));

/** What the summary index records for the file as it is now; the `indexed:`
 *  title tells an index row from a row parsed from the file. */
export const indexRow = (id, text, fingerprint = statSync(fileOf(id))) => ({
  id,
  owner: 'user',
  agent: 'lead',
  status: 'idle',
  messageCount: 1,
  title: `indexed:${text}`,
  preview: text,
  updatedAt: 1,
  storageMtimeMs: fingerprint.mtimeMs,
  storageSize: fingerprint.size,
});

export function writeBase(rows) {
  writeFileSync(`${indexPath()}.tmp`, JSON.stringify({ version: 2, rows }));
  renameSync(`${indexPath()}.tmp`, indexPath());
}

export const appendLog = (upserts, removals = []) => appendFileSync(logPath(), encodeSummaryOps(upserts, removals));

/** An index-updating writer: the record, then its summary row. */
export function saveIndexed(id, text) {
  replace(id, text);
  appendLog([indexRow(id, text)]);
}

/** A namespace change that touches no session. */
export function touchDirectory() {
  writeFileSync(join(sessionsDir(), 'unrelated.tmp'), '');
  unlinkSync(join(sessionsDir(), 'unrelated.tmp'));
}

export const list = () => listStoredSessionSummaries();
export const view = (rows = list()) => Object.fromEntries(rows.map((row) => [row.id, `${row.title}|${row.preview}`]));

/** The authoritative refresh parses every file, so it agrees with the
 *  ordinary catalog on which sessions exist and what they show, not on
 *  index-only titles. */
export function assertMatchesStorage() {
  const previews = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.preview]));
  assert.deepEqual(previews(list()), previews(listStoredSessionSummaries({ refreshFromStorage: true })));
}

/** A directory stamp younger than the racy window is never trusted; wait it
 *  out so the following calls exercise the stamp-keyed path. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 2_100));

/** Counts the filesystem work the reader does; `failing` paths throw EACCES
 *  on every call, `failingReads` paths on reads only (a stat still works). */
export function spyFs(t, failing = new Set(), failingReads = new Set()) {
  const counts = { stats: 0, sessionFileStats: new Set(), readdirs: 0, reads: 0, asyncStats: 0 };
  const original = {
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
    stat: fsp.stat,
  };
  const denied = (path) => {
    if (!failing.has(String(path))) return;
    throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
  };
  fs.statSync = function (path, ...rest) {
    counts.stats++;
    if (String(path).endsWith('.json') && String(path).startsWith(sessionsDir())) {
      counts.sessionFileStats.add(String(path));
    }
    denied(path);
    return original.statSync.call(this, path, ...rest);
  };
  fs.readdirSync = function (...args) {
    counts.readdirs++;
    return original.readdirSync.apply(this, args);
  };
  fs.readFileSync = function (path, ...rest) {
    counts.reads++;
    denied(path);
    if (failingReads.has(String(path))) throw Object.assign(new Error(`EIO: ${path}`), { code: 'EIO' });
    return original.readFileSync.call(this, path, ...rest);
  };
  fsp.stat = async function (path, ...rest) {
    counts.asyncStats++;
    denied(path);
    return original.stat.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.statSync = original.statSync;
    fs.readdirSync = original.readdirSync;
    fs.readFileSync = original.readFileSync;
    fsp.stat = original.stat;
    syncBuiltinESMExports();
  });
  return counts;
}
