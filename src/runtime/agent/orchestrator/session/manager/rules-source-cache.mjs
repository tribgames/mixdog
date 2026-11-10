import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareCodePoints } from '../../../../shared/code-point-order.mjs';
import { createTreeWatchMemo } from '../../../../shared/tree-watch-memo.mjs';

// A maximum mtime cannot identify a source revision: deletion/rollback can
// lower it, and an unchanged newer file can hide edits to every other source.
// Track each path and its existence independently, without reading warm file
// bodies. Include ctime/size/inode to notice replacements with preserved mtimes.
// A rules directory's records are reused while its recursive watch stays
// quiet (every session open builds several layers over the same trees); a
// plain file (the config) and a missing path are stat'ed on every call.
// A write made through the app calls invalidateRulesSources, so the next
// build is exact; any other edit is seen once its watch event arrives.
const _sourceWalks = createTreeWatchMemo();

export function invalidateRulesSources() {
  _sourceWalks.dropAll();
}

function sourceRevision(paths) {
  const hash = createHash('sha256');
  let readable = true;
  for (const path of paths) {
    const walked = _sourceWalks.get(path, pathRecords, (records) => records.readable);
    hash.update(walked.text);
    if (!walked.readable) readable = false;
  }
  // An unreadable source must not turn a partial build into a warm hit.
  return readable ? hash.digest('hex') : null;
}

function pathRecords(root) {
  let text = '';
  let readable = true;
  const record = (value) => {
    text += `${JSON.stringify(value)}\n`;
  };
  const failed = (path, error) => {
    record([path, error?.code || 'unreadable']);
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') readable = false;
  };
  const walk = (path, depth) => {
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      failed(path, error);
      return;
    }
    const directory = stat.isDirectory();
    record([path, directory, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino]);
    if (!directory || depth <= 0) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      failed(path, error);
      return;
    }
    entries.sort((a, b) => compareCodePoints(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory() || /\.(md|json)$/.test(entry.name)) {
        walk(join(path, entry.name), depth - 1);
      }
    }
  };
  walk(root, 3);
  return { text, readable };
}

export function createRulesSourceCache() {
  let revision;
  const variants = new Map();
  return (paths, key, build) => {
    const nextRevision = sourceRevision(paths);
    if (nextRevision === null || nextRevision !== revision) {
      variants.clear();
      revision = nextRevision;
    }
    if (nextRevision !== null && variants.has(key)) return variants.get(key);
    const value = build();
    if (nextRevision !== null) variants.set(key, value);
    return value;
  };
}
