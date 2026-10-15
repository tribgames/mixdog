// Per-turn change records: replay-safe patches, their public reply shape and
// the `git apply` that undoes (reverse) or reapplies (forward) them.
//
// A record is frozen when a turn seals (turn-snapshot.mjs) and persisted by
// turn-snapshot-store.mjs. Every file carries its own complete patch, separate
// from the bounded display patch the review bar renders, so a historical turn
// stays undoable after later turns, cache eviction or a runtime restart.
import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { cleanString as clean } from './clean.mjs';
import { runGitOffThread } from './git-runner.mjs';
import { createLineDiffBudget, lineDiffHunks } from './bounded-line-diff.mjs';
import {
  createReviewPatchBudget,
  filePatchReply,
  PATCH_TOO_LARGE,
  patchOmittedFile,
  REVIEW_FILE_PATCH_MAX_BYTES,
  REVIEW_FILE_PATCH_SHOW_MAX_BYTES,
  REVIEW_PATCH_MAX_BYTES,
  reviewDiffTooLarge,
} from './review-diff.mjs';

/** Largest single-file patch a record keeps replayable. */
export const TURN_CHANGE_FILE_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const APPLY_TIMEOUT_MS = 60_000;
const APPLY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
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

// ── Exact tracker patches (the session's own tool bytes) ────────────────────

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Text of one change side (bytes or a string): '' when absent, null for
 *  binary content (not UTF-8, or holding a NUL byte). */
export function decodeText(content) {
  if (content == null) return '';
  try {
    const text = typeof content === 'string' ? content : utf8Decoder.decode(content);
    // A NUL byte marks binary content: it gets no text diff.
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

/** True for bytes that get a binary patch instead of a text diff (not UTF-8,
 *  or holding a NUL byte). */
export function isBinaryChangeContent(content) {
  return content != null && decodeText(content) === null;
}

const headerTab = (path) => (path.includes(' ') ? '\t' : '');

/** The object format (`sha1`/`sha256`) `git apply` hashes blobs with in `root`:
 *  the repository's own, or sha1 outside any repository. */
export async function repositoryObjectFormat(root) {
  const result = await runGitOffThread(['rev-parse', '--show-object-format'], {
    cwd: root,
    timeoutMs: APPLY_TIMEOUT_MS,
    maxBytes: APPLY_OUTPUT_MAX_BYTES,
  }).catch(() => null);
  return result?.code === 0 && clean(result.stdout) === 'sha256' ? 'sha256' : 'sha1';
}

const BASE85 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

/** One line of a git binary hunk: a length letter, then 4-byte groups as base85. */
function base85Line(chunk) {
  let line = String.fromCharCode(chunk.length <= 26 ? 64 + chunk.length : 70 + chunk.length);
  for (let offset = 0; offset < chunk.length; offset += 4) {
    let value = 0;
    for (let index = 0; index < 4; index += 1) value = value * 256 + (chunk[offset + index] ?? 0);
    const group = new Array(5);
    for (let index = 4; index >= 0; index -= 1) {
      group[index] = BASE85[value % 85];
      value = Math.floor(value / 85);
    }
    line += group.join('');
  }
  return line;
}

function binaryLiteral(bytes) {
  const deflated = deflateSync(bytes);
  let text = `literal ${bytes.length}\n`;
  for (let offset = 0; offset < deflated.length; offset += 52) {
    text += `${base85Line(deflated.subarray(offset, offset + 52))}\n`;
  }
  return `${text}\n`;
}

/** The `index` line and `GIT binary patch` body of a byte change. Full blob
 *  ids make `git apply` verify the file still holds the recorded bytes on
 *  either side before it writes, so a binary file changed since is refused. */
function binaryPatchBody(before, after, status, objectFormat) {
  const empty = Buffer.alloc(0);
  const id = (bytes) => createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const zero = '0'.repeat(objectFormat === 'sha256' ? 64 : 40);
  const oldId = before === null ? zero : id(before);
  const newId = after === null ? zero : id(after);
  return `index ${oldId}..${newId}${status === 'M' ? ' 100644' : ''}\nGIT binary patch\n${binaryLiteral(after ?? empty)}${binaryLiteral(before ?? empty)}`;
}

/**
 * One git-format patch from exact before/after bytes (null = absent). Paths
 * are root-relative. Text diffs as hunks within `budget` (see
 * bounded-line-diff.mjs); binary content (isBinaryChangeContent) as a
 * full-index binary patch hashed in `objectFormat`. Returns the record file
 * without its state.
 */
export function trackedChangeFile({
  oldPath,
  newPath,
  before,
  after,
  objectFormat = 'sha1',
  budget = createLineDiffBudget(),
}) {
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
    let patch = `diff --git a/${status === 'A' ? newPath : oldPath} b/${status === 'D' ? oldPath : newPath}\n`;
    if (status === 'A') patch += 'new file mode 100644\n';
    if (status === 'D') patch += 'deleted file mode 100644\n';
    if (status === 'R') patch += `rename from ${oldPath}\nrename to ${newPath}\n`;
    // A pure rename carries the full-index body too: `git apply` then moves
    // the file only while it still holds the recorded bytes.
    patch += binaryPatchBody(before, after, status, objectFormat);
    return { ...base, binary: true, revertable: true, patch: Buffer.from(patch, 'utf8') };
  }
  const { hunks } = lineDiffHunks(oldText, newText, budget, [before, after]);
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

function findOutsideChange(outside, value) {
  const key = changePathKey(value);
  return outside.find((entry) => changePathKey(entry.path) === key) || null;
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
    // The record kept no counts for it: a viewer may complete them.
    ...(isUnmeasuredFile(file) ? { unmeasured: true } : {}),
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
  // Edits outside a Git turn's root are listed beside its files but are
  // view-only: Undo, Reapply and the blocker never see them.
  const outside = Array.isArray(record?.outside) ? record.outside : [];
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
    files: [...files, ...outside.map((entry) => ({ ...entry, revertable: false }))].map(publicChangeFile),
    canUndo: ready && !blocker,
    canReapply: ready && files.some((entry) => entry.state === 'reverted' && entry.revertable === true),
    ...(reason ? { reason } : {}),
  };
  if (patch === true) {
    let selected = [...files, ...outside];
    if (file) {
      const match = findChangeFile(record, file) || findOutsideChange(outside, file);
      if (!match && selected.length > 0) throw new Error(`${file} is not part of this turn's changes`);
      selected = match ? [match] : [];
    }
    reply.patch = selected.map((entry) => patchOf(entry)).join('');
  }
  return reply;
}

// ── Session review: first-seen baselines against the disk ───────────────────

export const NET_TEXT_MAX_BYTES = 1024 * 1024;
/** Budget of the merged session patch, in UTF-8 bytes. */
export const MERGED_PATCH_MAX_BYTES = REVIEW_PATCH_MAX_BYTES;
const VIEW_PATCH_MAX_BYTES = 256 * 1024;

/** Counts and a placeholder-named patch of exact before/after bytes. */
function measureChange(before, after, renamed, budget) {
  const measured = trackedChangeFile({
    oldPath: renamed ? 'mx-old-file' : 'mx-file',
    newPath: renamed ? 'mx-new-file' : 'mx-file',
    before,
    after,
    budget,
  });
  return {
    status: measured.status,
    additions: measured.additions,
    deletions: measured.deletions,
    ...(measured.binary ? { binary: true } : {}),
    text: measured.patch ? measured.patch.toString('utf8') : '',
  };
}

/** A measured patch with its placeholders replaced by the names a viewer shows. */
function nameMeasuredPatch(text, oldName, newName) {
  const split = text.search(/\n@@ /);
  const head = (split >= 0 ? text.slice(0, split) : text)
    .split('mx-old-file')
    .join(oldName)
    .split('mx-new-file')
    .join(newName)
    .split('mx-file')
    .join(newName);
  return head + (split >= 0 ? text.slice(split) : '');
}

/** A git-format patch of exact before/after text under the names a viewer
 *  shows (absolute for a file outside the worktree). `before`/`after` are
 *  Buffers or null (absent); `budget` the operation's line-diff budget. */
export function namedChangePatch({
  before,
  after,
  oldName,
  newName,
  maxBytes = VIEW_PATCH_MAX_BYTES,
  budget = createLineDiffBudget(),
}) {
  const { text, ...measured } = measureChange(before, after, oldName !== newName, budget);
  const patch = nameMeasuredPatch(text, oldName, newName);
  return { ...measured, patch: Buffer.byteLength(patch, 'utf8') > maxBytes ? '' : patch };
}

const slashPath = (value) => clean(value).replace(/\\/g, '/');
const isOutsidePath = (path) => isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
const absolutePath = (root, path) => (isOutsidePath(path) ? resolve(path) : resolve(root, path));
const patchOf = (file) =>
  changePatchBuffer(file)?.toString('utf8') || (typeof file?.viewPatch === 'string' ? file.viewPatch : '');

/** A record file's patch as a review shows it: a binary body becomes the
 *  `Binary files … differ` line a diff viewer renders. */
export function changeDisplayPatch(file) {
  const buffer =
    changePatchBuffer(file) || (typeof file?.viewPatch === 'string' ? Buffer.from(file.viewPatch, 'utf8') : null);
  return splitPatchSections(buffer)
    .map(({ oldPath, newPath, patch }) => {
      const text = patch.toString('utf8');
      const body = text.indexOf('\nGIT binary patch\n');
      if (body < 0) return text;
      const head = text.slice(0, body + 1).replace(/^index .*\n/m, '');
      return `${head}Binary files ${oldPath === null ? '/dev/null' : `a/${oldPath}`} and ${newPath === null ? '/dev/null' : `b/${newPath}`} differ\n`;
    })
    .join('');
}

const insideDirectory = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]+/)[0] !== '..');
};

/** At most `maxBytes` of a regular file, read through one handle: undefined
 *  when it is larger (checked by size first, never read whole). */
async function readBounded(file, maxBytes = NET_TEXT_MAX_BYTES) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    // Sized by the file, one byte over: a file that grew since its stat is
    // not read part-way.
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > info.size ? undefined : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const missingFile = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** The recorded file's absolute path when it may be read: null when absent,
 *  undefined when it is reached through a link. An in-root file is followed
 *  only while it stays inside the recorded root; an outside file is read only
 *  at its exact recorded path, never through a link. */
async function safeCurrentFile(root, path) {
  const outside = isOutsidePath(path);
  const file = outside ? resolve(path) : resolve(root, path);
  try {
    const info = await lstat(file);
    if (outside) {
      if (info.isSymbolicLink() || !info.isFile()) return undefined;
      // A link in any parent directory would also lead elsewhere: the real
      // location must be exactly the recorded path.
      if (changePathKey(await realpath(file)) !== changePathKey(file)) return undefined;
    } else {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!insideDirectory(realRoot, realFile)) return undefined;
    }
    return file;
  } catch (error) {
    return missingFile(error) ? null : undefined;
  }
}

/** The file's current text: a string, null when absent, undefined when it
 *  cannot be netted (unreadable, binary, large, or reached through a link). */
export async function currentText(root, path) {
  const file = await safeCurrentFile(root, path);
  if (!file) return file;
  try {
    const bytes = await readBounded(file);
    return bytes === undefined ? undefined : (decodeText(bytes) ?? undefined);
  } catch (error) {
    return missingFile(error) ? null : undefined;
  }
}

/** A new file whose record kept neither counts nor a diff (an old outside-root
 *  edit): its numbers are unknown, not zero. */
function isUnmeasuredFile(file) {
  return (
    file?.status === 'A' &&
    file.state !== 'reverted' &&
    !file.binary &&
    file.patchOmitted !== true &&
    !patchOf(file) &&
    (Number(file.additions) || 0) + (Number(file.deletions) || 0) === 0
  );
}

/** A legacy record kept no counts or diff for a new file it could not replay
 *  (outside the root): measure the file as it is on disk now. Returns the
 *  file with its counts and display patch, or the file unchanged. `budget`:
 *  the line-diff budget of the read it is part of. */
export async function measureLegacyChangeFile(file, root, budget = createLineDiffBudget()) {
  if (!isUnmeasuredFile(file)) return file;
  const text = await currentText(root, file.path);
  if (typeof text !== 'string' || !text) return file;
  const name = slashPath(file.path);
  const named = namedChangePatch({
    before: null,
    after: Buffer.from(text, 'utf8'),
    oldName: name,
    newName: name,
    budget,
  });
  if (!named.patch) return file;
  return { ...file, additions: named.additions, deletions: named.deletions, viewPatch: named.patch };
}

// Largest current file hashed against a baseline whose bytes were not kept.
const DIGEST_MAX_BYTES = 64 * 1024 * 1024;
// Largest measured patch a review keeps cached between polls.
const CACHED_PATCH_MAX_BYTES = 256 * 1024;
const READ_CONCURRENCY = 16;
const CURRENT_READ_MAX_BYTES = REVIEW_FILE_PATCH_SHOW_MAX_BYTES;
/** A file whose current content is past CURRENT_READ_MAX_BYTES (or cannot be
 *  read whole): listed without a patch, explicitly too large. */
const tooLargeChange = (status) => ({ status, additions: 0, deletions: 0, text: '', patchOmitted: true });
const UNREADABLE_REASON = 'the file cannot be read safely now';
const SEVERAL_TURNS_REASON = 'edited in several turns before its session baseline was recorded';
/** Why a listed file has no exact diff against the session's first state. */
const BASELINE_REASONS = {
  'omitted-binary': "the session's original binary content was not captured",
  'omitted-oversized': "the session's original content was too large to capture",
  evicted: "the session's original content was evicted to bound storage",
  missing: "the session's original state was not recorded",
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** An absolute file under the link rules of currentText: relative to its
 *  recorded root when inside it, else its exact path. */
const fileRef = (root, abs) =>
  root && insideDirectory(root, abs) ? { root, path: relative(root, abs) } : { root: dirname(abs), path: abs };

/** `{ state: 'absent' | 'unsafe' }` or `{ state: 'present', file, size, sig }`. */
async function currentFile({ root, path }) {
  const file = await safeCurrentFile(root, path);
  if (file === null) return { state: 'absent' };
  if (file === undefined) return { state: 'unsafe' };
  try {
    const info = await stat(file);
    if (!info.isFile()) return { state: 'unsafe' };
    return { state: 'present', file, size: info.size, sig: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
  } catch (error) {
    return { state: missingFile(error) ? 'absent' : 'unsafe' };
  }
}

const currentSig = (current) => (current?.state === 'present' ? current.sig : current?.state || '');

/** Bytes of a present file up to CURRENT_READ_MAX_BYTES — what one file's
 *  own patch read may show, so a file past the reply's per-file cap still has
 *  its counts and its patch on request; undefined past it or when it cannot
 *  be read. */
async function currentBytes(current) {
  if (current.size > CURRENT_READ_MAX_BYTES) return undefined;
  try {
    return await readBounded(current.file, CURRENT_READ_MAX_BYTES);
  } catch {
    return undefined;
  }
}

async function fileDigest(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > DIGEST_MAX_BYTES) return undefined;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Whether a present file still holds the baseline's bytes: true, false, or
 *  undefined when that cannot be told. */
async function sameAsBaseline(entry, current, after) {
  if (entry.size > 0 && entry.size !== current.size) return false;
  if (!entry.sha256) return undefined;
  const hash = after ? sha256(after) : await fileDigest(current.file);
  return hash === undefined ? undefined : hash === entry.sha256;
}

/** A row the review cannot measure exactly: it never vouches for the set. */
const partialChange = (status, reason, extra = {}) => ({
  status,
  additions: 0,
  deletions: 0,
  text: '',
  reason,
  partial: true,
  ...extra,
});

const baselineGap = (entry, status) =>
  partialChange(status, BASELINE_REASONS[entry.status] || BASELINE_REASONS.missing, {
    baseline: entry.status,
    ...(entry.status === 'omitted-binary' ? { binary: true } : {}),
  });

/** A file matching the hash of a first state whose bytes were not kept: not
 *  listed, but it does not let the review vouch for the set either. */
const UNVOUCHED_UNCHANGED = Object.freeze({ hidden: true, partial: true });

/** One file (or rename) measured from its first-seen state `entry` to the
 *  disk now (`current`); null when the session left it as it found it,
 *  UNVOUCHED_UNCHANGED when only a hash says so. */
async function measureBaseline(entry, current, renamed, readBlob, budget) {
  const changed = renamed ? 'R' : 'M';
  if (current.state === 'unsafe') {
    return partialChange(entry.state === 'absent' ? 'A' : changed, UNREADABLE_REASON);
  }
  const present = current.state === 'present';
  const after = present ? await currentBytes(current) : null;
  if (entry.state === 'absent') {
    if (!present) return null;
    if (after === undefined) return tooLargeChange('A');
    return measureChange(null, after, false, budget);
  }
  if (present) {
    const same = await sameAsBaseline(entry, current, after);
    const exact = entry.status === 'captured';
    if (same === true && !renamed) return exact ? null : UNVOUCHED_UNCHANGED;
    if (same === true) {
      const moved = measureChange(Buffer.alloc(0), Buffer.alloc(0), true, budget);
      return exact
        ? moved
        : { ...moved, partial: true, baseline: entry.status, reason: BASELINE_REASONS[entry.status] };
    }
    if (same === undefined || !exact) return baselineGap(entry, changed);
  }
  const before = entry.status === 'captured' ? await readBlob(entry) : undefined;
  if (!before)
    return baselineGap(entry.status === 'captured' ? { ...entry, status: 'evicted' } : entry, present ? changed : 'D');
  if (after === undefined) return tooLargeChange(changed);
  return measureChange(before, after, renamed, budget);
}

/** A list measurement as a reply keeps it: text past the per-file inline cap
 *  is dropped at once, its counts kept and the file marked too large. */
function inlineChange(change) {
  if (Buffer.byteLength(change?.text || '', 'utf8') <= REVIEW_FILE_PATCH_MAX_BYTES) return change;
  return { ...change, text: '', patchOmitted: true };
}

/** Every baseline not `covered` by another source, measured against the disk
 *  within the review's line-diff `budget`. A path holding a renamed file pairs
 *  with the path it came from when that one is gone. Measurements are reused
 *  while the files' stats are unchanged. With `target` (an entry predicate)
 *  only the units it matches are measured, with their whole text; every other
 *  unit is returned `nameOnly`, for naming. */
async function baselineChanges(baselines, covered, unvouched, budget, { target = null } = {}) {
  const entries = new Map();
  for (const entry of baselines.files) if (!covered(entry.path)) entries.set(entry.key, entry);
  const list = [...entries.values()];
  const states = await mapLimit(list, READ_CONCURRENCY, (entry) => currentFile(fileRef(entry.root, entry.path)));
  const current = new Map(list.map((entry, index) => [entry.key, states[index]]));
  const paired = new Set();
  const units = [];
  for (const [destinationKey, originKey] of baselines.renames) {
    const destination = entries.get(destinationKey);
    const origin = entries.get(originKey);
    if (!destination || !origin || paired.has(destinationKey) || paired.has(originKey)) continue;
    if (destination.state !== 'absent' || origin.state === 'absent') continue;
    if (current.get(destinationKey).state === 'absent' || current.get(originKey).state !== 'absent') continue;
    paired.add(destinationKey);
    paired.add(originKey);
    units.push({ key: `${originKey}\0${destinationKey}`, before: origin, after: destination });
  }
  for (const entry of list) if (!paired.has(entry.key)) units.push({ key: entry.key, before: entry, after: entry });
  const measured = await mapLimit(units, READ_CONCURRENCY, async (unit) => {
    const renamed = unit.before !== unit.after;
    const named = {
      key: unit.after.key,
      abs: unit.after.path,
      root: unit.after.root,
      ...(renamed ? { oldAbs: unit.before.path, oldRoot: unit.before.root } : {}),
    };
    const now = current.get(unit.after.key);
    const sig = [
      unit.before.state,
      unit.before.status,
      unit.before.sha256 || '',
      unit.before.blob || '',
      unit.before.at,
      unit.after.at,
      currentSig(now),
      currentSig(current.get(unit.before.key)),
    ].join('|');
    const cached = baselines.cache?.get(unit.key);
    if (target && !target(unit.after) && !target(unit.before)) {
      // Not measured: it names a file unless the cache knows it is unchanged.
      const unchanged = cached?.sig === sig && (!cached.change || cached.change.hidden);
      return unchanged ? null : { ...named, nameOnly: true };
    }
    // A file's own patch read measures again what was cached without its text.
    let change = cached?.sig === sig && !(target && cached.stripped) ? cached.change : undefined;
    if (change === undefined) {
      const whole = await measureBaseline(unit.before, now, renamed, baselines.readBlob, budget);
      const inline = inlineChange(whole);
      // Once the budget is spent a diff may have been cut short to the
      // replacement hunk: such a measurement is not kept, a later review
      // measures it again.
      if (budget.remainingMs > 0 && Buffer.byteLength(inline?.text || '', 'utf8') <= CACHED_PATCH_MAX_BYTES) {
        baselines.cache?.set(unit.key, { sig, change: inline, ...(inline !== whole ? { stripped: true } : {}) });
      }
      change = target ? whole : inline;
    }
    if (change?.hidden) unvouched.add(unit.after.key);
    if (!change || change.hidden) return null;
    return { ...named, change };
  });
  return measured.filter(Boolean);
}

/**
 * Files of the retained turn records that no baseline lists — a session (or
 * turns) recorded before baselines existed. Never exact: a file edited in one
 * turn keeps that turn's diff, one edited in several is listed unmeasured.
 * Also returns the baseline keys such older records touched: those baselines
 * were first seen after an unrecorded edit.
 */
async function legacyChanges(records, { kinds, listed, covered, since, budget }) {
  const groups = new Map();
  const late = new Set();
  for (const record of records) {
    const root = clean(record?.root);
    const entries = [
      ...(kinds.has(record?.kind) ? record.files || [] : []),
      ...(Array.isArray(record?.outside) ? record.outside : []),
    ];
    for (const file of entries) {
      if (!file?.path || file.state === 'reverted') continue;
      const abs = absolutePath(root, file.path);
      const key = changePathKey(abs);
      const oldAbs = file.oldPath ? absolutePath(root, file.oldPath) : '';
      if (covered(abs)) continue;
      if (listed.has(key) || (oldAbs && listed.has(changePathKey(oldAbs)))) {
        if (!(Number(record.createdAt) >= since)) late.add(key);
        continue;
      }
      const prior = groups.get(key) || (oldAbs ? groups.get(changePathKey(oldAbs)) : undefined);
      if (prior) groups.delete(prior.key);
      let origin = {};
      if (prior) origin = { oldAbs: prior.oldAbs, oldRoot: prior.oldRoot };
      else if (oldAbs) origin = { oldAbs, oldRoot: root };
      groups.set(key, {
        key,
        abs,
        root,
        file,
        first: prior?.first || file,
        turns: (prior?.turns || 0) + 1,
        ...origin,
      });
    }
  }
  const changes = [];
  for (const group of groups.values()) {
    const { file, first } = group;
    if (group.turns > 1 && first.status === 'A' && file.status === 'D') continue;
    const unit = {
      key: group.key,
      abs: group.abs,
      root: group.root,
      ...(group.oldAbs ? { oldAbs: group.oldAbs, oldRoot: group.oldRoot } : {}),
    };
    if (group.turns > 1) {
      const status = first.status === 'A' ? 'A' : file.status;
      changes.push({
        ...unit,
        change: partialChange(status, SEVERAL_TURNS_REASON, { baseline: 'missing', unmeasured: true }),
      });
      continue;
    }
    const measured = await measureLegacyChangeFile(file, group.root, budget);
    const recordPatch = patchOf(measured);
    const counts = (Number(measured.additions) || 0) + (Number(measured.deletions) || 0);
    changes.push({
      ...unit,
      change: {
        status: file.status,
        additions: Number(measured.additions) || 0,
        deletions: Number(measured.deletions) || 0,
        ...(measured.binary ? { binary: true } : {}),
        text: '',
        recordPatch,
        recordName: slashPath(file.path),
        partial: true,
        baseline: 'missing',
        ...(!recordPatch && counts === 0 && !measured.binary
          ? { unmeasured: true, reason: clean(file.reason) || BASELINE_REASONS.missing }
          : {}),
        ...(!recordPatch && file.patchOmitted === true ? { patchOmitted: true } : {}),
      },
    });
  }
  return { changes, late };
}

/** Files (`{ root, abs }`) the session claims but no baseline or record
 *  lists: the ones still present are listed without a diff. */
async function missingChanges(refs, { listed, covered }) {
  const files = [];
  for (const { root, abs } of refs) {
    const key = changePathKey(abs);
    if (listed.has(key) || covered(abs)) continue;
    listed.add(key);
    files.push({ key, abs, root });
  }
  const states = await mapLimit(files, READ_CONCURRENCY, (file) => currentFile(fileRef(file.root, file.abs)));
  return files.map((file, index) =>
    states[index].state === 'absent'
      ? { ...file, gone: true }
      : { ...file, change: partialChange('M', BASELINE_REASONS.missing, { baseline: 'missing' }) }
  );
}

/**
 * The session-wide review: the Git baseline review (`base`) completed with
 * every file it does not cover — a non-Git root, or a file outside the Git
 * root — measured from its first-seen state in `baselines` (the Lead's and
 * its attributed workers' edits together) against the disk now. `base.source`
 * says what the Git side vouches for (`git`: its root; `empty`: nothing was
 * owned). Retained `records` only list files no baseline knows (a session
 * recorded before baselines existed) and never make the result complete.
 * `complete` is set only when every listed file was measured exactly from a
 * first state the session itself recorded; otherwise the result is `partial`.
 * A file the user undid is back at its first state and is not listed. Each
 * listed file carries an `id` (its absolute path); two roots sharing a
 * relative name both show their absolute path. A file's patch past the
 * per-file cap, or past what the reply's total leaves, is left out
 * (`patchOmitted`, reason PATCH_TOO_LARGE); `diffTooLarge` once nothing fit.
 * `file` (an `id` or listed path) answers that one file's patch instead, up
 * to the file-patch read's cap.
 */
export async function sessionChangeReview(base, { baselines = null, records = [], file: target = '' } = {}) {
  const { source = '', reason: unavailableReason, owned, diffTooLarge: _baseTooLarge, ...kept } = base || {};
  const gitBacked = source === 'git';
  const baseRoot = clean(base?.root);
  const covered = (abs) => gitBacked && Boolean(baseRoot) && insideDirectory(baseRoot, abs);
  const listed = new Set((baselines?.files || []).map((entry) => entry.key));
  let kinds = new Set(['tracked']);
  if (gitBacked) kinds = new Set();
  else if (source === 'absent' || source === 'unavailable') kinds = new Set(['git', 'tracked']);
  // Baselines nothing is listed for, yet whose emptiness cannot be vouched for.
  const unvouched = new Set();
  // One line-diff budget for the whole review pass.
  const diffBudget = createLineDiffBudget();
  // A file's own patch read measures only the baselines of that file (by
  // `id` or by its name under its root).
  const targetKey = clean(target) ? changePathKey(target) : '';
  const targeted = (entry) =>
    changePathKey(entry.path) === targetKey ||
    (Boolean(entry.root) &&
      insideDirectory(entry.root, entry.path) &&
      changePathKey(relative(entry.root, entry.path)) === targetKey);
  const baselineUnits = baselines
    ? await baselineChanges(baselines, covered, unvouched, diffBudget, { target: targetKey ? targeted : null })
    : [];
  // Units named but not measured still claim their names (see `show`).
  const measured = baselineUnits.filter((unit) => !unit.nameOnly);
  const legacy = await legacyChanges(Array.isArray(records) ? records : [], {
    kinds,
    listed,
    covered,
    since: Number(baselines?.createdAt) || Number.POSITIVE_INFINITY,
    budget: diffBudget,
  });
  for (const change of legacy.changes) listed.add(change.key);
  // Owned files of the non-Git root, and paths whose first state a clear in
  // another process removed (the baselines are incomplete for them).
  const refs = (baselines?.missing || []).map((entry) => ({ root: entry.root, abs: entry.path }));
  if (!gitBacked && Array.isArray(owned)) {
    for (const path of owned) refs.push({ root: baseRoot, abs: absolutePath(baseRoot, path) });
  }
  const missing = await missingChanges(refs, { listed, covered });
  for (const change of measured) {
    if (legacy.late.has(change.key)) change.change = { ...change.change, partial: true, reason: SEVERAL_TURNS_REASON };
  }
  const changes = [...measured, ...legacy.changes, ...missing.filter((file) => file.change)];
  const baseFiles = gitBacked && Array.isArray(base.files) ? base.files : [];
  const basePatch = gitBacked && typeof base.patch === 'string' ? base.patch : '';
  // A relative name shared by different roots (or with a Git file) is shown
  // absolute, so each file stays distinct.
  const nameOf = (abs, root) => (root && insideDirectory(root, abs) ? slashPath(relative(root, abs)) : slashPath(abs));
  const owners = new Map();
  const claim = (name, abs) => {
    if (isOutsidePath(name)) return;
    const key = changePathKey(name);
    owners.set(key, new Set([...(owners.get(key) || []), changePathKey(abs)]));
  };
  for (const file of baseFiles) if (file?.path) claim(file.path, resolve(baseRoot, file.path));
  for (const change of [...changes, ...baselineUnits.filter((unit) => unit.nameOnly)]) {
    claim(nameOf(change.abs, change.root), change.abs);
    if (change.oldAbs) claim(nameOf(change.oldAbs, change.oldRoot), change.oldAbs);
  }
  const show = (abs, root) => {
    const name = nameOf(abs, root);
    return isOutsidePath(name) || (owners.get(changePathKey(name))?.size || 0) <= 1 ? name : slashPath(abs);
  };
  const rows = changes
    .map(({ abs, root, oldAbs, oldRoot, change }) => {
      const path = show(abs, root);
      const oldName = oldAbs ? show(oldAbs, oldRoot) : path;
      let patch = '';
      if (change.text) patch = nameMeasuredPatch(change.text, oldName, path);
      else if (change.recordPatch && change.recordName === path) patch = change.recordPatch;
      return {
        path,
        id: slashPath(abs),
        outside: !(root && insideDirectory(root, abs)),
        ...(oldName !== path ? { oldPath: oldName } : {}),
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.binary ? { binary: true } : {}),
        ...(change.reason ? { reason: change.reason } : {}),
        ...(change.baseline ? { baseline: change.baseline } : {}),
        ...(change.unmeasured ? { unmeasured: true } : {}),
        // Its patch is past what can be kept or read: listed too large.
        ...(change.patchOmitted === true && !patch ? { patchOmitted: true, reason: PATCH_TOO_LARGE } : {}),
        patch,
      };
    })
    .sort((left, right) => {
      if (left.path === right.path) return 0;
      return left.path < right.path ? -1 : 1;
    });
  if (clean(target)) {
    const key = changePathKey(target);
    const row = rows.find((entry) => changePathKey(entry.id) === key || changePathKey(entry.path) === key);
    if (row?.patchOmitted === true && !row.patch) return { ...filePatchReply(row.path, ''), ...patchOmittedFile({}) };
    return filePatchReply(row?.path || slashPath(target), row?.patch || '');
  }
  // The merged response stays bounded: a file past the per-file cap or the
  // total left is listed with its counts but without its diff.
  const budget = createReviewPatchBudget(MERGED_PATCH_MAX_BYTES - Buffer.byteLength(basePatch, 'utf8'));
  const files = [];
  const patches = [];
  for (const { patch, ...file } of rows) {
    if (patch && budget.admit(Buffer.byteLength(patch, 'utf8'))) patches.push(patch);
    else if (patch) Object.assign(file, patchOmittedFile(file));
    files.push(file);
  }
  // A baseline first seen after an older recorded edit (`late`) was not the
  // session's first state: even with no row it cannot vouch for the set.
  // Baselines the disk refused (`unsaved`) are known only to this process.
  const partial =
    baselines?.incomplete === true ||
    baselines?.unsaved === true ||
    unvouched.size > 0 ||
    legacy.late.size > 0 ||
    missing.length > 0 ||
    changes.some((change) => change.change.partial === true);
  const vouched = (gitBacked || source === 'empty' || Boolean(baselines)) && !partial;
  const all = [...baseFiles, ...files];
  // An unavailable Git baseline with nothing else to list stays unavailable.
  if (all.length === 0 && !vouched && kept.supported === false) return { ...kept, reason: unavailableReason };
  const patch = [basePatch, ...patches].filter(Boolean).join(basePatch.endsWith('\n') || !basePatch ? '' : '\n');
  return {
    ...kept,
    supported: true,
    // Emptiness is claimed only when it can be vouched for.
    authoritative: all.length > 0 || vouched,
    ...(vouched ? { complete: true } : {}),
    ...(partial ? { partial: true } : {}),
    ...(baselines?.unsaved === true ? { baselinesUnsaved: true } : {}),
    files: all,
    patch,
    patchTruncated: gitBacked && kept.patchTruncated === true,
    ...(reviewDiffTooLarge(all, patch) ? { diffTooLarge: true } : {}),
    snapshotKind: kept.snapshotKind || 'session',
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

/** Every path a stored patch touches must be exactly the recorded file's.
 *  Several sections are the file's own segments in write order: each starts
 *  where the one before ended (a foreign edit in between stays out of both),
 *  from the recorded old path to its current one. Resolves to the sections. */
function assertPatchMatchesFile(file, buffer) {
  const sections = splitPatchSections(buffer);
  if (sections.length === 0) throw new Error(`${file.path} has a malformed recorded patch`);
  const mismatch = () => new Error(`${file.path} has a recorded patch for a different path`);
  if (sections.length > 1) {
    let at = file.oldPath || file.path;
    for (const { oldPath, newPath } of sections) {
      if ([oldPath, newPath].some((path) => path !== null && !safeChangePath(path))) throw mismatch();
      if ((oldPath ?? newPath) !== at) throw mismatch();
      at = newPath ?? oldPath;
    }
    if (at !== file.path) throw mismatch();
    return sections;
  }
  const { oldPath, newPath } = sections[0];
  const expectedOld = file.status === 'A' ? null : file.oldPath || file.path;
  const expectedNew = file.status === 'D' ? null : file.path;
  for (const [actual, expected] of [
    [oldPath, expectedOld],
    [newPath, expectedNew],
  ]) {
    if (expected === null ? actual !== null : actual !== expected || !safeChangePath(actual)) throw mismatch();
  }
  return sections;
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
    const sections = assertPatchMatchesFile(file, buffer);
    // `git apply` takes a file's sections in input order, each on the result
    // of the one before: oldest first forward, newest first for an Undo.
    return Buffer.concat(
      (reverse ? [...sections].reverse() : sections).map(({ patch }) =>
        patch.at(-1) === 0x0a ? patch : Buffer.concat([patch, Buffer.from('\n')])
      )
    );
  });
  // An older Git record (worktree diff) replays with the repository's own
  // line-ending conversion, the semantics the shadow snapshot hashed with. A
  // record of the session's own tool bytes (`counts: 'own'`, any kind) holds
  // raw bytes, so nothing may convert them.
  const rawBytes = record.kind !== 'git' || record.counts === 'own';
  const conversion = rawBytes ? ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'] : [];
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
