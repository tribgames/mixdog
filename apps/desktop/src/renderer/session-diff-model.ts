import { projectRelativeFilePath } from './markdown-url';
import { hasLeadingDiffContent, parseUnifiedDiff, parseUnifiedDiffSection } from './renderer-logic.mjs';
import { type RowListIndex, rowListIndexBuilder } from './session-diff-row-index';

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

/** Past the set limits (files, changed lines, or `bytes` of patch text, UTF-8).
 *  Past the file limit nothing per file is read. */
export function sessionDiffSetCapped(rows: readonly SessionDiffRow[], bytes: () => number): boolean {
  if (rows.length > SET_MAX_FILES) return true;
  let lines = 0;
  for (const row of rows) lines += changedLines(row);
  return lines > SET_MAX_LINES || bytes() > SET_MAX_BYTES;
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
  /** Where the file is now when that is not what `status` says of `path`
   *  (a turn's file after its Undo); null: not on disk. */
  openPath?: string | null;
};

/** The path a row's file opens at; null when there is no file to open. */
export function sessionDiffRowOpenPath(row: Pick<SessionDiffRow, 'path' | 'status' | 'openPath'>): string | null {
  if (row.openPath !== undefined) return row.openPath;
  return row.status === 'D' ? null : row.path;
}

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

/** A result's rows, its parts by file path (each file's slice) and each row's
 *  patch digest — what every reader of the result looks up. */
export type ParsedSessionDiff = {
  rows: SessionDiffRow[];
  partsByPath: ReadonlyMap<string, SessionDiffPart[]>;
  /** Characters retained by parsed sections, in addition to the raw reply. */
  retainedPatchChars: number;
  /** FNV-1a over a row's inline patch text, by row path. */
  digests: ReadonlyMap<string, string>;
  /** The result's whole content (patch, files, flags) as one digest. */
  fingerprint: string;
  /** Where each row is, by ID and path (built with the rows). */
  index: RowListIndex;
};

const parsedResults = new WeakMap<object, ParsedSessionDiff>();
const parsing = new WeakMap<object, Promise<ParsedSessionDiff>>();
const fingerprints = new WeakMap<object, string>();
const NO_RESULT = {};

const SESSION_DIFF_PARSE_BUDGET = 64 * 1024;
const FILE_UNIT = 256;
const SCAN_CHUNK = 16 * 1024;
const HEADER_REACH = 8 * 1024;

const FNV_OFFSET = 0x811c9dc5;
function fnv(hash: number, text: string, from = 0, to = text.length): number {
  let next = hash;
  for (let index = from; index < to; index += 1) next = Math.imul(next ^ text.charCodeAt(index), 0x01000193);
  return Math.imul(next ^ 0x7c, 0x01000193);
}

/** Drives work steps (each yielding the characters it handled): all at once,
 *  or handing the event loop back whenever the budget is spent. */
function runSteps<T>(steps: Generator<number, T, void>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
async function runStepsYielding<T>(steps: Generator<number, T, void>): Promise<T> {
  let spent = 0;
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    spent += step.value;
    if (spent >= SESSION_DIFF_PARSE_BUDGET) {
      spent = 0;
      await nextTask();
    }
  }
}

/** File section starts: lines matching `marker` (global, multiline), found
 *  one chunk of patch at a time; the chunks are hashed into `hash.value`. */
function* scanSections(
  patch: string,
  marker: RegExp,
  hash: { value: number } | null
): Generator<number, number[], void> {
  const starts: number[] = [];
  for (let at = 0; at < patch.length; at += SCAN_CHUNK) {
    const end = Math.min(patch.length, at + SCAN_CHUNK);
    if (hash) hash.value = fnv(hash.value, patch, at, end);
    // One character before the chunk, so a line start at its first character is seen as one.
    const from = Math.max(0, at - 1);
    const text = patch.slice(from, Math.min(patch.length, end + HEADER_REACH));
    marker.lastIndex = 0;
    for (let match = marker.exec(text); match; match = marker.exec(text)) {
      const start = from + match.index;
      if (start >= end) break;
      if (start >= at && (start > 0 || from === 0)) starts.push(start);
      if (match[0].length === 0) marker.lastIndex += 1;
    }
    yield end - at;
  }
  return starts;
}

/** The result's content digest, a chunk of patch or a file per step. */
function* fingerprintSteps(
  result: SessionDiffResult | null,
  patch: string
): Generator<number, { fingerprint: string; starts: number[] | null }, void> {
  const hash = { value: FNV_OFFSET };
  const { files: _files, patch: _patch, ...flags } = (result ?? {}) as SessionDiffResult;
  hash.value = fnv(hash.value, JSON.stringify(flags));
  // The patch is scanned for its file sections while it is hashed.
  const starts = yield* scanSections(patch, /^diff --git .+$/gm, hash);
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    const text = JSON.stringify(file) ?? '';
    hash.value = fnv(hash.value, text);
    yield text.length;
  }
  return { fingerprint: `${patch.length}:${(hash.value >>> 0).toString(36)}`, starts };
}

/** A result's content digest: the one its parse took, else taken now. */
function sessionDiffFingerprint(result: SessionDiffResult | null): string {
  const key = result ?? NO_RESULT;
  let fingerprint = fingerprints.get(key);
  if (fingerprint === undefined) {
    fingerprint = runSteps(fingerprintSteps(result, typeof result?.patch === 'string' ? result.patch : '')).fingerprint;
    fingerprints.set(key, fingerprint);
  }
  return fingerprint;
}

/** A digest rejects unequal answers cheaply; it cannot establish equality.
 * Compare wire metadata one file at a time without serializing the patch. */
function* exactDiffSteps(left: SessionDiffResult, right: SessionDiffResult): Generator<number, boolean, void> {
  const { patch, files, ...flags } = left;
  const { patch: otherPatch, files: others, ...otherFlags } = right;
  if (
    patch !== otherPatch ||
    files?.length !== others?.length ||
    JSON.stringify(flags) !== JSON.stringify(otherFlags)
  ) {
    return false;
  }
  for (let i = 0; files && i < files.length; i++) {
    if (JSON.stringify(files[i]) !== JSON.stringify(others?.[i])) return false;
    yield FILE_UNIT;
  }
  return true;
}

export function sameSessionDiffContent(left: SessionDiffResult | null, right: SessionDiffResult | null): boolean {
  if (left === right) return true;
  if (!left || !right || sessionDiffFingerprint(left) !== sessionDiffFingerprint(right)) return false;
  const known = parsedResults.get(left);
  return (known !== undefined && known === parsedResults.get(right)) || runSteps(exactDiffSteps(left, right));
}

/** One macrotask: input and rendering queued meanwhile run before the next step. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Parses a result in steps of bounded work, handing the renderer back to
 *  input between them; once per result object (a read's answer), then looked
 *  up. An answer equal to `held` shares its parse. */
export function parseSessionDiff(
  result: SessionDiffResult | null,
  held: SessionDiffResult | null = null
): Promise<ParsedSessionDiff> {
  const key = result ?? NO_RESULT;
  const known = parsedResults.get(key);
  if (known) return Promise.resolve(known);
  let running = parsing.get(key);
  if (!running) {
    running = runStepsYielding(sessionDiffParseSteps(result, held)).then((parsed) => {
      parsedResults.set(key, parsed);
      return parsed;
    });
    running.finally(() => parsing.delete(key));
    parsing.set(key, running);
  }
  return running;
}

/** A result's parse: the one already done for it, else done now in one go
 *  (a result that never went through a read: a primed cache, an empty answer). */
export function parsedSessionDiff(result: SessionDiffResult | null): ParsedSessionDiff {
  const key = result ?? NO_RESULT;
  let parsed = parsedResults.get(key);
  if (!parsed) {
    parsed = runSteps(sessionDiffParseSteps(result, null));
    parsedResults.set(key, parsed);
  }
  return parsed;
}

export function sessionDiffRowsOf(result: SessionDiffResult | null): SessionDiffRow[] {
  return parsedSessionDiff(result).rows;
}

/** One file's slice of a parsed result's patch ("" when it has no part). */
export function sessionDiffFileSlice(parsed: ParsedSessionDiff, rel: string): string {
  const target = cleanPath(rel);
  if (!target) return '';
  return (parsed.partsByPath.get(target) ?? []).map((part) => part.patch).join('\n');
}

function patchDigest(parts: readonly SessionDiffPart[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.patch.length; index += 1) {
      hash = Math.imul(hash ^ part.patch.charCodeAt(index), 0x01000193);
    }
    hash = Math.imul(hash ^ 0x7c, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function buildSessionDiffRows(result: SessionDiffResult | null): SessionDiffRow[] {
  return sessionDiffRowsOf(result);
}

/** The file sections' [start, end) ranges, as splitUnifiedDiff cuts them. */
function* sectionRanges(patch: string, gitStarts: number[]): Generator<number, Array<[number, number]>, void> {
  if (!patch) return [];
  let starts = gitStarts;
  if (starts.length === 0) starts = yield* scanSections(patch, /^---\s.+(?:\r\n|\r|\n)\+\+\+\s.+$/gm, null);
  if (starts.length === 0) return [[0, patch.length]];
  const ranges: Array<[number, number]> = starts.map((start, index) => [start, starts[index + 1] ?? patch.length]);
  const first = starts[0] as number;
  if (first > 0) {
    const lead = patch.slice(0, first).replace(/\r\n?/g, '\n');
    if (hasLeadingDiffContent(lead)) ranges.unshift([0, first]);
    yield first;
  }
  return ranges;
}

function* patchPartSteps(
  patch: string,
  starts: number[]
): Generator<number, { partsByPath: Map<string, SessionDiffPart[]>; retainedPatchChars: number }, void> {
  let ranges: Array<[number, number]> = [];
  try {
    ranges = yield* sectionRanges(patch, starts);
  } catch {
    ranges = [];
  }
  const partsByPath = new Map<string, SessionDiffPart[]>();
  let retainedPatchChars = 0;
  for (const [start, end] of ranges) {
    yield end - start;
    let part: SessionDiffPart;
    try {
      part = parseUnifiedDiffSection(patch.slice(start, end).replace(/\r\n?/g, '\n'));
    } catch {
      continue;
    }
    const path = partPath(part);
    if (!path) continue;
    retainedPatchChars += part.patch.length;
    if (part.renderPatch !== part.patch) retainedPatchChars += part.renderPatch.length;
    for (const hunk of part.hunks) retainedPatchChars += hunk.length;
    const parts = partsByPath.get(path) || [];
    parts.push(part);
    partsByPath.set(path, parts);
  }
  return { partsByPath, retainedPatchChars };
}

function* rowSteps(
  result: SessionDiffResult | null,
  partsByPath: ReadonlyMap<string, SessionDiffPart[]>
): Generator<number, Pick<ParsedSessionDiff, 'rows' | 'digests' | 'index'>, void> {
  const rows: SessionDiffRow[] = [];
  const index = rowListIndexBuilder();
  const digests = new Map<string, string>();
  const seen = new Set<string>();
  const listedPaths = new Set<string>();
  const fileUnit = (parts: readonly SessionDiffPart[]) =>
    FILE_UNIT + parts.reduce((total, part) => total + part.patch.length, 0);
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
    index.add(rows[rows.length - 1] as SessionDiffRow, rows.length - 1);
    listedPaths.add(path);
    if (parts.length) digests.set(path, patchDigest(parts));
    yield fileUnit(parts);
  }
  for (const [path, parts] of partsByPath) {
    if (listedPaths.has(path)) continue;
    digests.set(path, patchDigest(parts));
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
    index.add(rows[rows.length - 1] as SessionDiffRow, rows.length - 1);
    yield fileUnit(parts);
  }
  return { rows, digests, index: index.finish(rows) };
}

function* sessionDiffParseSteps(
  result: SessionDiffResult | null,
  held: SessionDiffResult | null
): Generator<number, ParsedSessionDiff, void> {
  const patch = typeof result?.patch === 'string' ? result.patch : '';
  const { fingerprint, starts } = yield* fingerprintSteps(result, patch);
  fingerprints.set(result ?? NO_RESULT, fingerprint);
  const heldParse = held ? parsedResults.get(held) : undefined;
  if (heldParse && held && result && fingerprints.get(held) === fingerprint && (yield* exactDiffSteps(held, result))) {
    return heldParse;
  }
  const { partsByPath, retainedPatchChars } = yield* patchPartSteps(patch, starts ?? []);
  const { rows, digests, index } = yield* rowSteps(result, partsByPath);
  return { rows, partsByPath, retainedPatchChars, digests, fingerprint, index };
}
