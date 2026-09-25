/**
 * read-single-tool.mjs — one scalar Read as a pipeline of explicit stages:
 * path guards → stat-time guards → window widening → body-free answers
 * (mutation stub, media, validated cache hit, path snapshot) → body read
 * (streamed or buffered). Each stage lives in its own module; this file only
 * fixes the order and threads the read context between them.
 */
import * as fsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { normalizeInputPath } from './path-utils.mjs';
import { detectReadEncodingFromBuffer, isUtf16Encoding } from './snapshot-helpers.mjs';
import { inspectBinaryFile, isBinaryBuffer } from './binary-file.mjs';
import {
  readInputPathGuard,
  readNotFoundResponse,
  readResolvedPathGuard,
  statReadTarget,
} from './read-single-guards.mjs';
import { widenReadWindow } from './read-window-widen.mjs';
import { mutationUnchangedStub, pathSnapshotUnchangedStub, readCachedResult } from './read-single-fast-paths.mjs';
import { readMediaFile } from './read-single-media.mjs';
import { binaryPreviewResult, smartStreamResult, streamRangeResult } from './read-single-stream.mjs';
import { bufferedReadResult } from './read-single-render.mjs';

// Buffered reads take the whole body up front: the raw-content cache first,
// else one readFile shared with any in-flight read of the same path.
async function prefetchRawBody(fullPath, st, helpers) {
  const { _rawContentCacheGet, _runRawContentInFlight } = helpers;
  const cachedRaw = _rawContentCacheGet ? _rawContentCacheGet(fullPath, st) : null;
  if (cachedRaw) return { buf: cachedRaw, fromCache: true };
  try {
    const buf = _runRawContentInFlight ? await _runRawContentInFlight(fullPath, readFile) : await readFile(fullPath);
    return { buf, fromCache: false };
  } catch {
    return { buf: null, fromCache: false };
  }
}

export async function executeSingleReadTool(args, workDir, readStateScope, options = {}, helpers = {}) {
  const {
    parseLineLimitArg,
    parseOffsetArg,
    resolveAgainstCwd,
    READ_MAX_OUTPUT_BYTES,
    READ_MAX_SIZE_BYTES,
    READ_SMART_STREAM_MIN_BYTES,
    READ_STREAM_RANGE_MIN_BYTES,
  } = helpers;
  const readMaxOutputBytes =
    Number(options?.readOutputBudgetBytes) > 0
      ? Math.min(READ_MAX_OUTPUT_BYTES, Math.trunc(Number(options.readOutputBudgetBytes)))
      : READ_MAX_OUTPUT_BYTES;
  const readOffsetBase = options.readOffsetBase === 1 ? 1 : 0;
  // Normalize path (strip whitespace, expand ~, posix→windows) up front so
  // LLM-injected stray spaces don't trigger an ENOENT retry that pollutes
  // the conversation history and breaks the cache prefix on later turns.
  if (typeof args.path === 'string') args.path = normalizeInputPath(args.path);
  const filePath = args.path;
  if (!filePath) return 'Error: path is required.';
  const inputRejected = readInputPathGuard(filePath, helpers);
  if (inputRejected) return inputRejected;
  const fullPath = resolveAgainstCwd(filePath, workDir);
  const resolvedRejected = readResolvedPathGuard(fullPath, helpers);
  if (resolvedRejected) return resolvedRejected;
  const hasOffsetArg = args.offset !== undefined && args.offset !== null;
  const hasLimitArg = args.limit !== undefined && args.limit !== null;
  const hasRangeArgs = hasOffsetArg || hasLimitArg;
  const wantFull = args.full === true;
  let offset = parseOffsetArg(args.offset);
  // full:true bypasses the default 2000-line cap so the whole file can be
  // returned in one call; the byte cap still emits a compact truncation
  // marker when rendered bytes overflow READ_MAX_OUTPUT_BYTES.
  let limit = parseLineLimitArg(args.limit, wantFull ? Infinity : 2000);
  let widenNote = '';
  const target = await statReadTarget(fullPath, filePath, options, helpers);
  if (target.error) return target.error;
  if (!target.st) return readNotFoundResponse(target.statErr, { fullPath, filePath, workDir }, helpers);
  const st = target.st;
  // Reactive widen + window-history bookkeeping (ranged text reads only).
  if (
    readStateScope &&
    typeof readStateScope === 'object' &&
    hasOffsetArg &&
    hasLimitArg &&
    Number.isFinite(limit) &&
    limit > 0
  ) {
    ({ offset, limit, widenNote } = widenReadWindow(readStateScope, fullPath, { offset, limit }));
  }
  const unchanged = mutationUnchangedStub({ fullPath, filePath, st, readStateScope, options }, helpers);
  if (unchanged) return unchanged;
  // MEDIA-WINS: media dispatch runs before every cache/snapshot fast path so
  // a stale text entry can never short-circuit a media read.
  const media = await readMediaFile({ fullPath, st, args, readStateScope, options, hasRangeArgs }, helpers);
  if (media) return media.result;
  const cacheKey = `read|${fullPath}|${st.mtimeMs}|${st.ctimeMs}|${st.size}|${hasOffsetArg ? offset : 'd'}|${hasLimitArg ? limit : 'd'}|${wantFull ? 'f' : 's'}|base:${readOffsetBase}|budget:${readMaxOutputBytes}`;
  const ctx = {
    fullPath,
    filePath,
    st,
    cacheKey,
    readStateScope,
    options,
    offset,
    limit,
    hasRangeArgs,
    wantFull,
    readMaxOutputBytes,
    readOffsetBase,
    widenNote,
  };
  const cached = await readCachedResult(ctx, helpers);
  if (cached) return cached.result;
  const pathStub = await pathSnapshotUnchangedStub(ctx, helpers);
  if (pathStub) return pathStub;
  // Pre-read size cap: a small error response beats 25K tokens of truncated
  // content (Anthropic #21841 reverted truncation). With offset/limit the
  // requested window streams instead; without range args the cap still
  // refuses so the small-file default path can't pull megabytes by accident.
  const preferRangeStream =
    hasRangeArgs && !wantFull && (options?.forceReadRangeStream === true || st.size > READ_STREAM_RANGE_MIN_BYTES);
  const preferSmartStream = !hasRangeArgs && !wantFull && st.size >= READ_SMART_STREAM_MIN_BYTES;
  const preferBufferedRead = st.size <= READ_MAX_SIZE_BYTES && !preferRangeStream && !preferSmartStream;
  const prefetched = preferBufferedRead
    ? await prefetchRawBody(fullPath, st, helpers)
    : { buf: null, fromCache: false };
  return await readBodyResult(ctx, { prefetched, preferRangeStream, preferSmartStream }, helpers);
}

// Body read: binary/encoding inspection, then the streamed (range or smart)
// or buffered path. Owns the file handle shared by inspection and streaming.
async function readBodyResult(ctx, { prefetched, preferRangeStream, preferSmartStream }, helpers) {
  const { normalizeErrorMessage, READ_MAX_SIZE_BYTES } = helpers;
  const { fullPath, st, hasRangeArgs } = ctx;
  let readHandle = null;
  try {
    // Encoding and binary detection share the same head sample and handle
    // with ranged reads. All earlier path/device/media guards still run first.
    let binaryInspection = null;
    if (!prefetched.buf) {
      readHandle = await fsPromises.open(fullPath, 'r');
      binaryInspection = await inspectBinaryFile(fullPath, st.size, { handle: readHandle });
    }
    // BOM-only encoding detection runs BEFORE the size branch and the
    // binary/NUL check: a UTF-16 (LE or BE) + BOM file is full of 0x00 bytes
    // and would be rejected as binary or mis-decoded by the utf-8 streaming
    // paths, so it always routes to the bounded in-memory decode.
    const readEnc = detectReadEncodingFromBuffer(prefetched.buf || binaryInspection.head);
    const isUtf16 = isUtf16Encoding(readEnc);
    const inspectBinary = async () => {
      if (binaryInspection) return binaryInspection;
      binaryInspection = prefetched.buf
        ? {
            isBinary: isBinaryBuffer(prefetched.buf, st.size),
            preview: prefetched.buf.subarray(0, Math.min(256, prefetched.buf.length)),
          }
        : await inspectBinaryFile(fullPath, st.size);
      return binaryInspection;
    };
    const streamRange = (source) =>
      streamRangeResult(ctx, { source, fileHandle: readHandle, prefixBuffer: binaryInspection?.head }, helpers);
    if (st.size > READ_MAX_SIZE_BYTES) {
      // utf16 reads route through one in-memory full read+decode+split
      // (streamReadRange decodes chunks as utf-8), so a utf16 file over the
      // cap is refused rather than held unbounded in memory.
      if (isUtf16) {
        return `Error: UTF-16 file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES} bytes; utf16 ranged reads are bounded — convert to UTF-8 or narrow the range.`;
      }
      if (!hasRangeArgs) return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap.`;
      const binary = await inspectBinary();
      if (binary.isBinary) return binaryPreviewResult(ctx, binary.preview, helpers);
      return await streamRange('read');
    }
    if (!isUtf16) {
      const binary = await inspectBinary();
      if (binary.isBinary) return binaryPreviewResult(ctx, binary.preview, helpers);
    }
    // The streaming paths decode chunks as utf-8; a utf16 file falls through
    // to the encoding-aware buffered read (which still runs smartReadTruncate
    // so smart-elide stays intact).
    if (!isUtf16 && preferSmartStream) {
      const smart = await smartStreamResult(ctx, helpers);
      if (smart !== null) return smart;
    }
    if (!isUtf16 && preferRangeStream) return await streamRange('read_stream_range');
    return await bufferedReadResult(ctx, { prefetched, readEnc }, helpers);
  } catch (err) {
    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
  } finally {
    if (readHandle) await readHandle.close().catch(() => {});
  }
}
