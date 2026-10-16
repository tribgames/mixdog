/**
 * office-write-ledger.mjs — the workspace files one Office Use call wrote,
 * with their exact before/after state, so the session's turn review counts
 * them as its own changes and Undo can restore them.
 *
 * Ownership is never inferred from the folder: every route that writes a
 * workspace file — the session's working copy, a created or converted
 * document, a render's preview and page images, a split/extract/query output,
 * an authored document and its sidecars, a secured PDF — hands the path to
 * noteOfficeWrite BEFORE it writes, which captures the file's prior state.
 * After the call, only noted files whose bytes changed are recorded. Scratch
 * files outside the workspace (the system temp folder, the Office data
 * folder) are never noted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { PATCH_EDIT_BUDGET_BYTES, createSnapshotBudget, reviewFileContent } from '../../shared/bounded-file-read.mjs';

const ledgers = new AsyncLocalStorage();

const pathKey = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

function inside(parent, child) {
  if (!parent) return false;
  const rel = relative(resolve(parent), child);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fileStamp(path) {
  try {
    const info = statSync(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Run one Office call with a ledger its write routes report into. */
export function runWithOfficeWriteLedger({ cwd, dataDir }, task) {
  const ledger = {
    cwd: resolve(cwd || process.cwd()),
    dataDir: dataDir ? resolve(dataDir) : '',
    budget: createSnapshotBudget(PATCH_EDIT_BUDGET_BYTES),
    before: new Map(),
  };
  return { ledger, run: ledgers.run(ledger, task) };
}

/** A write receipt: the call is about to write `path`. The first receipt of a
 *  path captures its state before the write; a call without a ledger (no
 *  session to credit) and scratch paths are ignored. */
export function noteOfficeWrite(path) {
  const ledger = ledgers.getStore();
  const text = typeof path === 'string' ? path.trim() : '';
  if (!ledger || !text) return;
  const fullPath = resolve(ledger.cwd, text);
  const key = pathKey(fullPath);
  if (ledger.before.has(key)) return;
  if (inside(ledger.dataDir, fullPath)) return;
  if (inside(tmpdir(), fullPath) && !inside(ledger.cwd, fullPath)) return;
  let content;
  try {
    content = reviewFileContent(fullPath, { budget: ledger.budget });
  } catch {
    return; // not a regular file: never recorded
  }
  ledger.before.set(key, { fullPath, content, stamp: fileStamp(fullPath) });
}

const sameBytes = (left, right) => Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);

/** Every noted file the call created, changed or removed, as
 *  `{ fullPath, before, after }` (null = absent). */
export function officeWriteChanges(ledger) {
  const changes = [];
  for (const { fullPath, content: before, stamp: priorStamp } of ledger.before.values()) {
    const stamp = fileStamp(fullPath);
    if (!priorStamp && !stamp) continue;
    // Uncaptured bytes compare by their stamp; captured ones byte for byte.
    const untouched = priorStamp && stamp && priorStamp.size === stamp.size && priorStamp.mtimeMs === stamp.mtimeMs;
    if (untouched && !Buffer.isBuffer(before)) continue;
    let after = null;
    try {
      after = stamp ? reviewFileContent(fullPath) : null;
    } catch {
      continue;
    }
    if (sameBytes(before, after)) continue;
    changes.push({ fullPath, before, after });
  }
  return changes;
}
