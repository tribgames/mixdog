/**
 * read-single-render.mjs — the buffered Read: decode the raw body with its
 * detected encoding, render the requested line window with line numbers,
 * apply the smart-elide / byte caps and footers, and describe exactly which
 * lines the model saw (the snapshot meta Edit later validates against).
 */
import * as fsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { READ_PREFIX_HASH_BYTES } from './read-single-fast-paths.mjs';

/**
 * Encoding-aware decode (fresh read AND raw-content cache hit both flow
 * through here). For a BOM-flagged UTF-16LE file, strip the 2-byte FF FE BOM
 * and decode as utf16le so it reverses the write tool's preservation; utf-8
 * stays byte-identical (the leading U+FEFF of a utf8-BOM file is stripped
 * later at the line[0] check for display). UTF-16BE has no Node string
 * encoding: swap byte pairs to LE (swap16 needs an even length) then decode
 * as utf16le, so a BE file reverses the same way a LE file does.
 */
export function decodeReadBuffer(rawBuf, enc) {
  if (enc.encoding === 'utf16le') return rawBuf.subarray(enc.bomLen).toString('utf16le');
  if (enc.encoding === 'utf16be') {
    const body = rawBuf.subarray(enc.bomLen);
    const even = body.length & ~1;
    return Buffer.from(body.subarray(0, even)).swap16().toString('utf16le');
  }
  return rawBuf.toString('utf-8');
}

// Output byte cap protects against many-line slices that individually pass
// the file-size check but explode after line-number prefixing. `lo` is a
// UTF-16 code-unit index: cutting between a high and low surrogate emits a
// lone surrogate (replacement glyph) and breaks the byte count the cap just
// computed, so step back off the pair.
function byteCapSlice(rendered, maxBytes) {
  let lo = 0;
  let hi = rendered.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(rendered.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) {
    const cu = rendered.charCodeAt(lo - 1);
    if (cu >= 0xd800 && cu <= 0xdbff) lo -= 1;
  }
  return rendered.slice(0, lo);
}

function rangeFooter(ctx, render, rendered) {
  const { offset, readMaxOutputBytes, readOffsetBase, widenNote } = ctx;
  const { lineCount, renderedLineCount, byteCapTruncated, sliced } = render;
  if (sliced.length === 0 && offset >= lineCount)
    return { replace: `(no lines in range; file has ${lineCount} lines)` };
  const emittedStart = offset + 1;
  if (byteCapTruncated) {
    const emittedEnd = offset + renderedLineCount;
    const capKb = Math.round(readMaxOutputBytes / 1024);
    const more = emittedEnd < lineCount ? `; pass offset:${emittedEnd + readOffsetBase} to continue` : '';
    return { footer: `[lines ${emittedStart}-${emittedEnd} of ${lineCount}; output truncated at ${capKb} KB${more}]` };
  }
  if (Buffer.byteLength(rendered, 'utf8') > readMaxOutputBytes) return {};
  const emittedEnd = offset + sliced.length;
  // Continuation uses the originating caller's coordinate base. Remaining
  // content is not automatically required evidence; when it is, it fits one
  // wider read, not a walk window by window.
  const more = emittedEnd < lineCount ? `; pass offset:${emittedEnd + readOffsetBase} to continue` : '';
  const footer = `[lines ${emittedStart}-${emittedEnd} of ${lineCount}${more}]`;
  return { footer: widenNote ? `${footer}\n${widenNote}` : footer };
}

/**
 * Render the requested window of `content`.
 * @returns {{ out: string, lineCount: number, renderedLineCount: number,
 *   smartTruncated: boolean, smartVisibleRanges: Array|null, byteCapTruncated: boolean }}
 *   renderedLineCount / the truncation flags say which lines the model
 *   actually saw (W1 H): smart-middle elision and byte-cap truncation both
 *   drop lines, and the snapshot must not claim coverage of them.
 */
export function renderReadWindow(content, ctx, helpers) {
  const { filePath, st, offset, limit, hasRangeArgs, wantFull, readMaxOutputBytes } = ctx;
  const { renderReadLine, smartReadTruncate, appendReadContextAdvisory, normalizeOutputPath } = helpers;
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  // wc-l compatible line count: a trailing newline ends a line, it does not
  // start a new empty one. Display count must match the count emitted by
  // mode:"count" so footer and count agree.
  const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const renderEnd = !hasRangeArgs && !wantFull ? lineCount : Math.min(offset + limit, lineCount);
  const sliced = lines.slice(offset, renderEnd);
  const rendered = sliced
    .map((line, i) => renderReadLine(offset + i + 1, line, { truncateLongLine: !wantFull }))
    .join('\n');
  // Smart cap only engages for the default read (no offset/limit, full:false)
  // over the line/byte threshold; explicit ranges always see byte-exact output.
  const smart =
    !hasRangeArgs && !wantFull && typeof smartReadTruncate === 'function'
      ? smartReadTruncate(rendered, lineCount, st.size, filePath)
      : null;
  const smartTruncated = !!smart?.truncated;
  const render = {
    lineCount,
    sliced,
    renderedLineCount: sliced.length,
    smartTruncated,
    smartVisibleRanges: smartTruncated && Array.isArray(smart.ranges) ? smart.ranges : null,
    byteCapTruncated: false,
  };
  let out;
  if (smartTruncated) {
    out = smart.text;
    render.renderedLineCount = 0;
  } else if (Buffer.byteLength(rendered, 'utf8') > readMaxOutputBytes) {
    const slice = byteCapSlice(rendered, readMaxOutputBytes);
    render.renderedLineCount = Math.max(0, slice.split('\n').length - 1);
    render.byteCapTruncated = true;
    out = `${slice}\n\n... [output truncated at ${Math.round(readMaxOutputBytes / 1024)} KB] ...`;
  } else {
    out = rendered;
  }
  if (hasRangeArgs) {
    const { replace, footer } = rangeFooter(ctx, render, rendered);
    if (replace !== undefined) out = replace;
    else if (footer !== undefined) out += `${out ? '\n' : ''}${footer}`;
  }
  if (!hasRangeArgs && !wantFull && !smartTruncated && content.length > 0) {
    out = appendReadContextAdvisory(out, { filePath, lineCount, bytes: st.size });
  }
  // An empty file gets a system-reminder instead of a bare `1│` line so the
  // agent doesn't assume content was elided. W1 M: the filename can contain
  // `<` or `</system-reminder>` sequences; XML-escape before interpolation so
  // a hostile path can't terminate the envelope and inject markup.
  if (content.length === 0) {
    const safePath = normalizeOutputPath(filePath).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = `<system-reminder>File exists but has empty contents: ${safePath}</system-reminder>`;
  }
  return { ...render, out };
}

/**
 * Describe exactly which lines the model saw. A full-file view pins the
 * whole body with one contentHash (also reused as the ≤64KiB race-guard
 * prefix hash — the same SHA-256 over the identical `content`); anything
 * narrower records rangeHashes over the visible window so
 * snapshotCoversFullFile never green-lights an overwrite against bytes the
 * read never returned.
 */
export function bufferedReadSnapshotMeta(content, render, ctx, helpers) {
  const { offset, limit } = ctx;
  const { _hashText, _rangeHashesForReadRanges } = helpers;
  const { lineCount, renderedLineCount, smartTruncated, smartVisibleRanges, byteCapTruncated } = render;
  const isFullFileView = offset === 0 && offset + limit >= lineCount && !smartTruncated && !byteCapTruncated;
  let visibleRanges = [];
  if (smartTruncated && smartVisibleRanges) visibleRanges = smartVisibleRanges;
  else if (renderedLineCount > 0) {
    visibleRanges = [{ startLine: offset + 1, endLine: Math.min(lineCount, offset + renderedLineCount) }];
  }
  const rangeHashes = !isFullFileView ? _rangeHashesForReadRanges(content, visibleRanges) : [];
  const fullContentHash = isFullFileView ? _hashText(content) : '';
  const snapshotMeta = {
    source: 'read',
    fileLineCount: lineCount,
    ranges: isFullFileView ? [{ startLine: 1, endLine: Infinity }] : visibleRanges,
    ...(isFullFileView ? { contentHash: fullContentHash } : {}),
    ...(rangeHashes.length > 0 ? { rangeHashes } : {}),
  };
  // For files ≤64KiB the prefix hash equals the full-content hash; otherwise
  // hash the 64KiB head (enough to detect a same-mtime / same-size rewrite of
  // any bytes within the first 64KiB — the common case).
  const head = content.length <= READ_PREFIX_HASH_BYTES ? content : content.slice(0, READ_PREFIX_HASH_BYTES);
  const contentPrefixHash = head === content && fullContentHash ? fullContentHash : _hashText(head);
  return { snapshotMeta, contentPrefixHash };
}

/**
 * The buffered read: body (prefetched or read now) → decode → re-stat →
 * render → cache + raw cache + snapshot.
 */
export async function bufferedReadResult(ctx, { prefetched, readEnc }, helpers) {
  const { fullPath, cacheKey, readStateScope } = ctx;
  const { _cacheSet, _rawContentCacheSet, _recordReadSnapshot } = helpers;
  const rawBuf = prefetched.buf || (await readFile(fullPath));
  const content = decodeReadBuffer(rawBuf, readEnc);
  // W1 M: re-stat after the async readFile so a concurrent Write that landed
  // during the read is detected before the cache + snapshot record stale
  // bytes. A raw-cache hit was already validated against `st`.
  let st = ctx.st;
  let readStableForRawCache = true;
  if (!prefetched.fromCache) {
    let stPostRead;
    try {
      stPostRead = await fsPromises.stat(fullPath);
    } catch {
      stPostRead = st;
    }
    if (stPostRead.mtimeMs !== st.mtimeMs || stPostRead.size !== st.size) {
      st = stPostRead;
      readStableForRawCache = false;
    }
  }
  const render = renderReadWindow(content, { ...ctx, st }, helpers);
  const { snapshotMeta, contentPrefixHash } = bufferedReadSnapshotMeta(content, render, ctx, helpers);
  _cacheSet(cacheKey, render.out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash });
  if (readStableForRawCache) _rawContentCacheSet(fullPath, st, rawBuf);
  _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
  return render.out;
}
