// Per-turn change records: replay-safe patches, their public reply shape and
// the `git apply` that undoes (reverse) or reapplies (forward) them.
//
// A record is frozen when a turn seals (turn-snapshot.mjs) and persisted by
// turn-snapshot-store.mjs. Every file carries its own complete patch, separate
// from the bounded display patch the review bar renders, so a historical turn
// stays undoable after later turns, cache eviction or a runtime restart.
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { cleanString as clean } from './clean.mjs';
import { runGitOffThread } from './git-runner.mjs';

/** Largest single-file patch a record keeps replayable. */
export const TURN_CHANGE_FILE_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const TRACKED_DIFF_TIMEOUT_MS = 2_000;
const STATUSES = new Set(['A', 'M', 'D', 'R']);
// Characters a patch header cannot carry unquoted; such a path is recorded but
// never replayed.
const UNSAFE_PATH_CHARACTERS = /[\t\n\r"\0]/;

export function changePathKey(value) {
  const text = clean(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

/** git status letter → record status (copies create a new file). */
export function normalizeChangeStatus(code) {
  const letter = String(code || 'M').charAt(0);
  if (STATUSES.has(letter)) return letter;
  return letter === 'C' ? 'A' : 'M';
}

/** A root-relative forward-slash path that a patch may name, or ''. */
function safeChangePath(value) {
  const text = clean(value).replace(/\\/g, '/');
  if (!text || text.startsWith('/') || isAbsolute(text) || /^[A-Za-z]:/.test(text)) return '';
  if (UNSAFE_PATH_CHARACTERS.test(text)) return '';
  const parts = text.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return '';
  return text;
}

/** Store form of a patch: UTF-8 text when that round-trips exactly, else base64. */
function encodeChangePatch(buffer) {
  if (!buffer) return { patch: null };
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buffer)) return { patch: text, patchEncoding: 'utf8' };
  return { patch: buffer.toString('base64'), patchEncoding: 'base64' };
}

function changePatchBuffer(file) {
  if (typeof file?.patch !== 'string') return null;
  return file.patchEncoding === 'base64' ? Buffer.from(file.patch, 'base64') : Buffer.from(file.patch, 'utf8');
}

// ── Patch sections ──────────────────────────────────────────────────────────

/** Decode one git C-quoted path ("a/\303\244.txt"); unquoted text passes through. */
function unquoteGitPath(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  const chars = Array.from(text.slice(1));
  const escapes = { n: 10, t: 9, a: 7, b: 8, f: 12, r: 13, v: 11, '\\': 92, '"': 34 };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '"') break;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = chars[++index] ?? '';
    if (/^[0-7]$/.test(next)) {
      bytes.push(Number.parseInt(chars.slice(index, index + 3).join(''), 8) & 0xff);
      index += 2;
      continue;
    }
    bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `---`/`+++` operand → path without its a/ or b/ prefix, or null for /dev/null. */
function headerName(raw, prefix) {
  const value = raw.replace(/\t$/, '');
  if (value === '/dev/null') return null;
  const name = unquoteGitPath(value);
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The two operands of `diff --git a/X b/Y` when they can be told apart. */
function diffGitLinePaths(line) {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") (.*)$/.exec(rest);
    if (!match) return null;
    return [headerName(match[1], 'a/'), headerName(match[2], 'b/')];
  }
  if ((rest.length - 5) % 2 !== 0) return null;
  const length = (rest.length - 5) / 2;
  const left = rest.slice(0, length + 2);
  const right = rest.slice(length + 3);
  if (!left.startsWith('a/') || !right.startsWith('b/') || left.slice(2) !== right.slice(2)) return null;
  return [left.slice(2), right.slice(2)];
}

/** Old/new path of one `diff --git` section (null for the /dev/null side). */
function patchSectionPaths(section) {
  let end = section.length;
  for (const marker of ['\n@@ ', '\nGIT binary patch', '\nBinary files ']) {
    const index = section.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  const lines = section.subarray(0, Math.min(end, 65_536)).toString('utf8').split('\n');
  let oldPath;
  let newPath;
  let created = false;
  let deleted = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('rename from ')) oldPath = unquoteGitPath(line.slice(12));
    else if (line.startsWith('rename to ')) newPath = unquoteGitPath(line.slice(10));
    else if (line.startsWith('new file mode')) created = true;
    else if (line.startsWith('deleted file mode')) deleted = true;
    else if (line.startsWith('--- ')) oldPath ??= headerName(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) newPath ??= headerName(line.slice(4), 'b/');
  }
  if (oldPath === undefined || newPath === undefined) {
    const pair = String(lines[0] || '').startsWith('diff --git ') ? diffGitLinePaths(lines[0]) : null;
    if (pair) {
      oldPath ??= pair[0];
      newPath ??= pair[1];
    }
  }
  return {
    oldPath: created ? null : (oldPath ?? null),
    newPath: deleted ? null : (newPath ?? null),
  };
}

/** Split a multi-file git patch into its `diff --git` sections. A hunk line
 *  always starts with ' ', '+', '-' or '\\' and base85 has no space, so a line
 *  starting `diff --git ` only ever opens a section. */
export function splitPatchSections(buffer) {
  if (!buffer?.length) return [];
  const opener = Buffer.from('diff --git ');
  const separator = Buffer.from('\ndiff --git ');
  const starts = buffer.subarray(0, opener.length).equals(opener) ? [0] : [];
  for (let index = buffer.indexOf(separator); index >= 0; index = buffer.indexOf(separator, index + 1)) {
    starts.push(index + 1);
  }
  return starts.map((start, index) => {
    const patch = buffer.subarray(start, starts[index + 1] ?? buffer.length);
    return { ...patchSectionPaths(patch), patch };
  });
}

// ── Exact tracker (non-Git) patches ─────────────────────────────────────────

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodeText(content) {
  if (content == null) return '';
  try {
    return utf8Decoder.decode(content);
  } catch {
    return null;
  }
}

const headerTab = (path) => (path.includes(' ') ? '\t' : '');

/**
 * One git-format patch from exact before/after bytes (null = absent). Paths
 * are root-relative. Returns the record file without its state.
 */
export function trackedChangeFile({ oldPath, newPath, before, after }) {
  let status = 'M';
  if (before === null) status = 'A';
  else if (after === null) status = 'D';
  else if (oldPath !== newPath) status = 'R';
  const path = status === 'D' ? oldPath : newPath;
  const base = { path, ...(status === 'R' ? { oldPath } : {}), status, additions: 0, deletions: 0 };
  if (!safeChangePath(path) || (status === 'R' && !safeChangePath(oldPath))) {
    return { ...base, revertable: false, reason: 'path cannot be represented in a patch' };
  }
  const oldText = decodeText(before);
  const newText = decodeText(after);
  if (oldText === null || newText === null) {
    return {
      ...base,
      binary: true,
      revertable: false,
      reason: 'binary content was not recorded as a replayable patch',
    };
  }
  let hunks = [];
  if (oldText !== newText) {
    const result = structuredPatch(`a/${oldPath}`, `b/${newPath}`, oldText, newText, '', '', {
      context: 3,
      timeout: TRACKED_DIFF_TIMEOUT_MS,
    });
    if (!result) return { ...base, revertable: false, reason: 'the diff took too long to compute' };
    hunks = result.hunks;
  }
  const oldName = status === 'A' ? newPath : oldPath;
  const newName = status === 'D' ? oldPath : newPath;
  let patch = `diff --git a/${oldName} b/${newName}\n`;
  if (status === 'A') patch += 'new file mode 100644\n';
  if (status === 'D') patch += 'deleted file mode 100644\n';
  if (status === 'R') {
    patch += `${hunks.length ? '' : 'similarity index 100%\n'}rename from ${oldPath}\nrename to ${newPath}\n`;
  }
  let additions = 0;
  let deletions = 0;
  if (hunks.length) {
    patch += `--- ${status === 'A' ? '/dev/null' : `a/${oldName}${headerTab(oldName)}`}\n`;
    patch += `+++ ${status === 'D' ? '/dev/null' : `b/${newName}${headerTab(newName)}`}\n`;
    for (const hunk of hunks) {
      const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
      const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
      patch += `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@\n`;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
        patch += `${line}\n`;
      }
    }
  }
  return { ...base, additions, deletions, revertable: true, patch: Buffer.from(patch, 'utf8') };
}

/** Bound a frozen file's patch and convert it to its stored form. */
export function storedChangeFile(file) {
  const { patch, ...rest } = file;
  if (rest.revertable === false || !patch) {
    return { ...rest, revertable: false, reason: rest.reason || 'no replayable patch was recorded', patch: null };
  }
  if (patch.length > TURN_CHANGE_FILE_PATCH_MAX_BYTES) {
    return {
      ...rest,
      revertable: false,
      reason: 'change is too large to keep for undo',
      patchOmitted: true,
      patch: null,
    };
  }
  return { ...rest, revertable: true, ...encodeChangePatch(patch) };
}

// ── Reply ───────────────────────────────────────────────────────────────────

/** The record file the caller named: its current path first, then a rename's
 *  old path. Absolute paths are taken relative to the recorded root. */
export function findChangeFile(record, value) {
  let target = clean(value).replace(/\\/g, '/');
  if (!target) return null;
  if (isAbsolute(target) && record?.root) target = relative(record.root, resolve(target)).replace(/\\/g, '/');
  const key = changePathKey(target);
  const files = record?.files || [];
  return (
    files.find((file) => changePathKey(file.path) === key) ||
    files.find((file) => file.oldPath && changePathKey(file.oldPath) === key) ||
    null
  );
}

/** Why a file can no longer be undone or reapplied: a state change touched the
 *  worktree but could neither be recorded nor rolled back. */
export const CHANGE_STATE_UNKNOWN_REASON =
  'its undo state could not be recorded, so the file on disk may not match this turn; check it manually';

/** The record file with its worktree state marked unknown. */
export function unknownStateChangeFile(file) {
  return { ...file, revertable: false, reason: CHANGE_STATE_UNKNOWN_REASON };
}

function publicChangeFile(file) {
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    additions: Number(file.additions) || 0,
    deletions: Number(file.deletions) || 0,
    ...(file.binary ? { binary: true } : {}),
    state: file.state === 'reverted' ? 'reverted' : 'applied',
    revertable: file.revertable === true,
    ...(file.revertable !== true && file.reason ? { reason: file.reason } : {}),
    // Its replay/preview patch was dropped for size (per-file ceiling or the
    // session byte budget).
    ...(file.patchOmitted === true ? { patchOmitted: true } : {}),
  };
}

/** Why a whole-turn Undo is unavailable, or ''. */
function undoBlocker(files) {
  const applied = files.filter((file) => file.state !== 'reverted');
  if (applied.length === 0) return 'all changes in this turn are already undone';
  const blocked = applied.find((file) => file.revertable !== true);
  return blocked ? `${blocked.path} cannot be undone: ${blocked.reason || 'no replayable patch was recorded'}` : '';
}

/** The fixed TurnChangesReply contract (see contract-capabilities.ts). */
export function turnChangesReply({ status, checkpointId, record = null, patch = false, file = null }) {
  const files = Array.isArray(record?.files) ? record.files : [];
  const ready = status === 'ready';
  const blocker = undoBlocker(files);
  let reason = '';
  if (files.length > 0) {
    if (status === 'pending') reason = 'the turn is still running';
    else if (blocker) reason = blocker;
  }
  const reply = {
    status,
    checkpointId,
    revision: Number(record?.revision) || 0,
    root: clean(record?.root),
    files: files.map(publicChangeFile),
    canUndo: ready && !blocker,
    canReapply: ready && files.some((entry) => entry.state === 'reverted' && entry.revertable === true),
    ...(reason ? { reason } : {}),
  };
  if (patch === true) {
    let selected = files;
    if (file) {
      const match = findChangeFile(record, file);
      if (!match && files.length > 0) throw new Error(`${file} is not part of this turn's changes`);
      selected = match ? [match] : [];
    }
    reply.patch = selected.map((entry) => changePatchBuffer(entry)?.toString('utf8') || '').join('');
  }
  return reply;
}

// ── Apply ───────────────────────────────────────────────────────────────────

/** Every path a stored patch touches must be exactly the recorded file's. */
function assertPatchMatchesFile(file, buffer) {
  const sections = splitPatchSections(buffer);
  if (sections.length !== 1) throw new Error(`${file.path} has a malformed recorded patch`);
  const { oldPath, newPath } = sections[0];
  const expectedOld = file.status === 'A' ? null : file.oldPath || file.path;
  const expectedNew = file.status === 'D' ? null : file.path;
  for (const [actual, expected] of [
    [oldPath, expectedOld],
    [newPath, expectedNew],
  ]) {
    if (expected === null ? actual !== null : actual !== expected || !safeChangePath(actual)) {
      throw new Error(`${file.path} has a recorded patch for a different path`);
    }
  }
}

/** The recorded root must still be the directory (and, for a Git record, the
 *  repository top level) the patches were taken against. */
async function assertRecordedRoot(record) {
  const root = clean(record?.root);
  if (!root || !isAbsolute(root)) throw new Error('turn changes have no recorded root');
  let info = null;
  try {
    info = await stat(root);
  } catch {
    info = null;
  }
  if (!info?.isDirectory()) throw new Error(`recorded root ${root} is unavailable`);
  if (record.kind !== 'git') return root;
  const result = await runGitOffThread(['rev-parse', '--show-toplevel'], {
    cwd: root,
    timeoutMs: APPLY_TIMEOUT_MS,
    maxBytes: APPLY_OUTPUT_MAX_BYTES,
  });
  const top = clean(result.stdout);
  if (result.code !== 0 || !top || changePathKey(resolve(top)) !== changePathKey(resolve(root))) {
    throw new Error(`recorded root ${root} is no longer the repository top level`);
  }
  return root;
}

/**
 * Apply (forward) or reverse-apply the given record files atomically in the
 * recorded root: git checks every hunk of every file before it writes any, so
 * a conflict leaves the worktree untouched. No --reject, no --unsafe-paths.
 */
export async function applyTurnChangeFiles(record, files, { reverse }) {
  const root = await assertRecordedRoot(record);
  const buffers = files.map((file) => {
    if (!safeChangePath(file.path) || (file.oldPath && !safeChangePath(file.oldPath))) {
      throw new Error(`${file.path} is not a safe recorded path`);
    }
    const buffer = changePatchBuffer(file);
    if (!buffer?.length) throw new Error(`${file.path} has no recorded patch`);
    assertPatchMatchesFile(file, buffer);
    return buffer.at(-1) === 0x0a ? buffer : Buffer.concat([buffer, Buffer.from('\n')]);
  });
  // A Git record replays with the repository's own line-ending conversion
  // (the semantics the shadow snapshot hashed with). An exact tracker patch
  // holds raw bytes, so nothing may convert them.
  const conversion = record.kind === 'git' ? [] : ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
  const args = [
    ...conversion,
    '-c',
    'core.quotepath=false',
    'apply',
    ...(reverse ? ['-R'] : []),
    '--whitespace=nowarn',
    '-',
  ];
  const result = await runGitOffThread(args, {
    cwd: root,
    input: Buffer.concat(buffers),
    timeoutMs: APPLY_TIMEOUT_MS,
    maxBytes: APPLY_OUTPUT_MAX_BYTES,
  });
  if (result.code !== 0) {
    const detail = clean(result.stderr) || clean(result.stdout) || `exit ${result.code}`;
    throw new Error(`${reverse ? 'undo' : 'reapply'} failed; the worktree was not changed: ${detail}`);
  }
  return root;
}
