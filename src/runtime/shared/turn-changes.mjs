// Per-turn change records: replay-safe patches, their public reply shape and
// the `git apply` that undoes (reverse) or reapplies (forward) them.
//
// A record is frozen when a turn seals (turn-snapshot.mjs) and persisted by
// turn-snapshot-store.mjs. Every file carries its own complete patch, separate
// from the bounded display patch the review bar renders, so a historical turn
// stays undoable after later turns, cache eviction or a runtime restart.
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { applyPatch, parsePatch, reversePatch, structuredPatch } from 'diff';
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
    const text = utf8Decoder.decode(content);
    // A NUL byte marks binary content: it gets no text diff.
    return text.includes('\0') ? null : text;
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

// ── Session review: net recorded changes ────────────────────────────────────

export const NET_TEXT_MAX_BYTES = 1024 * 1024;
/** Budget of the merged session patch, in UTF-8 bytes. */
export const MERGED_PATCH_MAX_BYTES = 2 * 1024 * 1024;
const VIEW_PATCH_MAX_BYTES = 256 * 1024;

/** A git-format patch of exact before/after text under the names a viewer
 *  shows (absolute for a file outside the worktree). `before`/`after` are
 *  Buffers or null (absent). */
export function namedChangePatch({ before, after, oldName, newName, maxBytes = VIEW_PATCH_MAX_BYTES }) {
  const renamed = oldName !== newName;
  const measured = trackedChangeFile({
    oldPath: renamed ? 'mx-old-file' : 'mx-file',
    newPath: renamed ? 'mx-new-file' : 'mx-file',
    before,
    after,
  });
  const text = measured.patch ? measured.patch.toString('utf8') : '';
  const split = text.search(/\n@@ /);
  const head = (split >= 0 ? text.slice(0, split) : text)
    .split('mx-old-file')
    .join(oldName)
    .split('mx-new-file')
    .join(newName)
    .split('mx-file')
    .join(newName);
  const patch = head + (split >= 0 ? text.slice(split) : '');
  return {
    status: measured.status,
    additions: measured.additions,
    deletions: measured.deletions,
    ...(measured.binary ? { binary: true } : {}),
    patch: Buffer.byteLength(patch, 'utf8') > maxBytes ? '' : patch,
  };
}

const slashPath = (value) => clean(value).replace(/\\/g, '/');
const isOutsidePath = (path) => isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
const absoluteKey = (root, path) => changePathKey(isOutsidePath(path) ? resolve(path) : resolve(root, path));
const patchOf = (file) =>
  changePatchBuffer(file)?.toString('utf8') || (typeof file?.viewPatch === 'string' ? file.viewPatch : '');

const insideDirectory = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel.split(/[\\/]+/)[0] !== '..');
};

/** At most NET_TEXT_MAX_BYTES of a regular file, read through one handle:
 *  undefined when it is larger (checked by size first, never read whole). */
async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > NET_TEXT_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(NET_TEXT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > NET_TEXT_MAX_BYTES ? undefined : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The file's current text: a string, null when absent, undefined when it
 *  cannot be netted (unreadable, binary, large, or reached through a link).
 *  An in-root file is followed only while it stays inside the recorded root;
 *  an outside file is read only at its exact recorded path, never through a
 *  link. */
export async function currentText(root, path) {
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
    const bytes = await readBounded(file);
    return bytes === undefined ? undefined : (decodeText(bytes) ?? undefined);
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : undefined;
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
 *  file with its counts and display patch, or the file unchanged. */
export async function measureLegacyChangeFile(file, root) {
  if (!isUnmeasuredFile(file)) return file;
  const text = await currentText(root, file.path);
  if (typeof text !== 'string' || !text) return file;
  const name = slashPath(file.path);
  const named = namedChangePatch({ before: null, after: Buffer.from(text, 'utf8'), oldName: name, newName: name });
  if (!named.patch) return file;
  return { ...file, additions: named.additions, deletions: named.deletions, viewPatch: named.patch };
}

/** The text a chain's file had before its first recorded turn, rebuilt by
 *  reverse-applying the recorded per-turn patches, newest first, onto the
 *  file as it is now (`current`: string, or null when absent). null = the file
 *  did not exist; undefined = a patch is missing or no longer matches, so the
 *  chain cannot be netted exactly. Nothing about the before-state is stored. */
function originalText(entries, current) {
  let text = current;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const { file } = entries[index];
    const patch = patchOf(file);
    if (!patch || file.binary === true) return undefined;
    let sections;
    try {
      sections = parsePatch(patch);
    } catch {
      return undefined;
    }
    if (sections.length !== 1) return undefined;
    const [section] = sections;
    if (file.status === 'D') {
      if (text !== null) return undefined;
      text = '';
    } else if (text === null) {
      return undefined;
    }
    if (section.hunks.length) {
      const result = applyPatch(text, reversePatch(section));
      if (result === false) return undefined;
      text = result;
    }
    if (file.status === 'A') {
      if (text !== '') return undefined;
      text = null;
    }
  }
  return text;
}

/** A recorded patch re-headed with the names the merged review shows, so a
 *  disambiguated file keeps one identity in its list row and its diff. */
function retargetPatch(patch, { status, oldName, newName }) {
  const split = patch.search(/\n@@ /);
  const head = split >= 0 ? patch.slice(0, split) : patch;
  const tail = split >= 0 ? patch.slice(split) : '';
  const from = status === 'R' ? oldName : newName;
  const tab = (name) => (name.includes(' ') ? '\t' : '');
  const lines = head.split('\n').map((line) => {
    if (line.startsWith('diff --git ')) return `diff --git a/${from} b/${newName}`;
    if (line.startsWith('--- ') && !line.startsWith('--- /dev/null')) return `--- a/${from}${tab(from)}`;
    if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) return `+++ b/${newName}${tab(newName)}`;
    if (line.startsWith('rename from ')) return `rename from ${from}`;
    if (line.startsWith('rename to ')) return `rename to ${newName}`;
    return line;
  });
  return lines.join('\n') + tail;
}

/** One path's turns, oldest first, as a single net change; null when the
 *  session left the file as it found it. The original is rebuilt from the
 *  recorded patches (see originalText) and compared with the disk, so undo,
 *  create→delete and renames fall out; when that fails the turns are merged
 *  per turn. `show` names a file for display. */
async function netChain(chain, show) {
  const first = chain.entries[0];
  const last = chain.entries.at(-1);
  const path = show(last.root, last.file.path);
  const firstRel = first.file.oldPath || first.file.path;
  const oldName = absoluteKey(first.root, firstRel) === chain.key ? path : show(first.root, firstRel);
  const identity = {
    id: slashPath(isOutsidePath(last.file.path) ? resolve(last.file.path) : resolve(last.root, last.file.path)),
    outside: isOutsidePath(last.file.path),
  };
  const after = await currentText(last.root, last.file.path);
  if (after !== undefined) {
    const before = originalText(chain.entries, after);
    if (before !== undefined) {
      if (before === after && oldName === path) return null;
      const net = namedChangePatch({
        before: before === null ? null : Buffer.from(before, 'utf8'),
        after: after === null ? null : Buffer.from(after, 'utf8'),
        oldName,
        newName: path,
        maxBytes: MERGED_PATCH_MAX_BYTES,
      });
      const omitted = !net.patch && net.additions + net.deletions > 0;
      return {
        path,
        ...identity,
        ...(oldName !== path ? { oldPath: oldName } : {}),
        ...net,
        ...(omitted ? { patchOmitted: true } : {}),
      };
    }
  }
  if (first.file.status === 'A' && last.file.status === 'D') return null;
  const files = await Promise.all(chain.entries.map((entry) => measureLegacyChangeFile(entry.file, entry.root)));
  const patches = files
    .map((file) => {
      const patch = patchOf(file);
      return patch ? retargetPatch(patch, { status: file.status, oldName, newName: path }) : '';
    })
    .filter(Boolean);
  const additions = files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
  const deletions = files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
  const binary = files.some((file) => file.binary === true);
  const patch = patches.join('');
  return {
    path,
    ...identity,
    ...(oldName !== path ? { oldPath: oldName } : {}),
    status: first.file.status === 'A' ? 'A' : last.file.status,
    additions,
    deletions,
    ...(binary ? { binary: true } : {}),
    patch,
    // A legacy record that measured nothing: the transcript may know more.
    ...(!patch && additions + deletions === 0 && !binary ? { unmeasured: true, reason: clean(last.file.reason) } : {}),
    ...(!patch && last.file.patchOmitted === true ? { patchOmitted: true } : {}),
  };
}

/** Group the records' files into per-path chains (renames continue a chain).
 *  A chain is keyed by root + path, so two roots' `x.txt` stay two files. */
function recordChains(records, { inRootKinds }) {
  const chains = new Map();
  for (const record of records) {
    const root = clean(record?.root);
    const entries = [
      ...(inRootKinds.has(record?.kind) ? record.files || [] : []),
      ...(Array.isArray(record?.outside) ? record.outside : []),
    ];
    for (const file of entries) {
      if (!file?.path || file.state === 'reverted') continue;
      const key = absoluteKey(root, file.path);
      const from = file.oldPath ? absoluteKey(root, file.oldPath) : key;
      const chain = chains.get(from) || chains.get(key) || { entries: [] };
      chains.delete(chain.key);
      chain.entries.push({ file, root });
      chain.key = key;
      chains.set(key, chain);
    }
  }
  return [...chains.values()];
}

/** Records whose emptiness the session review may vouch for: a baseline that
 *  lists the files itself, or retained records (undo-aware). Without either
 *  the history is absent, never authoritative. */
const knownSources = new Set(['git', 'empty', 'tool']);

/**
 * The session-wide review completed with the turns' recorded changes — the
 * source the transcript's turn-changes cards read — as ONE net change per
 * file, identical before and after a runtime restart. `base.source` says what
 * the baseline review could vouch for:
 *  - `git`: the baseline is authoritative; only edits outside its root are added.
 *  - `empty` / `tool`: no baseline lists files (a non-Git session, or a
 *    session whose tracker holds nothing yet): the `tracked` records and the
 *    running turn (`live`) supply them, never the tracker's single-turn patch.
 *  - `absent` / `unavailable`: no ownership metadata survived; every retained
 *    record supplies the files, and with no record the review is not complete.
 * A file the user undid is never listed; Reapply lists it again. Each listed
 * file carries an `id` (root + path); when two roots would show the same
 * relative name both show their absolute path.
 */
export async function mergeRecordedSessionChanges(base, records, live = null) {
  const source = base?.source || '';
  const gitBacked = source === 'git';
  const cleared = source === 'tool' ? { ...base, files: [], patch: '' } : base;
  const retained = Array.isArray(records) ? records : [];
  const withLive =
    live && !retained.some((record) => record?.checkpointId === live.checkpointId) ? [...retained, live] : retained;
  let inRootKinds = new Set(['tracked']);
  if (gitBacked) inRootKinds = new Set();
  else if (source === 'absent' || source === 'unavailable') inRootKinds = new Set(['git', 'tracked']);
  const baseFiles = Array.isArray(cleared?.files) ? cleared.files : [];
  const basePatch = typeof cleared?.patch === 'string' ? cleared.patch : '';
  const baseRoot = clean(base?.root);
  const known = new Set();
  for (const file of baseFiles) {
    if (file?.path) known.add(absoluteKey(baseRoot, file.path));
    if (file?.oldPath) known.add(absoluteKey(baseRoot, file.oldPath));
  }
  const chains = recordChains(withLive, { inRootKinds }).filter((chain) => !known.has(chain.key));
  // A relative name shared by different roots (or with a baseline file) is
  // shown absolute, so each file stays distinct.
  const owners = new Map();
  const claim = (rel, key) => {
    const name = changePathKey(rel);
    owners.set(name, new Set([...(owners.get(name) || []), key]));
  };
  for (const file of baseFiles) if (file?.path) claim(file.path, absoluteKey(baseRoot, file.path));
  for (const chain of chains) {
    const entry = chain.entries.at(-1);
    claim(entry.file.path, chain.key);
    const origin = chain.entries[0];
    if (origin.file.oldPath) claim(origin.file.oldPath, absoluteKey(origin.root, origin.file.oldPath));
  }
  const show = (root, rel) =>
    isOutsidePath(rel) || (owners.get(changePathKey(rel))?.size || 0) <= 1
      ? slashPath(rel)
      : slashPath(resolve(root, rel));
  const nets = [];
  for (const chain of chains) {
    const net = await netChain(chain, show);
    if (net) nets.push(net);
  }
  const { source: _source, reason: unavailableReason, ...kept } = cleared || {};
  const complete = knownSources.has(source) || withLive.length > 0;
  if (nets.length === 0) {
    // Nothing recorded to add: the baseline answer stands (an unavailable
    // baseline stays unavailable, never an invented empty set).
    if (cleared?.supported === false) return { ...kept, reason: unavailableReason };
    return { ...kept, ...(complete ? { complete: true } : {}) };
  }
  // The merged response stays bounded: past the budget a file is listed
  // without its diff.
  let budget = MERGED_PATCH_MAX_BYTES - Buffer.byteLength(basePatch, 'utf8');
  let truncated = false;
  const files = [];
  const patches = [];
  for (const { patch, ...file } of nets) {
    const size = patch ? Buffer.byteLength(patch, 'utf8') : 0;
    if (patch && size <= budget) {
      budget -= size;
      patches.push(patch);
    } else if (patch) {
      truncated = true;
      files.push({ ...file, patchOmitted: true });
      continue;
    }
    files.push(file);
  }
  return {
    ...kept,
    supported: true,
    authoritative: true,
    complete,
    files: [...baseFiles, ...files],
    patch: [basePatch, ...patches].filter(Boolean).join(basePatch.endsWith('\n') || !basePatch ? '' : '\n'),
    patchTruncated: kept.patchTruncated === true || truncated,
    snapshotKind: cleared?.snapshotKind || 'session',
  };
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
