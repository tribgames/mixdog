import { projectRelativeFilePath } from './markdown-url';
import { parseUnifiedDiff } from './renderer-logic.mjs';

type SessionDiffFile = {
  /** Root + path identity; two roots may show the same relative name. */
  id?: unknown;
  /** The file lies outside the worktree root. */
  outside?: unknown;
  path?: unknown;
  oldPath?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  binary?: unknown;
  /** Why a recorded file has no diff (e.g. it lies outside the worktree). */
  reason?: unknown;
  /** A legacy record that measured nothing: counts may be completed elsewhere. */
  unmeasured?: boolean;
  /** Listed without its patch: with reason PATCH_TOO_LARGE, read on its own. */
  patchOmitted?: unknown;
};

export type SessionDiffResult = {
  supported?: boolean;
  authoritative?: boolean;
  /** The runtime vouches for this as the session's complete net change set:
   *  nothing from the transcript may add or resurrect a file. */
  complete?: boolean;
  patch?: unknown;
  patchTruncated?: boolean;
  /** No file's patch fit the reply: the files and counts are still listed. */
  diffTooLarge?: boolean;
  reason?: unknown;
  files?: SessionDiffFile[];
};

/** The runtime's reason for a file listed without its patch for size. */
export const PATCH_TOO_LARGE = 'too_large';
// Codex's Changes limits. One file past any of these is not drawn ("This file
// is too large to display here." + Open in editor) and, by line count, not read.
const FILE_MAX_LINES = 15_000;
const FILE_MAX_BYTES = 3 * 1024 * 1024;
const LINE_MAX_BYTES = 1024 * 1024;
/** Changed lines past which a file's diff is drawn as plain text. */
const PLAIN_TEXT_LINES = 2_000;
// A set past any of these is "capped": only the selected file's diff is read
// and drawn; every other file lists its header.
const SET_MAX_FILES = 128;
const SET_MAX_LINES = 9_000;
const SET_MAX_BYTES = 12 * 1024 * 1024;

const changedLines = (row: Pick<SessionDiffRow, 'additions' | 'deletions'>) => row.additions + row.deletions;

/** Too many changed lines to read or draw. */
export function sessionDiffRowOverLineLimit(row: Pick<SessionDiffRow, 'additions' | 'deletions'>): boolean {
  return changedLines(row) > FILE_MAX_LINES;
}

/** Drawn without syntax colouring. */
export function sessionDiffRowPlainText(row: Pick<SessionDiffRow, 'additions' | 'deletions'>): boolean {
  return changedLines(row) > PLAIN_TEXT_LINES;
}

/** UTF-8 byte length of `text` (as `TextEncoder` encodes it), without encoding. */
export function utf8ByteLength(text: string, start = 0, end = text.length): number {
  let bytes = end - start;
  for (let index = start; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair: two code units, four bytes.
      bytes += 2;
      index += 1;
    } else bytes += 2;
  }
  return bytes;
}

/** UTF-8 length of `text[start, end)` past `limit`, measured only when the
 *  UTF-16 length cannot decide. */
function utf8Over(text: string, limit: number, start = 0, end = text.length): boolean {
  const units = end - start;
  if (units > limit) return true;
  if (units * 3 <= limit) return false;
  return utf8ByteLength(text, start, end) > limit;
}

/** A patch past the per-file byte limit, or holding one changed line past the
 *  per-line limit. `+++`/`---` are file headers only before a file section's
 *  first `@@`; inside a hunk they are changed lines like any other. */
export function sessionDiffPatchTooLarge(patch: string): boolean {
  if (utf8Over(patch, FILE_MAX_BYTES)) return true;
  if (patch.length * 3 <= LINE_MAX_BYTES) return false;
  let header = true;
  let start = 0;
  while (start < patch.length) {
    let end = patch.indexOf('\n', start);
    if (end < 0) end = patch.length;
    const marker = patch[start];
    if (marker === 'd' && patch.startsWith('diff ', start)) header = true;
    else if (marker === '@' && patch.startsWith('@@', start)) header = false;
    else if ((marker === '+' || marker === '-') && (end - start) * 3 > LINE_MAX_BYTES) {
      const fileHeader = header && (patch.startsWith('+++', start) || patch.startsWith('---', start));
      if (!fileHeader && utf8Over(patch, LINE_MAX_BYTES, start, end)) return true;
    }
    start = end + 1;
  }
  return false;
}

/** A file whose diff is never drawn here. */
export function sessionDiffRowTooLarge(row: SessionDiffRow): boolean {
  return (
    row.patchTooLarge === true ||
    sessionDiffRowOverLineLimit(row) ||
    row.parts.some((part) => sessionDiffPatchTooLarge(part.patch))
  );
}

/** Past the set limits (files, changed lines, or `bytes` of patch text, UTF-8). */
export function sessionDiffSetCapped(rows: readonly SessionDiffRow[], bytes: number): boolean {
  if (rows.length > SET_MAX_FILES) return true;
  let lines = 0;
  for (const row of rows) lines += changedLines(row);
  return lines > SET_MAX_LINES || bytes > SET_MAX_BYTES;
}

/** One file's patch read on its own (a file-patch capability reply).
 *  `tooLarge`: it passes even that read's cap. */
export type SessionDiffFilePatch = { patch: string; tooLarge: boolean };

export function decodeSessionDiffFilePatch(value: unknown): SessionDiffFilePatch {
  const reply = (value ?? null) as { patch?: unknown; patchOmitted?: unknown; reason?: unknown } | null;
  return {
    patch: typeof reply?.patch === 'string' ? reply.patch : '',
    tooLarge: reply?.patchOmitted === true && reply.reason === PATCH_TOO_LARGE,
  };
}

/** Listed without its patch for size: the patch is read on its own. */
export function sessionDiffFileOmitted(file: { patchOmitted?: unknown; reason?: unknown } | null | undefined) {
  return file?.patchOmitted === true && file.reason === PATCH_TOO_LARGE;
}

type SessionDiffPart = ReturnType<typeof parseUnifiedDiff>[number];

export type SessionDiffRow = {
  /** Unique per file (root + path); the key for dedupe and selection. */
  id: string;
  path: string;
  /** Outside the project: recorded by an absolute path. */
  outside: boolean;
  oldPath: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Set only when the file has no diff to show. */
  reason: string;
  unmeasured: boolean;
  parts: SessionDiffPart[];
  /** A Git Changes row whose patch is still being read. */
  patchPending?: boolean;
  /** Listed without its patch for size: its patch is read when it is drawn. */
  patchOmitted?: boolean;
  /** Its patch passes even the one-file read's cap: never drawn. */
  patchTooLarge?: boolean;
  /** Its own patch read failed: Refresh asks again. */
  patchFailed?: boolean;
};

function cleanPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/');
}

/** A path recorded absolute: a file outside the project. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

/** A Git row's repository-root-relative path as the Changes pane opens it:
 *  project-relative when it lies in the project, else absolute. */
export function gitRowOpenPath(root: string, projectPath: string, path: string): string {
  const absolute = `${cleanPath(root).replace(/\/+$/, '')}/${path}`;
  const relative = projectRelativeFilePath(projectPath, absolute);
  return relative && relative !== '.' ? relative : absolute;
}

function partPath(part: SessionDiffPart): string {
  // parseUnifiedDiff already removed the header's a/ b/ prefix, once.
  const next = cleanPath(part.newFile?.fileName);
  if (next && next !== '/dev/null') return next;
  const previous = cleanPath(part.oldFile?.fileName);
  return previous === '/dev/null' ? '' : previous;
}

function sumPartStats(parts: readonly SessionDiffPart[]): { additions: number; deletions: number } {
  return parts.reduce(
    (total, part) => {
      const stats = partStats(part);
      total.additions += stats.additions;
      total.deletions += stats.deletions;
      return total;
    },
    { additions: 0, deletions: 0 }
  );
}

function partStats(part: SessionDiffPart): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of part.hunks.join('\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function parsePatchParts(patch: string): SessionDiffPart[] {
  if (!patch) return [];
  try {
    return parseUnifiedDiff(patch);
  } catch {
    return [];
  }
}

/** The slice of a session review patch that belongs to ONE file (its parts
 *  re-joined as a unified diff), or "" when the patch has no part for it. */
export function sessionDiffFilePatch(patch: string, rel: string): string {
  const target = cleanPath(rel);
  if (!target) return '';
  return parsePatchParts(patch)
    .filter(
      (part) =>
        partPath(part) === target ||
        (cleanPath(part.oldFile?.fileName) === target && cleanPath(part.newFile?.fileName) === '/dev/null')
    )
    .map((part) => part.patch)
    .join('\n');
}

/** A row listed without its patch, completed by that file's own patch text. */
export function sessionDiffRowWithPatch(row: SessionDiffRow, patch: string): SessionDiffRow {
  const parts = parsePatchParts(patch);
  return { ...row, parts, binary: row.binary || parts.some((part) => part.status === 'binary') };
}

export function buildSessionDiffRows(result: SessionDiffResult | null): SessionDiffRow[] {
  const patch = typeof result?.patch === 'string' ? result.patch : '';
  const partsByPath = new Map<string, SessionDiffPart[]>();
  for (const part of parsePatchParts(patch)) {
    const path = partPath(part);
    if (!path) continue;
    const parts = partsByPath.get(path) || [];
    parts.push(part);
    partsByPath.set(path, parts);
  }
  const rows: SessionDiffRow[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    const path = cleanPath(file?.path);
    const id = cleanPath(file?.id) || path;
    if (!path || seen.has(id)) continue;
    seen.add(id);
    const oldPath = cleanPath(file?.oldPath);
    const parts = partsByPath.get(path) || (oldPath ? partsByPath.get(oldPath) : undefined) || [];
    const measured = sumPartStats(parts);
    const omitted = parts.length === 0 && sessionDiffFileOmitted(file);
    rows.push({
      id,
      path,
      outside: typeof file?.outside === 'boolean' ? file.outside : isAbsolutePath(path),
      oldPath,
      status: String(file?.status || parts[0]?.status || 'M').toUpperCase(),
      additions: typeof file?.additions === 'number' ? file.additions : measured.additions,
      deletions: typeof file?.deletions === 'number' ? file.deletions : measured.deletions,
      binary: file?.binary === true || parts.some((part) => part.status === 'binary'),
      reason: parts.length === 0 && !omitted && typeof file?.reason === 'string' ? file.reason : '',
      unmeasured: file?.unmeasured === true,
      parts,
      ...(omitted ? { patchOmitted: true } : {}),
    });
  }
  const listedPaths = new Set(rows.map((row) => row.path));
  for (const [path, parts] of partsByPath) {
    if (listedPaths.has(path)) continue;
    const measured = sumPartStats(parts);
    rows.push({
      id: path,
      path,
      outside: isAbsolutePath(path),
      oldPath: '',
      status: String(parts[0]?.status || 'M').toUpperCase(),
      additions: measured.additions,
      deletions: measured.deletions,
      binary: parts.some((part) => part.status === 'binary'),
      reason: '',
      unmeasured: false,
      parts,
    });
  }
  return rows;
}
