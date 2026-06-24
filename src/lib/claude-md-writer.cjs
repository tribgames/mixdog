'use strict';

/**
 * mixdog CLAUDE.md managed-block writer.
 *
 * Manages a single marker-delimited block inside a CLAUDE.md file.
 * Normally only content *between* the markers is touched — anything the
 * user has written outside the block is preserved verbatim. The sole
 * exception is the FIRST takeover of a non-empty, marker-less file: the
 * untouched original is backed up once to
 * <backupRoot>/install-restore/claude-md-original.md (atomically) and the
 * file is then REPLACED with just the managed block. If that backup
 * cannot be written, the writer falls back to appending the block so user
 * content is never destroyed without a confirmed backup.
 *
 * Every write also purges blocks tagged with legacy markers (see
 * LEGACY_MARKERS below) so a plugin rename never leaves stale copies
 * behind. Duplicate current-marker blocks (e.g. authored by hand) are
 * collapsed to the first occurrence on every write.
 *
 * All writes are atomic (temp file + rename) to prevent partial writes
 * from corrupting the target file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER_START = '<!-- BEGIN mixdog managed -->';
const MARKER_END = '<!-- END mixdog managed -->';
const IMPORT_MARKER_START = '<!-- BEGIN mixdog managed import -->';
const IMPORT_MARKER_END = '<!-- END mixdog managed import -->';
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
const RENAME_BACKOFFS_MS = [25, 50, 100, 200, 400, 800, 1200, 1600];

function sleepSync(ms) {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function renameWithRetrySync(src, dst) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RENAME_BACKOFFS_MS.length; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      if (!RENAME_RETRY_CODES.has(err && err.code) || attempt >= RENAME_BACKOFFS_MS.length) break;
      sleepSync(RENAME_BACKOFFS_MS[attempt] + Math.floor(Math.random() * 40));
    }
  }
  throw lastErr;
}

function withFileLockSync(lockPath, fn) {
  const deadline = Date.now() + 3000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (Date.now() <= deadline) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { fs.writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8'); } catch {}
      try { return fn(); }
      finally {
        try { if (fd !== null) fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch (err) {
      try { if (fd !== null) fs.closeSync(fd); } catch {}
      if (err && err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30000) {
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {}
      sleepSync(25 + Math.floor(Math.random() * 35));
    }
  }
  // Lock contention past the deadline: fail closed rather than executing
  // fn() unlocked. Concurrent CLAUDE.md writers without a lock can
  // overwrite each other's updates (last-writer-wins on an unrelated
  // managed-block edit corrupts the file). Stale-lock removal already
  // happens above via the 30s mtime check, so reaching here means a
  // genuinely contested lock held by a live writer.
  throw Object.assign(new Error(`[claude-md-writer] file lock not acquired within 3000ms: ${lockPath}`), { code: 'ELOCKED' });
}

// Marker pairs from previous plugin names. Every write strips any block
// delimited by these so a rename never leaves the old block behind next
// to the new one. Append new entries in lockstep with MARKER_START/END
// whenever the plugin is renamed again.
const LEGACY_MARKERS = Object.freeze([
  Object.freeze({
    start: '<!-- BEGIN trib-plugin managed -->',
    end: '<!-- END trib-plugin managed -->',
  }),
]);

/**
 * Expand a leading `~` to the current user's home directory.
 * Any other path is returned unchanged.
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the mixdog user-data backup root. Mirrors getBackupRoot() in
 * src/shared/user-data-guard.mjs (env override, else ~/.claude/backups/
 * mixdog-user-data) — kept as a tiny local resolver because this is a
 * .cjs module that cannot import the ESM guard.
 */
function userDataBackupRoot() {
  return process.env.MIXDOG_USER_DATA_BACKUP_ROOT
    || path.join(os.homedir(), '.claude', 'backups', 'mixdog-user-data');
}

/**
 * On the FIRST takeover of a user-authored CLAUDE.md (no managed markers
 * yet, real content present) back up the untouched original so it can be
 * restored later. Writes only when the backup does not already exist —
 * the first takeover wins; later marker-less states must never clobber
 * the true original. Returns true when a backup is in place (already
 * existed or freshly written), false when it could not be written (the
 * caller then falls back to append so user content is never destroyed).
 *
 * The backup is written atomically (temp file + rename, same pattern as
 * the target file) so a crashed attempt can never leave a truncated
 * backup. An existing dest is therefore trustworthy going forward and is
 * treated as a completed first takeover.
 */
function ensureOriginalBackup(originalContent) {
  const dest = path.join(userDataBackupRoot(), 'install-restore', 'claude-md-original.md');
  try {
    if (fs.existsSync(dest)) return true;
    _atomicWriteUnlocked(dest, originalContent);
    return true;
  } catch {
    return false;
  }
}

// Inner write helper used when the caller already holds `${filePath}.lock`.
// Splitting this out lets upsertManagedBlock / removeManagedBlock perform
// read+compute+rename under a SINGLE lock (RMW linearisable), mirroring
// the withConfigLock pattern in src/shared/config.mjs. Calling
// atomicWrite() from inside the same lock would deadlock on EEXIST.
function _atomicWriteUnlocked(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    renameWithRetrySync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Build the managed block string from its inner content.
 */
function wrapBlock(content) {
  const body = typeof content === 'string' ? content : '';
  return `${MARKER_START}\n${body}\n${MARKER_END}`;
}

/**
 * Strip every (start, end) block from `text`. Handles duplicates by
 * looping until no more pairs remain. Invalid pairs (end before start,
 * unmatched markers) are left alone.
 */
function stripAllBlocks(text, start, end) {
  let out = text;
  let cursor = 0;
  while (cursor <= out.length) {
    const si = out.indexOf(start, cursor);
    if (si === -1) break;
    const ei = out.indexOf(end, si + start.length);
    if (ei === -1) break;
    // If another start marker appears before the next end marker, the
    // current `si` is an unmatched start and pairing it with `ei` would
    // delete the later valid block too. Leave the orphan in place and
    // continue scanning from the inner start (which may itself pair with
    // `ei`). This honours the contract that unmatched markers are left
    // alone.
    const nextStart = out.indexOf(start, si + start.length);
    if (nextStart !== -1 && nextStart < ei) {
      cursor = nextStart;
      continue;
    }
    out = out.slice(0, si) + out.slice(ei + end.length);
    cursor = si;
  }
  return out;
}

/**
 * Remove any legacy-marker blocks from `text`. No-op when none are
 * present, so it is safe to call on every upsert.
 */
function stripLegacyBlocks(text) {
  let out = text;
  for (const m of LEGACY_MARKERS) {
    out = stripAllBlocks(out, m.start, m.end);
  }
  return out;
}

/**
 * Insert or update the managed block inside `filePath`.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - If the file does not exist, create it containing just the block
 *   - Legacy-marker blocks (see LEGACY_MARKERS) are always purged first
 *     so plugin renames never leave stale copies behind
 *   - The FIRST current-marker block is replaced in place; any extra
 *     duplicates elsewhere in the file are removed
 *   - If no current-marker block exists in a non-empty file (first
 *     takeover of user-authored content), back up the untouched original
 *     to <backupRoot>/install-restore/claude-md-original.md (written once,
 *     first takeover wins) and REPLACE the file with just the block. If
 *     the backup cannot be written, fall back to appending the block so
 *     user content is never destroyed without a confirmed backup.
 *   - An empty / whitespace-only file is simply replaced with the block
 *   - Blank-line runs introduced by the stripping are collapsed and the
 *     file always ends with exactly one trailing newline
 *
 * @param {string} filePath
 * @param {string} content — raw inner content (no markers)
 */
function upsertManagedBlock(filePath, content) {
  const resolved = expandHome(filePath);
  const block = wrapBlock(content);

  // Hold the file lock across the FULL read-modify-write window so a
  // concurrent writer can't slip a different revision in between our
  // read and our rename (last-writer-wins on managed-block edits).
  // Mirrors the withConfigLock RMW pattern in src/shared/config.mjs.
  withFileLockSync(`${resolved}.lock`, () => {
    let existing = null;
    try {
      existing = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }

    if (existing === null) {
      // File does not exist — create with just the block (trailing newline).
      _atomicWriteUnlocked(resolved, block + '\n');
      return;
    }

    // Purge legacy-marker blocks from any earlier plugin name. Only the
    // gap left by legacy removal is normalised — user content outside the
    // managed/legacy markers must be preserved verbatim per the header
    // contract. Whole-file collapse / trailing-ws strip would silently
    // rewrite the user's prose, code blocks, and intentional blank runs.
    const cleaned = stripLegacyBlocks(existing);

    const startIdx = cleaned.indexOf(MARKER_START);
    const endIdx = cleaned.indexOf(MARKER_END, startIdx + MARKER_START.length);

    let next;
    if (startIdx !== -1 && endIdx !== -1) {
      // Replace the first current-marker block in place. Any additional
      // duplicate blocks in the tail are stripped so only one remains.
      const before = cleaned.slice(0, startIdx);
      const afterRaw = cleaned.slice(endIdx + MARKER_END.length);
      const after = stripAllBlocks(afterRaw, MARKER_START, MARKER_END);
      next = before + block + after;
    } else if (cleaned.trim().length === 0) {
      // Empty / whitespace-only file: nothing to preserve, just replace.
      next = block + '\n';
    } else if (ensureOriginalBackup(existing)) {
      // First takeover of user-authored content with a confirmed backup:
      // replace the whole file with just the managed block.
      next = block + '\n';
    } else if (cleaned.endsWith('\n\n')) {
      // Backup could not be written — fall back to append so user content
      // is never destroyed without a confirmed backup.
      next = cleaned + block + '\n';
    } else if (cleaned.endsWith('\n')) {
      next = cleaned + '\n' + block + '\n';
    } else {
      next = cleaned + '\n\n' + block + '\n';
    }

    if (next !== existing) _atomicWriteUnlocked(resolved, next);
  });
}

/**
 * Remove the managed block (markers inclusive) from `filePath`, plus
 * any legacy-marker blocks.
 *
 * Behavior:
 *   - `~` in filePath is expanded via os.homedir()
 *   - No-op if the file does not exist
 *   - Surgical removal: only bytes between/including managed and
 *     legacy markers are touched; user content outside the markers
 *     is preserved verbatim (no blank-line collapse).
 *   - Atomic write
 *
 * @param {string} filePath
 * @returns {boolean} true if an actual write happened, false if no-op
 */
function removeManagedBlock(filePath) {
  const resolved = expandHome(filePath);

  // Preserve the documented missing-file no-op before taking a lock:
  // withFileLockSync creates the lock parent directory, which would be
  // an observable side effect for a target that does not exist.
  try {
    fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  // Single lock around read+compute+rename: a concurrent upsert from
  // another process must not slip between our read and our write, or
  // the removal can race a re-injection and either lose the write or
  // resurrect a stale block. Mirrors upsertManagedBlock's single-lock
  // RMW (and withConfigLock in src/shared/config.mjs).
  return withFileLockSync(`${resolved}.lock`, () => {
    let existing;
    try {
      existing = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }

    // Surgical removal: only bytes between/including the markers are
    // touched. User content outside the managed/legacy markers is
    // preserved verbatim per the header contract — whole-file collapse /
    // trailing-ws strip would silently rewrite the user's prose, code
    // blocks, and intentional blank runs (mirrors upsertManagedBlock's
    // preservation guarantee on the file-existed path).
    let next = existing;
    next = stripAllBlocks(next, MARKER_START, MARKER_END);
    next = stripLegacyBlocks(next);

    if (next !== existing) {
      _atomicWriteUnlocked(resolved, next);
      return true;
    }
    return false;
  });
}

/**
 * Build the import block string — a thin managed block referencing the
 * full rules target file. Uses IMPORT_MARKER_START/END so it can be
 * managed independently from the full rule block in mixdog.md.
 *
 * @param {string} rulesTargetPath — path to the file holding the full rules
 * @returns {string}
 */
function buildImportBlockContent(rulesTargetPath) {
  const ref = rulesTargetPath || '~/.claude/mixdog.md';
  return `${IMPORT_MARKER_START}\nMy managed rules are maintained in [${ref}](${ref}) — refer to that file for the full set of instructions. This block is managed by mixdog; do not edit it or your changes will be overwritten.\n${IMPORT_MARKER_END}`;
}

/**
 * Write (or update) a thin managed import block inside `filePath`
 * (typically ~/.claude/CLAUDE.md) that references the real rules target.
 *
 * The import block uses its own marker pair (IMPORT_MARKER_*), separate
 * from the full rule block markers, so that upsertManagedBlock and
 * removeManagedBlock (which only manage MARKER_START/END) never conflict.
 *
 * @param {string} filePath — CLAUDE.md path where the import block goes
 * @param {string} rulesTargetPath — path to the full rules file (mixdog.md)
 */
function upsertImportBlock(filePath, rulesTargetPath) {
  const resolved = expandHome(filePath);
  const block = buildImportBlockContent(rulesTargetPath);

  withFileLockSync(`${resolved}.lock`, () => {
    let existing = null;
    try {
      existing = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }

    if (existing === null) {
      // File does not exist — create with just the import block.
      _atomicWriteUnlocked(resolved, block + '\n');
      return;
    }

    const next = _replaceOrAppendBlock(existing, IMPORT_MARKER_START, IMPORT_MARKER_END, block);
    if (next !== existing) _atomicWriteUnlocked(resolved, next);
  });
}

/**
 * Remove the import block (IMPORT_MARKER_START/END inclusive) from `filePath`.
 *
 * @param {string} filePath
 * @returns {boolean} true if an actual write happened
 */
function removeImportBlock(filePath) {
  const resolved = expandHome(filePath);
  try {
    fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }

  return withFileLockSync(`${resolved}.lock`, () => {
    let existing;
    try {
      existing = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }

    let next = existing;
    next = stripAllBlocks(next, IMPORT_MARKER_START, IMPORT_MARKER_END);
    if (next !== existing) {
      _atomicWriteUnlocked(resolved, next);
      return true;
    }
    return false;
  });
}

/**
 * Inner helper: replace the first occurrence of a (start,end) block in
 * `text` with `block`, or append `block` if no such block exists.
 * Any additional duplicate blocks in the tail are stripped.
 */
function _replaceOrAppendBlock(text, startMarker, endMarker, block) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = startIdx !== -1 ? text.indexOf(endMarker, startIdx + startMarker.length) : -1;

  if (startIdx !== -1 && endIdx !== -1) {
    const before = text.slice(0, startIdx);
    const afterRaw = text.slice(endIdx + endMarker.length);
    const after = stripAllBlocks(afterRaw, startMarker, endMarker);
    return before + block + after;
  }

  // No existing block — append. Preserve trailing newline semantics.
  if (text.endsWith('\n\n')) {
    return text + block + '\n';
  } else if (text.endsWith('\n')) {
    return text + '\n' + block + '\n';
  } else {
    return text + '\n\n' + block + '\n';
  }
}

module.exports = {
  MARKER_START,
  MARKER_END,
  IMPORT_MARKER_START,
  IMPORT_MARKER_END,
  expandHome,
  upsertManagedBlock,
  removeManagedBlock,
  upsertImportBlock,
  removeImportBlock,
};
