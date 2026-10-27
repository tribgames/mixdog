/**
 * Discovery of importable foreign conversations on disk (read-only).
 *
 *   codex   $CODEX_HOME/sessions/**\/rollout-*.jsonl   (default ~/.codex)
 *   claude  $CLAUDE_CONFIG_DIR/projects/*\/*.jsonl      (default ~/.claude)
 *   devin   SQLite store → header snapshots in <data>/import-cache/devin   (devin-store.mjs)
 *
 * Enumeration is stat-only; per-file metadata (foreign id, cwd, title, and
 * the message count when the whole file fit the read) comes from a bounded
 * prefix read with bounded concurrency and is cached by canonical path +
 * size + mtime. State is process-wide so every session runtime in the daemon
 * shares one cache, one candidate registry and one set of listing views.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_LINE_BYTES,
  IMPORT_MAX_METADATA_BYTES,
  IMPORT_MAX_RETAINED_ENTRIES,
  IMPORT_MAX_TRANSCRIPT_CHARS,
  createConversationConverter,
  isImportSource,
} from '../../runtime/agent/orchestrator/session/conversation-import/convert.mjs';
import { codexMetaFromTruncatedLine } from '../../runtime/agent/orchestrator/session/conversation-import/codex.mjs';
import { IMPORT_WARNING_CWD_MISSING } from '../../runtime/agent/orchestrator/session/conversation-import/turns.mjs';
import { importOriginKey } from '../../runtime/agent/orchestrator/session/conversation-import/imported-session.mjs';
import { materializeDevinSnapshot, refreshDevinSnapshots, resetDevinStoreCache } from './devin-store.mjs';
import { loadCodexThreadTitles } from './codex-titles.mjs';

export const PREFIX_CHUNK_BYTES = 64 * 1024;
export const PREFIX_MAX_BYTES = 512 * 1024;
const IMPORT_CHUNK_BYTES = 256 * 1024;
const META_CONCURRENCY = 8;
const STAT_CONCURRENCY = 32;
const VIEW_TTL_MS = 30 * 60 * 1000;
const MAX_VIEWS = 32;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Error with a language-neutral `code`; the message is the code itself. */
export function importError(code) {
  return Object.assign(new Error(code), { code });
}

const state = {
  candidates: new Map(), // id → { id, source, path, size, mtimeMs }
  meta: new Map(), // canonical path → { stampKey, value }
  pendingMeta: new Map(), // canonical path → Promise
  queue: [],
  active: 0,
  views: new Map(), // viewId → view
  scanMaxBytes: IMPORT_MAX_FILE_BYTES, // per-file budget of a sidechain-only scan
};

/** Test seam: forget every cached candidate, metadata entry and view; `scanMaxBytes` overrides the scan budget. */
export function resetConversationDiscovery({ scanMaxBytes = IMPORT_MAX_FILE_BYTES } = {}) {
  state.scanMaxBytes = scanMaxBytes;
  state.candidates.clear();
  state.meta.clear();
  state.pendingMeta.clear();
  state.queue.length = 0;
  state.views.clear();
  resetDevinStoreCache();
}

const envDir = (value) => (typeof value === 'string' && value.trim() ? resolve(value.trim()) : null);

/** Root searched for a source (blank env override = unset). */
export function sourceRoot(source, env = process.env) {
  if (source === 'codex') return join(envDir(env.CODEX_HOME) || join(homedir(), '.codex'), 'sessions');
  if (source === 'claude') return join(envDir(env.CLAUDE_CONFIG_DIR) || join(homedir(), '.claude'), 'projects');
  if (source === 'devin') {
    const configured = envDir(env.MIXDOG_DEVIN_CLI_DB);
    return configured ? dirname(configured) : join(homedir(), '.local', 'share', 'devin', 'cli');
  }
  throw importError('unsupported');
}

export function requireSource(source) {
  if (!isImportSource(source)) throw new TypeError('source must be codex, claude or devin.');
  return source;
}

/** Titles the source app stores per foreign session id (Codex only), read fresh; else null. */
export function loadStoredTitles(source, env = process.env) {
  return source === 'codex' ? loadCodexThreadTitles(dirname(sourceRoot(source, env))) : null;
}

/** The app's stored title of a conversation, else the one derived from its messages. */
export function displayTitle(meta, titles) {
  return (meta?.foreignSessionId && titles?.get(meta.foreignSessionId)) || meta?.title || null;
}

const caseFold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

function isInside(root, path) {
  const rel = relative(caseFold(root), caseFold(path));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A path that may reach the network or a raw device, by string alone (no
 * filesystem call): UNC `\\server\share` / `//server/share`, and the Win32
 * namespaces `\\?\…` (including `\\?\UNC\…`) and `\\.\…`. Two leading
 * separators also name a network root on POSIX (`//host/path`).
 */
export function isNetworkOrDevicePath(path) {
  return /^[\\/]{2}/.test(String(path));
}

const fileIdentity = (info) => `${info.dev}:${info.ino}`;

export function candidateId(source, canonicalPath) {
  return createHash('sha256')
    .update(`${source}\0${caseFold(canonicalPath)}`)
    .digest('base64url')
    .slice(0, 32);
}

// Canonical path of a directory entry, or null when it escapes the root.
async function containedRealpath(rootReal, path) {
  try {
    const real = await realpath(path);
    return isInside(rootReal, real) ? real : null;
  } catch {
    return null;
  }
}

async function entriesOf(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkCodex(rootReal, dir, files, seenDirs) {
  for (const entry of await entriesOf(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const real = await containedRealpath(rootReal, path);
      if (!real) continue;
      if (entry.isDirectory() || (await stat(real).catch(() => null))?.isDirectory()) {
        if (seenDirs.has(caseFold(real))) continue;
        seenDirs.add(caseFold(real));
        await walkCodex(rootReal, path, files, seenDirs);
        continue;
      }
    }
    if (/^rollout-.*\.jsonl$/i.test(entry.name)) files.push(path);
  }
}

async function walkClaude(rootReal, files) {
  for (const entry of await entriesOf(rootReal)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(rootReal, entry.name);
    if (!(await containedRealpath(rootReal, dir))) continue;
    for (const file of await entriesOf(dir)) {
      if ((file.isFile() || file.isSymbolicLink()) && /\.jsonl$/i.test(file.name)) files.push(join(dir, file.name));
    }
  }
}

async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Regular files under the source root, canonical and contained, as candidates. */
export async function enumerateCandidates(source, env = process.env) {
  let root = sourceRoot(source, env);
  let rootReal;
  const paths = [];
  if (source === 'devin') {
    // Devin's store is a SQLite DB, not files: refresh header snapshots and
    // enumerate those. `root` shown to the user is the store's own location.
    const snapshots = refreshDevinSnapshots(env);
    if (!snapshots) return { root, candidates: [] };
    root = snapshots.store.displayRoot;
    try {
      rootReal = await realpath(snapshots.dir);
    } catch {
      return { root, candidates: [] };
    }
    for (const entry of await entriesOf(rootReal)) {
      if ((entry.isFile() || entry.isSymbolicLink()) && /\.jsonl$/i.test(entry.name)) {
        paths.push(join(rootReal, entry.name));
      }
    }
  } else {
    try {
      rootReal = await realpath(root);
    } catch {
      return { root, candidates: [] };
    }
    if (source === 'codex') await walkCodex(rootReal, rootReal, paths, new Set([caseFold(rootReal)]));
    else await walkClaude(rootReal, paths);
  }
  const stamped = await mapBounded(paths, STAT_CONCURRENCY, async (path) => {
    const real = await containedRealpath(rootReal, path);
    if (!real) return null;
    const info = await stat(real).catch(() => null);
    return info?.isFile() ? { path: real, size: info.size, mtimeMs: info.mtimeMs, fileId: fileIdentity(info) } : null;
  });
  const unique = new Map();
  for (const file of stamped) {
    if (!file) continue;
    const id = candidateId(source, file.path);
    unique.set(id, registerCandidate({ id, source, root: rootReal, ...file }));
  }
  const candidates = [...unique.values()].sort(byModifiedThenId);
  return { root, candidates };
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function byModifiedThenId(left, right) {
  if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
  return compareCodeUnits(left.id, right.id);
}

function registerCandidate(candidate) {
  state.candidates.set(candidate.id, candidate);
  return candidate;
}

export function getCandidate(id) {
  return typeof id === 'string' ? state.candidates.get(id) || null : null;
}

const stampKey = (candidate) => `${candidate.size}:${candidate.mtimeMs}`;

/** Cached metadata of a candidate at its current stamp, or null. */
export function cachedMeta(candidate) {
  const entry = state.meta.get(candidate.path);
  return entry && entry.stampKey === stampKey(candidate) ? entry.value : null;
}

/** Record a full conversion's message count against the stamp it was read at. */
export function recordConversion(candidate, conversion) {
  state.meta.set(candidate.path, {
    stampKey: stampKey(candidate),
    value: metaFromConversion(conversion, true),
  });
}

function metaFromConversion(conversion, whole) {
  return {
    foreignSessionId: conversion.foreignSessionId,
    cwd: conversion.cwd,
    title: conversion.title,
    // A Codex marker sits in the first line; a Claude transcript is sidechain-only only once read to the end.
    internalKind: whole || conversion.source === 'codex' ? (conversion.internalKind ?? null) : null,
    // Rollout id of the history base this file continues, else null.
    historyBaseId:
      typeof conversion.historyBase?.thread_id === 'string' ? conversion.historyBase.thread_id.toLowerCase() : null,
    messageCount: whole && !conversion.errorCode ? conversion.messageCount : null,
    warnings: whole ? conversion.warnings : conversion.warnings.filter((code) => code !== 'malformed'),
    errorCode: whole ? conversion.errorCode : null,
  };
}

/**
 * Open a candidate for reading and prove the opened file is still the one
 * enumerated: its current real path is the candidate path (inside the source
 * root for an enumerated candidate, never a network/device path) and names
 * the same file as the open handle, which is the file enumerated. A link or
 * junction swapped in after enumeration fails `unreadable`.
 */
async function openCandidate(candidate) {
  const handle = await open(candidate.path, 'r');
  try {
    const opened = await handle.stat();
    const real = await realpath(candidate.path);
    const current = await stat(real);
    const identity = fileIdentity(opened);
    if (
      !opened.isFile() ||
      isNetworkOrDevicePath(real) ||
      caseFold(real) !== caseFold(candidate.path) ||
      (candidate.root && !isInside(candidate.root, real)) ||
      fileIdentity(current) !== identity ||
      (candidate.fileId && candidate.fileId !== identity)
    ) {
      throw importError('unreadable');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Stream a file's lines (split on LF; the converter strips BOM and CR) into
 * `onLine`, holding at most one line plus one chunk in memory. Stops when
 * `onLine` or `onChunk` returns false, when a line exceeds `maxLineBytes`
 * (`overflow`), or after `maxBytes` with more to read (`truncated`;
 * `firstPartial` = the cut-off first line).
 */
async function streamJsonlLines(
  handle,
  onLine,
  { maxLineBytes, chunkBytes, maxBytes = Number.POSITIVE_INFINITY, onChunk }
) {
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let pending = [];
  let pendingBytes = 0;
  let position = 0;
  let lines = 0;
  const emit = (piece) => {
    const line = (pending.length ? Buffer.concat([...pending, piece]) : piece).toString('utf8');
    pending = [];
    pendingBytes = 0;
    lines += 1;
    return onLine(line) !== false;
  };
  const outcome = (fields) => ({
    bytesRead: position,
    eof: false,
    overflow: false,
    truncated: false,
    firstPartial: null,
    ...fields,
  });
  for (;;) {
    const room = Math.min(chunkBytes, maxBytes - position);
    // At the byte budget: probe one byte to tell a cut-off from the end of file.
    const { bytesRead } = await handle.read(chunk, 0, room > 0 ? room : 1, position);
    if (!bytesRead) break;
    if (room <= 0) {
      const firstPartial = lines === 0 && pending.length ? Buffer.concat(pending).toString('utf8') : null;
      return outcome({ truncated: true, firstPartial });
    }
    position += bytesRead;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    for (let newline = view.indexOf(10, start); newline !== -1; newline = view.indexOf(10, start)) {
      if (pendingBytes + newline - start > maxLineBytes) return outcome({ overflow: true });
      if (!emit(view.subarray(start, newline))) return outcome({});
      start = newline + 1;
    }
    if (start < bytesRead) {
      pendingBytes += bytesRead - start;
      if (pendingBytes > maxLineBytes) return outcome({ overflow: true });
      pending.push(Buffer.from(view.subarray(start)));
    }
    if (onChunk && onChunk(position) === false) return outcome({});
  }
  if (pending.length && !emit(Buffer.alloc(0))) return outcome({});
  return outcome({ eof: true });
}

// Complete lines of the last prefix-chunk of a file (the cut-off first line dropped).
async function readTailLines(handle, size) {
  const length = Math.min(size, PREFIX_CHUNK_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, size - length);
  const text = buffer.subarray(0, bytesRead).toString('utf8');
  return (size > length ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
}

async function readPrefixMeta(candidate) {
  const converter = createConversationConverter(candidate.source);
  const handle = await openCandidate(candidate);
  // Only the end of a Claude transcript proves it is sidechain-only, so while
  // nothing but sidechain messages has been seen the scan streams on, line by
  // line, to EOF or to the import file-size limit. A file over that limit stays
  // unclassified (listed); importing it fails as tooLarge.
  const claude = candidate.source === 'claude';
  let read;
  try {
    read = await streamJsonlLines(handle, (line) => converter.pushLine(line), {
      maxLineBytes: claude ? IMPORT_MAX_LINE_BYTES : PREFIX_MAX_BYTES,
      chunkBytes: PREFIX_CHUNK_BYTES,
      maxBytes: claude ? state.scanMaxBytes : PREFIX_MAX_BYTES,
      onChunk: (position) => {
        // A file read to its known size keeps going to EOF (whole-file metadata).
        if (position >= candidate.size) return true;
        if (claude) {
          if (converter.sidechainOnly) return true;
          if (position >= PREFIX_MAX_BYTES) return false;
        }
        const partial = converter.result();
        return !(partial.foreignSessionId && partial.cwd && partial.title);
      },
    });
    // The stored title records sit near the end of a transcript.
    if (claude && !read.eof) {
      for (const line of await readTailLines(handle, candidate.size)) converter.pushTitleLine(line);
    }
  } finally {
    await handle.close();
  }
  const conversion = converter.result();
  // A thread continuing a history base is only counted, named and judged empty once the base is followed (on import).
  const listing = (meta) =>
    conversion.historyBase
      ? { ...meta, title: null, messageCount: null, errorCode: meta.errorCode === 'empty' ? null : meta.errorCode }
      : meta;
  if (read.eof) return listing(metaFromConversion(conversion, true));
  const meta = listing(metaFromConversion(conversion, false));
  if (candidate.source === 'codex' && (!meta.foreignSessionId || !meta.cwd) && read.firstPartial) {
    // A session_meta line longer than the prefix still names its id/cwd.
    const fromLine = codexMetaFromTruncatedLine(read.firstPartial.replace(/^\uFEFF/, ''));
    meta.foreignSessionId ||= fromLine?.foreignSessionId || null;
    meta.cwd ||= fromLine?.cwd || null;
    meta.internalKind ||= fromLine?.internalKind || null;
  }
  return meta;
}

// ── Codex history base chain ─────────────────────────────────────────────────
const HISTORY_CHAIN_MAX_DEPTH = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Rollout id a rollout file name ends with (`…-<thread>.jsonl` or `…-<thread>_<rollout>.jsonl`). */
const rolloutIdOf = (path) => basename(path).match(ROLLOUT_ID_RE)?.[1].toLowerCase() ?? null;

const META_CHUNK_BYTES = 8 * 1024;

/**
 * First JSON record of a candidate file (null when none completes within
 * `maxBytes`, blank lines included, or it is not JSON) and the bytes read for it.
 */
async function firstRecord(candidate, { maxBytes, maxLineBytes }) {
  const handle = await openCandidate(candidate);
  try {
    let first = null;
    const read = await streamJsonlLines(
      handle,
      (line) => {
        first = line.replace(/^\uFEFF/, '').trim();
        return !first;
      },
      { maxLineBytes, chunkBytes: META_CHUNK_BYTES, maxBytes }
    );
    let record = null;
    try {
      record = first ? JSON.parse(first) : null;
    } catch {
      /* not a record */
    }
    return { record, bytes: read.bytesRead };
  } finally {
    await handle.close();
  }
}

// Whether a cutoff falls on a record boundary: the end of the file or just after a line feed.
async function endsOnRecord(candidate, end) {
  if (end === candidate.size) return true;
  const handle = await openCandidate(candidate);
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, end - 1);
    return bytesRead === 1 && byte[0] === 10;
  } finally {
    await handle.close();
  }
}

/** The plain rollout file with this rollout id under the live, then the archived, sessions folder. */
async function findRolloutById(home, rolloutId) {
  for (const folder of ['sessions', 'archived_sessions']) {
    let rootReal;
    try {
      rootReal = await realpath(join(home, folder));
    } catch {
      continue;
    }
    const paths = [];
    await walkCodex(rootReal, rootReal, paths, new Set([caseFold(rootReal)]));
    for (const path of paths) {
      if (rolloutIdOf(path) !== rolloutId) continue;
      const real = await containedRealpath(rootReal, path);
      const info = real ? await stat(real).catch(() => null) : null;
      if (info?.isFile()) {
        return { source: 'codex', root: rootReal, path: real, size: info.size, fileId: fileIdentity(info) };
      }
    }
  }
  return null;
}

/**
 * Rollouts a `history_base` leads to, nearest first, each with the byte offset
 * its contribution ends at, and `metaBytes`, what reading their metadata took.
 * Stops (`partial`) at a base that is missing, unreadable (compressed rollouts
 * are not read), not paginated, already visited, past the depth cap, with a
 * cutoff that excludes the session metadata, passes the end of the file or
 * does not end a record, or that would take the total read (the file, the
 * `spent` metadata reads so far, every cutoff and every metadata read) beyond
 * `maxFileBytes`.
 */
async function resolveHistoryChain(candidate, firstBase, { maxFileBytes, maxLineBytes, spent }) {
  const home = dirname(candidate.root ?? sourceRoot('codex'));
  const seen = new Set([rolloutIdOf(candidate.path)]);
  const segments = [];
  let used = candidate.size + spent;
  let metaBytes = 0;
  const partial = () => ({ segments, partial: true, metaBytes });
  for (let base = firstBase; base; ) {
    const id = typeof base.thread_id === 'string' ? base.thread_id.toLowerCase() : '';
    const end = base.end_byte_offset;
    const ordinal = base.end_ordinal_exclusive;
    if (!UUID_RE.test(id) || seen.has(id) || segments.length >= HISTORY_CHAIN_MAX_DEPTH) return partial();
    seen.add(id);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0 || !Number.isSafeInteger(end) || end <= 0) return partial();
    const found = await findRolloutById(home, id);
    if (!found || end > found.size || used + end > maxFileBytes) return partial();
    let head;
    try {
      if (!(await endsOnRecord(found, end))) return partial();
      head = await firstRecord(found, { maxBytes: Math.min(end, maxFileBytes - used - end), maxLineBytes });
    } catch {
      return partial();
    }
    used += end + head.bytes;
    metaBytes += head.bytes;
    if (head.record?.type !== 'session_meta' || head.record.payload?.history_mode !== 'paginated') return partial();
    segments.push({ candidate: found, end });
    const next = head.record.payload.history_base;
    base = next && typeof next === 'object' ? next : null;
  }
  return { segments, partial: false, metaBytes };
}

/**
 * Stream-convert a whole candidate file under the import limits. A file over
 * `maxFileBytes`, a line over `maxLineBytes` or a conversion over the
 * converter's limits fails the file with `tooLarge` without reading the rest.
 * A Codex rollout continuing a `history_base` is preceded by the records of
 * each base up to its cutoff, oldest first (their session metadata dropped),
 * all within the one `maxFileBytes`; a base that cannot be followed leaves the
 * `historyPartial` warning. `bytesRead` is how far the read got.
 */
export async function convertCandidateFile(
  candidate,
  {
    maxFileBytes = IMPORT_MAX_FILE_BYTES,
    maxLineBytes = IMPORT_MAX_LINE_BYTES,
    maxTranscriptChars = IMPORT_MAX_TRANSCRIPT_CHARS,
    maxRetainedEntries = IMPORT_MAX_RETAINED_ENTRIES,
    maxMetadataBytes = IMPORT_MAX_METADATA_BYTES,
    chunkBytes = IMPORT_CHUNK_BYTES,
    env = process.env,
  } = {}
) {
  if (candidate.source === 'devin' && candidate.root) {
    // A managed snapshot is only a header until imported: dump the live
    // session now so the import sees the current conversation. Picked files
    // (root null) convert as they are.
    if (!materializeDevinSnapshot(candidate.path, env)) throw importError('unreadable');
    const info = await stat(candidate.path).catch(() => null);
    if (!info?.isFile()) throw importError('unreadable');
    candidate.size = info.size;
    candidate.mtimeMs = info.mtimeMs;
    candidate.fileId = fileIdentity(info);
  }
  const converter = createConversationConverter(candidate.source, {
    maxTranscriptChars,
    maxRetainedEntries,
    maxMetadataBytes,
  });
  // Bytes read beyond the file itself: metadata pre-reads and the bases' cutoffs. All count against `maxFileBytes`.
  let inheritedBytes = 0;
  if (candidate.source === 'codex') {
    const head = await firstRecord(candidate, { maxBytes: maxFileBytes, maxLineBytes });
    const base = head.record?.payload?.history_base;
    if (base && typeof base === 'object') {
      inheritedBytes += head.bytes;
      const chain =
        head.record.payload.history_mode === 'paginated'
          ? await resolveHistoryChain(candidate, base, { maxFileBytes, maxLineBytes, spent: inheritedBytes })
          : { segments: [], partial: true, metaBytes: 0 };
      inheritedBytes += chain.metaBytes;
      const { segments, partial } = chain;
      if (partial) converter.markHistoryPartial();
      for (const { candidate: baseFile, end } of segments.reverse()) {
        const baseHandle = await openCandidate(baseFile);
        try {
          const read = await streamJsonlLines(baseHandle, (line) => converter.pushLine(line, { inherited: true }), {
            maxLineBytes,
            chunkBytes,
            maxBytes: end,
          });
          if (read.overflow) converter.markTooLarge();
          inheritedBytes += read.bytesRead;
        } finally {
          await baseHandle.close();
        }
      }
    }
  }
  const handle = await openCandidate(candidate);
  try {
    const read = await streamJsonlLines(handle, (line) => converter.pushLine(line), {
      maxLineBytes,
      chunkBytes,
      maxBytes: maxFileBytes - inheritedBytes,
    });
    if (read.overflow || read.truncated) converter.markTooLarge();
    return { ...converter.result(), bytesRead: read.bytesRead + inheritedBytes };
  } finally {
    await handle.close();
  }
}

function pumpMetaQueue() {
  while (state.active < META_CONCURRENCY && state.queue.length) {
    const job = state.queue.shift();
    state.active += 1;
    readPrefixMeta(job.candidate)
      .catch(() => ({
        foreignSessionId: null,
        cwd: null,
        title: null,
        internalKind: null,
        historyBaseId: null,
        messageCount: null,
        warnings: [],
        errorCode: 'unreadable',
      }))
      .then((value) => {
        state.meta.set(job.candidate.path, { stampKey: stampKey(job.candidate), value });
        job.resolve(value);
      })
      .finally(() => {
        state.pendingMeta.delete(job.key);
        state.active -= 1;
        pumpMetaQueue();
      });
  }
}

/** Metadata of a candidate, read through the bounded queue when not cached. */
export function resolveMeta(candidate) {
  const cached = cachedMeta(candidate);
  if (cached) return Promise.resolve(cached);
  const key = `${candidate.path}\0${stampKey(candidate)}`;
  const pending = state.pendingMeta.get(key);
  if (pending) return pending;
  const promise = new Promise((resolveJob) => {
    state.queue.push({ candidate, key, resolve: resolveJob });
  });
  state.pendingMeta.set(key, promise);
  pumpMetaQueue();
  return promise;
}

// ── cwd canonicalization ─────────────────────────────────────────────────────
/**
 * `{ exists, path }`: the canonical directory when it exists, else the raw
 * value. A relative or network/device cwd is display text only: it is never
 * handed to the filesystem (probing a UNC share can negotiate credentials).
 */
export async function resolveSourceCwd(raw, cache = null) {
  if (!raw) return { exists: false, path: null };
  if (cache?.has(raw)) return cache.get(raw);
  let result = { exists: false, path: raw };
  try {
    if (!isAbsolute(raw) || isNetworkOrDevicePath(raw)) throw importError('unsupported');
    const real = await realpath(raw);
    if (!isNetworkOrDevicePath(real) && (await stat(real)).isDirectory()) result = { exists: true, path: real };
  } catch {
    /* missing or unreadable: kept as provenance only */
  }
  cache?.set(raw, result);
  return result;
}

// ── rows ─────────────────────────────────────────────────────────────────────
export function candidateKey(candidate, meta) {
  return importOriginKey(candidate.source, meta?.foreignSessionId || null, candidate.path);
}

/** Session ids per import key, from session summaries (`importKey`). */
export function importedKeyMap(summaries) {
  const map = new Map();
  for (const row of Array.isArray(summaries) ? summaries : []) {
    if (row?.closed === true || typeof row?.importKey !== 'string' || !row.importKey) continue;
    if (typeof row.id !== 'string' || !row.id) continue;
    const ids = map.get(row.importKey);
    if (ids) ids.push(row.id);
    else map.set(row.importKey, [row.id]);
  }
  return map;
}

function rowFor(candidate, meta, cwdInfo, imported, titles) {
  const warnings = new Set(meta?.warnings || []);
  if (meta && !meta.errorCode && !cwdInfo?.exists) warnings.add(IMPORT_WARNING_CWD_MISSING);
  // A devin snapshot is header-only until import: meta-only is not "empty".
  const headerOnly = candidate.source === 'devin' && meta?.errorCode === 'empty' && meta.foreignSessionId;
  if (meta?.errorCode && !headerOnly) warnings.add(meta.errorCode);
  return {
    id: candidate.id,
    source: candidate.source,
    title: displayTitle(meta, titles),
    cwd: cwdInfo?.path ?? null,
    modifiedAt: candidate.mtimeMs,
    messageCount: meta?.messageCount ?? null,
    importedSessionId: meta ? imported.get(candidateKey(candidate, meta)) || null : null,
    warnings: [...warnings],
  };
}

export async function buildRow(candidate, imported, cwdCache = new Map(), titles = null) {
  const meta = cachedMeta(candidate);
  const cwdInfo = meta?.cwd ? await resolveSourceCwd(meta.cwd, cwdCache) : null;
  return rowFor(candidate, meta, cwdInfo, imported, titles);
}

// ── views & paging ───────────────────────────────────────────────────────────
function pruneViews(now = Date.now()) {
  for (const [id, view] of state.views) {
    if (now - view.touchedAt > VIEW_TTL_MS) state.views.delete(id);
  }
  while (state.views.size > MAX_VIEWS) state.views.delete(state.views.keys().next().value);
}

/** A live listing view, or an error when it expired (membership is never re-derived). */
export function requireView(viewId) {
  pruneViews();
  const view = typeof viewId === 'string' ? state.views.get(viewId) : null;
  if (!view) throw importError('viewExpired');
  view.touchedAt = Date.now();
  return view;
}

function encodeCursor(viewId, offset) {
  return Buffer.from(JSON.stringify([viewId, offset]), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [viewId, offset] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof viewId === 'string' && Number.isSafeInteger(offset) && offset >= 0) return { viewId, offset };
  } catch {
    /* fall through */
  }
  throw importError('invalidCursor');
}

function pageLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = Math.floor(Number(limit));
  if (!Number.isFinite(value) || value < 1) throw new TypeError('limit must be a positive integer.');
  return Math.min(value, MAX_LIMIT);
}

const foldText = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase();

function samePath(left, right) {
  if (!left || !right) return false;
  return caseFold(resolve(left)) === caseFold(resolve(right));
}

function optionalTime(value, name) {
  if (value === undefined || value === null) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a timestamp in milliseconds.`);
  return ms;
}

async function pageResult(view, offset, limit, imported) {
  const cwdCache = new Map();
  const ids = view.memberIds.slice(offset, offset + limit);
  const rows = [];
  for (const id of ids) {
    const candidate = state.candidates.get(id);
    if (candidate) rows.push(await buildRow(candidate, imported, cwdCache, view.titles));
  }
  const nextOffset = offset + ids.length;
  return {
    searchedRoot: view.root,
    viewId: view.id,
    complete: view.complete,
    matchedCount: view.memberIds.length,
    selectableCount: view.selectableIds.length,
    projects: view.projects,
    rows,
    nextCursor: nextOffset < view.memberIds.length ? encodeCursor(view.id, nextOffset) : null,
  };
}

/**
 * Ids of Codex rollouts that an earlier revision of the same thread (same
 * session id) names as its history base. Codex lists one rollout per thread,
 * the current one, so these stay out of the list; a fork's parent is another
 * thread and stays listed.
 */
function supersededBaseIds(candidates) {
  const byRollout = new Map();
  for (const candidate of candidates) {
    const meta = cachedMeta(candidate);
    const rolloutId = candidate.source === 'codex' ? rolloutIdOf(candidate.path) : null;
    if (meta?.foreignSessionId && rolloutId) byRollout.set(`${meta.foreignSessionId}\0${rolloutId}`, candidate.id);
  }
  const hidden = new Set();
  for (const candidate of candidates) {
    const meta = cachedMeta(candidate);
    const base = meta?.historyBaseId && byRollout.get(`${meta.foreignSessionId}\0${meta.historyBaseId}`);
    if (base && base !== candidate.id) hidden.add(base);
  }
  // A cycle of revisions must not hide a thread entirely: its newest one (first in order) stays.
  const newest = new Map();
  const visible = new Set();
  const indexed = new Set(byRollout.values());
  for (const candidate of candidates) {
    const sessionId = cachedMeta(candidate)?.foreignSessionId;
    if (!sessionId || !indexed.has(candidate.id)) continue;
    if (!newest.has(sessionId)) newest.set(sessionId, candidate.id);
    if (!hidden.has(candidate.id)) visible.add(sessionId);
  }
  for (const [sessionId, id] of newest) if (!visible.has(sessionId)) hidden.delete(id);
  return hidden;
}

/**
 * Apply a view's filters (time range, query on title/cwd, project) to
 * candidates using their cached metadata; a candidate whose metadata is still
 * pending is neither a member nor counted and leaves the result incomplete.
 * The source app's internal and empty records are never members.
 */
async function filterCandidates(candidates, filters, imported, titles) {
  const { needle, projectFilter, modifiedAfter, modifiedBefore } = filters;
  const cwdCache = new Map();
  const memberIds = [];
  const selectableIds = [];
  const projectCounts = new Map();
  let complete = true;
  const superseded = supersededBaseIds(candidates);
  for (const candidate of candidates) {
    if (superseded.has(candidate.id)) continue;
    if (modifiedAfter !== null && candidate.mtimeMs < modifiedAfter) continue;
    if (modifiedBefore !== null && candidate.mtimeMs > modifiedBefore) continue;
    const meta = cachedMeta(candidate);
    // Unclassified yet: neither a member nor counted until its metadata is read.
    if (!meta) {
      complete = false;
      continue;
    }
    // The source app's own records and files read to the end without a message are not conversations.
    if (meta.internalKind || meta.errorCode === 'empty') continue;
    const cwdInfo = meta.cwd ? await resolveSourceCwd(meta.cwd, cwdCache) : null;
    if (
      needle &&
      !(foldText(displayTitle(meta, titles)).includes(needle) || foldText(cwdInfo?.path).includes(needle))
    ) {
      continue;
    }
    if (cwdInfo?.path) projectCounts.set(cwdInfo.path, (projectCounts.get(cwdInfo.path) || 0) + 1);
    if (projectFilter && !samePath(cwdInfo?.path, projectFilter)) continue;
    // Already-imported conversations are left out of the list entirely.
    if (imported.has(candidateKey(candidate, meta))) continue;
    memberIds.push(candidate.id);
    selectableIds.push(candidate.id);
  }
  const projects = [...projectCounts]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count || compareCodeUnits(a.cwd, b.cwd));
  return { memberIds, selectableIds, projects, complete };
}

/**
 * One page of importable conversations. Without `cursor` a new view (fixed
 * membership) is built from a fresh enumeration; a cursor pages that view.
 * `imported` maps an import key to its live session id (`get`/`has`).
 */
export async function listConversations(params, { imported, env = process.env } = {}) {
  const { source, query, project, cursor } = params || {};
  requireSource(source);
  const limit = pageLimit(params?.limit);
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    const { viewId, offset } = decodeCursor(cursor);
    const view = requireView(viewId);
    if (view.source !== source) throw importError('invalidCursor');
    return pageResult(view, offset, limit, imported);
  }
  const filters = {
    modifiedAfter: optionalTime(params?.modifiedAfter, 'modifiedAfter'),
    modifiedBefore: optionalTime(params?.modifiedBefore, 'modifiedBefore'),
    needle: foldText(query).trim(),
    projectFilter: typeof project === 'string' && project.trim() ? project.trim() : null,
  };
  const { root, candidates } = await enumerateCandidates(source, env);
  const titles = await loadStoredTitles(source, env);
  // Background metadata for everything, newest first; the first page is awaited.
  // Candidates still unclassified stay out of the view (it is incomplete) and join it on a later listing.
  for (const candidate of candidates) void resolveMeta(candidate);
  if (!filters.needle && !filters.projectFilter) await Promise.all(candidates.slice(0, limit).map(resolveMeta));
  const view = {
    id: randomUUID(),
    source,
    root,
    filters,
    titles,
    candidateIds: candidates.map((candidate) => candidate.id),
    ...(await filterCandidates(candidates, filters, imported, titles)),
    touchedAt: Date.now(),
  };
  state.views.set(view.id, view);
  pruneViews();
  return pageResult(view, 0, limit, imported);
}

/**
 * Complete selectable membership of a view for select-all: waits until the
 * metadata of every candidate the view enumerated is resolved, re-applies the
 * view's filters, then drops `excludeIds` and already-imported conversations.
 * An expired view is rejected.
 */
export async function resolveViewSelection(viewId, excludeIds, imported) {
  const view = requireView(viewId);
  const candidates = view.candidateIds.map((id) => state.candidates.get(id)).filter(Boolean);
  await Promise.all(candidates.map(resolveMeta));
  const { selectableIds } = await filterCandidates(candidates, view.filters, imported, view.titles);
  const excluded = new Set(Array.isArray(excludeIds) ? excludeIds : []);
  return selectableIds.filter((id) => !excluded.has(id));
}

// ── picked files ─────────────────────────────────────────────────────────────
/** Validate and register a file chosen in a native picker (a local regular .jsonl). */
export async function registerFile({ source, path } = {}, { imported, limits, env = process.env } = {}) {
  requireSource(source);
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw importError('invalidPath');
  const requested = path.trim();
  // Network/device forms are refused before any filesystem call.
  if (isNetworkOrDevicePath(requested)) throw importError('unsupported');
  if (!isAbsolute(requested)) throw importError('invalidPath');
  if (extname(basename(requested)).toLowerCase() !== '.jsonl') throw importError('unsupported');
  let real;
  let info;
  try {
    real = await realpath(requested);
    info = await stat(real);
  } catch {
    throw importError('unreadable');
  }
  if (isNetworkOrDevicePath(real) || !info.isFile() || extname(real).toLowerCase() !== '.jsonl') {
    throw importError('unsupported');
  }
  const candidate = registerCandidate({
    id: candidateId(source, real),
    source,
    root: null,
    path: real,
    size: info.size,
    mtimeMs: info.mtimeMs,
    fileId: fileIdentity(info),
  });
  let conversion;
  try {
    conversion = await convertCandidateFile(candidate, limits);
  } catch {
    throw importError('unreadable');
  }
  if (conversion.errorCode) throw importError(conversion.errorCode);
  recordConversion(candidate, conversion);
  return { row: await buildRow(candidate, imported, new Map(), await loadStoredTitles(source, env)) };
}
