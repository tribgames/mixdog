import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, readdirSync, statSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { normalizeInputPath } from './path-utils.mjs';
import { findFileByBasename } from './path-diagnostics.mjs';
import { getReadSnapshot } from './read-snapshot-runtime.mjs';
import { snapshotCoversFullFile, statMatchesSnapshot } from './snapshot-helpers.mjs';
import { formatBinaryReadPreview } from './binary-file.mjs';

function snapshotBodyWasReturnedByRead(snapshot) {
    return String(snapshot?.source || '').startsWith('read');
}

function withSymbolReadNote(text, args) {
    const note = typeof args?._symbolReadNote === 'string' ? args._symbolReadNote.trim() : '';
    if (!note || typeof text !== 'string') return text;
    return `${note}\n\n${text}`;
}

// BOM-only read-encoding detection. Mirrors CC fileRead.ts:34
// (buffer[0]===0xff && buffer[1]===0xfe -> 'utf16le') / file.ts
// detectFileEncoding. STRICTLY a leading-BOM rule — no content sniffing
// and no heuristic fallback.
// Returns the decoder name plus the BOM byte length to strip before
// decoding. utf8-with-BOM (EF BB BF) keeps the utf-8 decoder; its leading
// U+FEFF is stripped for display downstream, so bomLen is reported but not
// applied for utf8.
function detectReadEncoding(fullPath) {
    let fd;
    try {
        fd = openSync(fullPath, 'r');
        const head = Buffer.alloc(3);
        const n = readSync(fd, head, 0, 3, 0);
        if (n >= 2 && head[0] === 0xff && head[1] === 0xfe) {
            return { encoding: 'utf16le', bomLen: 2 };
        }
        if (n >= 2 && head[0] === 0xfe && head[1] === 0xff) {
            return { encoding: 'utf16be', bomLen: 2 };
        }
        if (n >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
            return { encoding: 'utf8', bomLen: 3 };
        }
        return { encoding: 'utf8', bomLen: 0 };
    } catch {
        return { encoding: 'utf8', bomLen: 0 };
    } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
}

export async function executeSingleReadTool(args, workDir, readStateScope, options = {}, helpers = {}) {
    const {
        appendReadContextAdvisory,
        classifyResultKind,
        extractIpynbText,
        extractPdfText,
        findSimilarFile,
        isBinaryFile,
        isBlockedDevicePath,
        isUncPath,
        isWindowsDevicePath,
        hasUnsafeWin32Component,
        isSpecialFileStat,
        normalizeErrorMessage,
        normalizeOutputPath,
        parseLineLimitArg,
        parseOffsetArg,
        renderReadLine,
        resolveAgainstCwd,
        smartReadTruncate,
        streamReadRange,
        streamSmartReadSummary,
        READ_MAX_OUTPUT_BYTES,
        READ_MAX_SIZE_BYTES,
        READ_SMART_STREAM_MIN_BYTES,
        READ_STREAM_RANGE_MIN_BYTES,
        _cacheGetEntry,
        _cacheSet,
        _hashText,
        _rangeHashesForReadRanges,
        _rangeHashesFromRenderedReadText,
        _rawContentCacheGet,
        _rawContentCacheSet,
        _recordReadSnapshot,
    } = helpers;
    // Normalize path (strip whitespace, expand ~, posix→windows) up front so
    // LLM-injected stray spaces don't trigger an ENOENT retry that pollutes
    // the conversation history and breaks the cache prefix on later turns.
    if (typeof args.path === 'string') args.path = normalizeInputPath(args.path);
    const filePath = args.path;
    if (!filePath)
        return 'Error: path is required.';
    // R1: UNC / SMB share reject (\\server\share, //server/share). Reading
    // these on Windows auto-authenticates to the remote host and leaks the
    // NTLM hash of the current user to any attacker-controlled SMB target.
    // CC parity: FileReadTool.ts:461 rejects the same prefix before stat.
    // Must run before resolveAgainstCwd so a relative path can't be coerced
    // into a UNC share by the cwd resolution.
    if (typeof isUncPath === 'function' && isUncPath(filePath))
        return `Error: cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(filePath)}`;
    // R2: Windows reserved device names (CON / NUL / PRN / AUX / COM[0-9] /
    // LPT[0-9]) and raw-device namespaces (\\.\ and \\?\). These are kernel
    // aliases that never resolve to real files and can hang or grant raw
    // device access regardless of directory.
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(filePath))
        return `Error: cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
    // R12: Win32 component guard. Trailing dot/space or embedded ':' in
    // any path component lets Win32 silently resolve to a different file
    // (stripped dot/space) or an NTFS Alternate Data Stream attached to
    // another file, bypassing the string-based device/UNC checks above.
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(filePath))
        return `Error: cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
    // G6: block device pseudo-files (would hang / produce infinite output).
    if (isBlockedDevicePath(filePath))
        return `Error: cannot read device file (would block or produce infinite output): ${normalizeOutputPath(filePath)}`;
    const fullPath = resolveAgainstCwd(filePath, workDir);
    // R1: re-check the resolved path — `resolveAgainstCwd` could have produced
    // a UNC / Windows device path even when the user-supplied string did not
    // (rare, but possible with custom cwd containing a UNC root).
    if (typeof isUncPath === 'function' && isUncPath(fullPath))
        return `Error: cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(fullPath)}`;
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath))
        return `Error: cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(fullPath)}`;
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath))
        return `Error: cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(fullPath)}`;
    // Pre-read size cap (Anthropic FileReadTool/limits.ts pattern):
    // throw a small error response when the file is too big rather
    // than truncating to 25K tokens of content. Throw is decisively
    // more token-efficient (Anthropic #21841 reverted truncation).
    // Large-file branch: if offset/limit is provided, stream the
    // requested line window instead of throwing (Task B). Without
    // range args the cap still throws so small-file default path
    // can't be weaponised to pull megabytes by accident.
    const hasOffsetArg = args.offset !== undefined && args.offset !== null;
    const hasLimitArg = args.limit !== undefined && args.limit !== null;
    const hasRangeArgs = hasOffsetArg || hasLimitArg;
    const wantFull = args.full === true;
    const offset = parseOffsetArg(args.offset);
    // full:true bypasses the default 2000-line cap so the whole file
    // can be returned in one call; the byte-cap path below still
    // emits a compact truncation marker when rendered bytes overflow
    // READ_MAX_OUTPUT_BYTES.
    const limit = parseLineLimitArg(args.limit, wantFull ? Infinity : 2000);
    let st;
    let _statErr;
    try {
        st = statSync(fullPath);
    } catch (err) {
        // Fall through to the existing similar-file recovery path below.
        st = null;
        _statErr = err;
    }
    if (st) {
        if (st.isDirectory()) {
            let entries = [];
            try {
                entries = readdirSync(fullPath, { withFileTypes: true })
                    .slice(0, 20)
                    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
            } catch { /* best-effort preview */ }
            const preview = entries.length ? `\nentries:\n${entries.map((entry) => `- ${entry}`).join('\n')}` : '';
            return `Error: Directory: ${normalizeOutputPath(filePath)}. Use list/glob to inspect directories; read expects a file.${preview}`;
        }
        // R2: special-file reject AFTER stat. FIFOs, char devices, block
        // devices, and sockets pass a normal stat but reading them either
        // hangs (FIFO with no writer, socket) or produces unbounded output
        // (/dev/zero, /dev/random). Catches arbitrary user paths that point
        // at a special inode (custom mknod, etc.) that the string-based
        // device guard above doesn't know about.
        if (typeof isSpecialFileStat === 'function' && isSpecialFileStat(st))
            return `Error: cannot read special file (FIFO / character / block device / socket): ${normalizeOutputPath(filePath)}`;
        // R1+R2: realpath the resolved path so a symlink → /dev/zero (or any
        // other blocked device, UNC, or Windows reserved name) is caught on
        // the REAL target, not the symlink name. lstatSync detects whether
        // the entry IS a symlink first so realpathSync is only called when
        // it would actually differ — saves a syscall on the common case.
        try {
            const _lst = lstatSync(fullPath);
            if (_lst && typeof _lst.isSymbolicLink === 'function' && _lst.isSymbolicLink()) {
                let _realTarget = null;
                try { _realTarget = realpathSync(fullPath); } catch { _realTarget = null; }
                if (_realTarget && _realTarget !== fullPath) {
                    if (isBlockedDevicePath(_realTarget))
                        return `Error: cannot read device file via symlink (would block or produce infinite output): ${normalizeOutputPath(filePath)} → ${normalizeOutputPath(_realTarget)}`;
                    if (typeof isUncPath === 'function' && isUncPath(_realTarget))
                        return `Error: cannot read UNC / SMB path via symlink (network credential leak risk): ${normalizeOutputPath(filePath)} → ${normalizeOutputPath(_realTarget)}`;
                    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(_realTarget))
                        return `Error: cannot read Windows device path via symlink (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)} → ${normalizeOutputPath(_realTarget)}`;
                    // Re-run the special-file stat on the real target — the
                    // symlink itself was already checked above via `st`, but
                    // the target stat could differ from the link stat in
                    // pathological cases (replaced under us).
                    try {
                        const _rst = statSync(_realTarget);
                        if (typeof isSpecialFileStat === 'function' && isSpecialFileStat(_rst))
                            return `Error: cannot read special file via symlink (FIFO / character / block device / socket): ${normalizeOutputPath(filePath)} → ${normalizeOutputPath(_realTarget)}`;
                    } catch { /* if the target is gone, let the normal path surface ENOENT */ }
                }
            }
        } catch { /* lstat failure is non-fatal; the original `st` is authoritative */ }
    }
    if (!st) {
        const err = _statErr;
        const similar = findSimilarFile(fullPath);
        let hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
        // Right-name / wrong-directory miss: findSimilarFile only checks the
        // same dir. Locate the basename elsewhere in the tree and name the real
        // path(s) directly — the route a model would otherwise reconstruct with
        // a grep/glob storm.
        if (!similar) {
            const elsewhere = findFileByBasename(workDir, fullPath);
            if (elsewhere.length) {
                hint = ` Not found at this path; the same filename exists at: ${elsewhere.map((p) => `"${normalizeOutputPath(p)}"`).join(', ')}. Read that path directly.`;
            }
        }
        const _rawMsg = err instanceof Error ? err.message : String(err);
        const _safeMsg = normalizeErrorMessage(_rawMsg, workDir);
        return `Error: ${_safeMsg}${hint}`;
    }
    // MEDIA-WINS: .pdf/.ipynb dispatch runs BEFORE any cache/snapshot fast
    // path. A media file previously read as text can carry a stale result-
    // cache or read-snapshot entry; returning that cached TEXT instead of the
    // fresh media shape (PDF document block / ipynb content-block array) is
    // wrong — media must win. Hoisted here, right after the UNC/device/ADS
    // guards + stat but before _cacheGetEntry / getReadSnapshot, so neither
    // fast path can short-circuit a media read. extractPdfText /
    // extractIpynbText own their size handling internally (PDF >20MB → text
    // fallback via PDF_DOCUMENT_MAX_BYTES, page-range filter, ipynb range
    // refusal), so this single early dispatch supersedes the old >10MiB media
    // lines and the old post-cache media lines without bypassing those
    // decisions. mediaTextOnly (batch dispatcher) must produce a flat string,
    // never a content-block object, so a batch aggregate's String()+join can't
    // stringify it to "[object Object]"; scalar reads leave it unset and get
    // the rich block shapes.
    const _mediaTextOnly = options?.mediaTextOnly === true;
    const _mediaExt = extname(fullPath).toLowerCase();
    if (_mediaExt === '.pdf') return extractPdfText(fullPath, args.pages, { maxOutputBytes: READ_MAX_OUTPUT_BYTES, textOnly: _mediaTextOnly });
    if (_mediaExt === '.ipynb') {
        const _ipynbOut = await extractIpynbText(fullPath, { maxOutputBytes: READ_MAX_OUTPUT_BYTES, hasRangeArgs: hasRangeArgs || args.line !== undefined, textOnly: _mediaTextOnly });
        // Record a full-file read snapshot for cache/read-state consistency.
        // Skipped on an Error string (no real read).
        if (typeof _ipynbOut !== 'string' || !_ipynbOut.startsWith('Error:')) {
            _recordReadSnapshot(fullPath, st, readStateScope, { source: 'read', replaceExisting: true });
        }
        return _ipynbOut;
    }
    const cacheKey = `read|${fullPath}|${st.mtimeMs}|${st.size}|${hasOffsetArg ? offset : 'd'}|${hasLimitArg ? limit : 'd'}|${wantFull ? 'f' : 's'}`;
    // Race-guard helper: same-mtime same-size rapid rewrite (NTFS / exFAT 1 s
    // resolution) can pass mtimeMs+size yet differ in content. When the cache
    // entry stores a contentPrefixHash, recompute the current prefix and bail
    // to a fresh read on mismatch. Helper kept local (not hoisted) so it can
    // close over fullPath and st without an extra arg.
    const _readPrefixHashForCacheGuard = () => {
        try {
            if (st.size <= 65536) {
                return _hashText(readFileSync(fullPath, 'utf-8'));
            }
            const _fd = openSync(fullPath, 'r');
            try {
                const _buf = Buffer.allocUnsafe(65536);
                const _n = readSync(_fd, _buf, 0, 65536, 0);
                return _hashText(_buf.subarray(0, _n));
            } finally { try { closeSync(_fd); } catch {} }
        } catch { return ''; }
    };
    const cachedEntry = _cacheGetEntry(cacheKey);
    if (cachedEntry !== null) {
        let _entryStillValid = true;
        // Single-pass cache-hit guard. The cache key already pins
        // mtimeMs+size, so a hit means only a same-mtime/same-size rewrite
        // (NTFS / exFAT 1 s resolution) could differ — caught by re-hashing
        // the on-disk body. Previously this ran as two passes: a 64KiB
        // prefix-hash guard, then a separate full-content guard that
        // re-read the whole file again. For ≤64KiB files contentPrefixHash
        // and contentHash are computed over the identical body at the read
        // result-cache set sites (:360 and :367) and are byte-equal by
        // construction, so the two passes read+hashed the same bytes twice
        // for nothing. Collapse to one read + one hash per hit.
        const _prefixHash = cachedEntry.contentPrefixHash;
        const _snapHash = cachedEntry.readSnapshotMeta?.contentHash;
        if (_prefixHash || _snapHash) {
            if (st.size <= 65536) {
                // ≤64KiB: one full-body read validates whichever hash the
                // entry carries — prefix == full at this size. Prefer the
                // exact full contentHash when present, else the prefix hash
                // (also full-body here). A read failure drops to fresh read.
                try {
                    const _freshHash = _hashText(readFileSync(fullPath, 'utf-8'));
                    const _expect = _snapHash || _prefixHash;
                    if (!_freshHash || _freshHash !== _expect) _entryStillValid = false;
                } catch { _entryStillValid = false; }
            } else if (_prefixHash) {
                // >64KiB: contentHash may still be stored (full-file reads
                // keep it up to the 10MB read cap), but validating it here
                // means a synchronous full-content sha that blocks the main
                // thread on a multi-megabyte body every cache check — so the
                // validation, not the storage, is size-gated: for >64KiB only
                // the 64KiB head prefix is checked. It catches same-mtime/
                // same-size rewrites within the first 64KiB (the common case);
                // writes through edit/apply_patch/write invalidate by path,
                // and shell mutationMode='global' wipes both builtin +
                // code-graph caches, bounding stale risk past the head.
                const _curHash = _readPrefixHashForCacheGuard();
                if (!_curHash || _curHash !== _prefixHash) _entryStillValid = false;
            }
        }
        if (_entryStillValid) {
            // Cross-session stub guard: RESULT_CACHE is process-global, so a
            // cache hit can be an entry SET BY ANOTHER SESSION whose body this
            // conversation never received. The file_unchanged stub assumes the
            // full body is already in a prior tool_result of THIS session — only
            // true when a session-scoped snapshot exists, matches the current
            // stat, and was itself produced by a body-returning read. Probe that
            // BEFORE recording the snapshot below (which would otherwise mark the
            // file as body-returned and mask the cross-session case). A null
            // readStateScope has no session evidence, so it always fails the gate
            // and falls through to the full cached body.
            const _sessionSnap = readStateScope ? getReadSnapshot(fullPath, readStateScope) : null;
            const _stubBodyAlreadySent = !!_sessionSnap
                && statMatchesSnapshot(st, _sessionSnap)
                && snapshotBodyWasReturnedByRead(_sessionSnap)
                // Range-coverage guard: snapshotBodyWasReturnedByRead only
                // proves SOME body was returned, not WHICH lines. A session
                // that read just lines 1-10 (ranged, source 'read', stat
                // matches) must NOT get an unchanged stub on a later full
                // read whose body it never saw — another session's full read
                // populated the global cache. For a full-file read require
                // the session snapshot to cover the whole file. For a ranged
                // read there is no requested-window-coverage helper
                // (snapshotRangesCoverAllLines checks ALL lines, not the
                // window), so conservatively require full coverage there too:
                // failing the gate only falls through to the full cached body
                // (a few extra tokens), which is never incorrect. The
                // path-snapshot fallback at the size-gated branch below
                // already requires snapshotCoversFullFile for this reason.
                && snapshotCoversFullFile(_sessionSnap);
            _recordReadSnapshot(fullPath, st, readStateScope, cachedEntry.readSnapshotMeta || { source: 'read_cached' });
            // G6: file_unchanged stub. The full body is already in the
            // prior tool_result; resending it wastes cache_creation
            // tokens (Claude Code upstream measured ~18% on Read calls).
            // The stub keeps the snapshot tracking intact (Edit
            // validation still works) while collapsing the response
            // payload. Falls back to the full body when the cached
            // value is itself a stub-incompatible error string, or when
            // this session has no body-returned snapshot proving it saw the
            // body (cross-session cache hit — emit the full cached body so
            // the recorded snapshot above is honestly body-returned here).
            const _cachedVal = cachedEntry.value;
            if (typeof _cachedVal === 'string' && classifyResultKind(_cachedVal) !== 'error') {
                if (_stubBodyAlreadySent && options?.suppressReadUnchangedStub !== true) {
                    return withSymbolReadNote(`[file unchanged: ${normalizeOutputPath(filePath)}]`, args);
                }
            }
            return withSymbolReadNote(_cachedVal, args);
        }
        // Race detected — fall through to fresh read below.
    }
    // Path-snapshot fallback: exact cache-key hits above can still collapse
    // duplicate reads. Size-gate the fallback so a missing cache entry never
    // hashes a large file just to emit an unchanged stub.
    if (!hasRangeArgs && st.size <= 65536) {
        const _snap = getReadSnapshot(fullPath, readStateScope);
        if (_snap
            && statMatchesSnapshot(st, _snap)
            && snapshotCoversFullFile(_snap)
            && snapshotBodyWasReturnedByRead(_snap)
            && typeof _snap.contentHash === 'string'
            && _snap.contentHash) {
            let _diskHash = '';
            try { _diskHash = _hashText(readFileSync(fullPath, 'utf-8')); } catch {}
            if (_diskHash && _diskHash === _snap.contentHash) {
                if (options?.suppressReadUnchangedStub !== true) {
                    return withSymbolReadNote(`[file unchanged: ${normalizeOutputPath(filePath)}]`, args);
                }
            }
        }
    }
    // BOM-only encoding detection runs BEFORE the >10MiB size branch so a
    // large UTF-16LE+BOM file is recognized as text up front and routed to
    // the bounded in-memory utf16le path below, never mis-decoded as utf-8
    // or rejected by the utf-8 streaming/binary branch (Bug 1).
    const _readEnc = detectReadEncoding(fullPath);
    // UTF-16 (LE or BE) reads share one constraint: the streaming/binary
    // paths decode chunks as utf-8, so a BOM-flagged UTF-16 file must route
    // to the bounded in-memory decode below regardless of byte order.
    const _isUtf16 = _readEnc.encoding === 'utf16le' || _readEnc.encoding === 'utf16be';
    if (st.size > READ_MAX_SIZE_BYTES) {
        // .pdf/.ipynb were already dispatched up front (MEDIA-WINS), so this
        // >10MiB branch only handles the non-media text path from here on.
        // utf16le bound (Bug 2): utf16le reads route through a single
        // in-memory full read+decode+split (streamReadRange is gated off
        // for utf16le because it decodes chunks as utf-8). Keep that one
        // path but cap it — a >10MiB utf16le file would otherwise be
        // unbounded in memory or mis-routed into the utf-8 stream/binary
        // branch. Refuse so utf16le memory is always <= READ_MAX_SIZE_BYTES.
        if (_isUtf16) {
            return `Error: UTF-16 file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES} bytes; utf16 ranged reads are bounded — convert to UTF-8 or narrow the range.`;
        }
        if (!hasRangeArgs) {
            return `Error: file size ${st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap.`;
        }
        if (isBinaryFile(fullPath, st.size)) {
            const { text, snapshotMeta } = formatBinaryReadPreview(fullPath, normalizeOutputPath(filePath), st.size);
            _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
            _cacheSet(cacheKey, text, { paths: [fullPath], readSnapshotMeta: snapshotMeta });
            return withSymbolReadNote(text, args);
        }
        try {
            const _streamRes = await streamReadRange(fullPath, offset, limit, st, { displayPath: filePath });
            const out = _streamRes.text;
            // W1 H: snapshot only emitted line bounds, not the
            // requested window — byte-cap truncation can stop short.
            const _emittedRanges = (_streamRes.firstEmitted && _streamRes.lastEmitted)
                ? [{ startLine: _streamRes.firstEmitted, endLine: _streamRes.lastEmitted }]
                : [];
            const snapshotMeta = {
                source: 'read',
                ranges: _emittedRanges,
                // D-R1-1: rangeHash covers the exact text returned so
                // _isSnapshotStale can detect same-mtime+same-size
                // rewrites within the read window at edit time.
                // Fix J-1 (b): hash raw line text, not rendered
                // "N\ttext" form, to match _isSnapshotStale which
                // hashes _lines.slice().join('\n') (raw content).
                // Strip the rendered line-number prefix from each
                // returned line before hashing so both sides match.
                rangeHashes: _rangeHashesFromRenderedReadText(out, _emittedRanges),
            };
            // Compute prefix hash for race-guard on next cache hit.
            // Async to avoid blocking the event loop on a 64KB read
            // for every large-file streaming path.
            const _streamPrefixHash = _streamRes.prefixHash || await (async () => {
                try {
                    if (st.size <= 65536) return _hashText(await readFile(fullPath, 'utf-8'));
                    const fh = await fsPromises.open(fullPath, 'r');
                    try {
                        const _buf = Buffer.allocUnsafe(65536);
                        const _readRes = await fh.read(_buf, 0, 65536, 0);
                        return _hashText(_buf.subarray(0, _readRes.bytesRead));
                    } finally { await fh.close().catch(() => {}); }
                } catch { return ''; }
            })();
            _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _streamPrefixHash });
            _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
            return withSymbolReadNote(out, args);
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    // Non-text special formats (.pdf/.ipynb) were intercepted up front
    // (MEDIA-WINS, before the cache/snapshot fast paths), so the binary check
    // below only ever sees the non-media text path.
    // BOM-only encoding peek BEFORE the binary/NUL check. A UTF-16LE+BOM
    // file is full of 0x00 bytes (the high byte of every ASCII char), so
    // isBinaryFile would wrongly reject it. The FF FE BOM is an
    // unambiguous TEXT signal, so classify it as utf16le up front and skip
    // NUL rejection. (_readEnc was detected above, before the >10MiB size
    // branch, so the large-file path can classify utf16le.)
    if (!_isUtf16 && isBinaryFile(fullPath, st.size)) {
        const { text, snapshotMeta } = formatBinaryReadPreview(fullPath, normalizeOutputPath(filePath), st.size);
        _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
        _cacheSet(cacheKey, text, { paths: [fullPath], readSnapshotMeta: snapshotMeta });
        return withSymbolReadNote(text, args);
    }
    // Whole-file reads above READ_WHOLE_FILE_MAX_BYTES use stream smart-elide
    // (then READ_MAX_OUTPUT_BYTES truncation) instead of refusing. Absolute
    // in-memory ceiling remains READ_MAX_SIZE_BYTES (10 MiB) above.
    // The streaming paths (smart-summary + range) decode chunks as utf-8;
    // a utf16le file must instead fall through to the encoding-aware
    // in-memory regular read below, which still runs smartReadTruncate so
    // smart-elide stays intact. utf-8 keeps the streaming fast path.
    if (!_isUtf16 && !hasRangeArgs && !wantFull && st.size >= READ_SMART_STREAM_MIN_BYTES) {
        try {
            const _streamSmart = typeof streamSmartReadSummary === 'function'
                ? await streamSmartReadSummary(fullPath, st, 'read_smart_stream')
                : null;
            if (_streamSmart?.text) {
                const out = _streamSmart.text;
                const snapshotMeta = _streamSmart.snapshotMeta || {
                    source: 'read_smart_stream',
                    ranges: [],
                };
                const _streamPrefixHash = _streamSmart.prefixHash || await (async () => {
                    try {
                        if (st.size <= 65536) return _hashText(await readFile(fullPath, 'utf-8'));
                        const fh = await fsPromises.open(fullPath, 'r');
                        try {
                            const _buf = Buffer.allocUnsafe(65536);
                            const _readRes = await fh.read(_buf, 0, 65536, 0);
                            return _hashText(_buf.subarray(0, _readRes.bytesRead));
                        } finally { await fh.close().catch(() => {}); }
                    } catch { return ''; }
                })();
                _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _streamPrefixHash });
                _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
                return withSymbolReadNote(out, args);
            }
        } catch {
            // Fall through to the regular read path; it still enforces output caps.
        }
    }
    if (!_isUtf16 && hasRangeArgs && !wantFull && st.size > READ_STREAM_RANGE_MIN_BYTES) {
        try {
            const _streamRes = await streamReadRange(fullPath, offset, limit, st, { displayPath: filePath });
            const out = _streamRes.text;
            const _emittedRanges = (_streamRes.firstEmitted && _streamRes.lastEmitted)
                ? [{ startLine: _streamRes.firstEmitted, endLine: _streamRes.lastEmitted }]
                : [];
            const snapshotMeta = {
                source: 'read_stream_range',
                ranges: _emittedRanges,
                rangeHashes: _rangeHashesFromRenderedReadText(out, _emittedRanges),
            };
            const _streamPrefixHash = _streamRes.prefixHash || await (async () => {
                try {
                    if (st.size <= 65536) return _hashText(await readFile(fullPath, 'utf-8'));
                    const fh = await fsPromises.open(fullPath, 'r');
                    try {
                        const _buf = Buffer.allocUnsafe(65536);
                        const _readRes = await fh.read(_buf, 0, 65536, 0);
                        return _hashText(_buf.subarray(0, _readRes.bytesRead));
                    } finally { await fh.close().catch(() => {}); }
                } catch { return ''; }
            })();
            _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _streamPrefixHash });
            _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
            return withSymbolReadNote(out, args);
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    try {
        const cachedRawBuf = _rawContentCacheGet ? _rawContentCacheGet(fullPath, st) : null;
        const rawBuf = cachedRawBuf || await readFile(fullPath);
        // Encoding-aware decode (fresh read AND raw-content cache hit both
        // flow through here). For a BOM-flagged UTF-16LE file, strip the
        // 2-byte FF FE BOM and decode as utf16le so it reverses the write
        // tool's preservation; utf-8 stays byte-identical to before (the
        // leading U+FEFF of a utf8-BOM file is stripped later at the
        // line[0] charCodeAt check for display).
        // UTF-16BE has no Node string encoding: swap byte pairs to LE (swap16
        // needs an even length) then decode as utf16le, so a BE file reverses
        // the same way a LE file does.
        let content;
        if (_readEnc.encoding === 'utf16le') {
            content = rawBuf.subarray(_readEnc.bomLen).toString('utf16le');
        } else if (_readEnc.encoding === 'utf16be') {
            const _body = rawBuf.subarray(_readEnc.bomLen);
            const _even = _body.length & ~1;
            content = Buffer.from(_body.subarray(0, _even)).swap16().toString('utf16le');
        } else {
            content = rawBuf.toString('utf-8');
        }
        // W1 M: re-stat after the async readFile so a concurrent
        // Write that landed during the read is detected before
        // the cache + snapshot record stale bytes.
        let _stPostRead;
        let _readStableForRawCache = true;
        if (cachedRawBuf) {
            _stPostRead = st;
        } else {
            try { _stPostRead = await fsPromises.stat(fullPath); } catch { _stPostRead = st; }
            if (_stPostRead.mtimeMs !== st.mtimeMs || _stPostRead.size !== st.size) {
                st = _stPostRead;
                _readStableForRawCache = false;
            }
        }
        const lines = content.split(/\r?\n/);
        if (lines.length > 0 && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].slice(1);
        // wc-l compatible line count: a trailing newline ends a line, it
        // does not start a new empty one. Display count must match the
        // count emitted by mode:"count" so footer and count agree.
        const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        const renderEnd = (!hasRangeArgs && !wantFull)
            ? lineCount
            : Math.min(offset + limit, lineCount);
        const sliced = lines.slice(offset, renderEnd);
        const rendered = sliced
            .map((line, i) => renderReadLine(offset + i + 1, line, { truncateLongLine: !wantFull }))
            .join('\n');
        // Output byte cap protects against many-line slices that
        // individually pass the file-size check but explode after
        // line-number prefixing.
        let out;
        // W1 H: track lines actually rendered so the snapshot below
        // doesn't mark byte-cap-truncated lines as editable.
        let _renderedLineCount = sliced.length;
        // W1 H: byte-cap truncation drops trailing lines the model never
        // saw. Track it so isFullFileView below records partial coverage
        // (rangeHashes over the visible window) instead of a full-file
        // contentHash — otherwise snapshotCoversFullFile would wrongly
        // green-light an overwrite against bytes the read never returned.
        let _byteCapTruncated = false;
        const smart = (!hasRangeArgs && !wantFull && typeof smartReadTruncate === 'function')
            ? smartReadTruncate(rendered, lineCount, st.size, filePath)
            : null;
        let _smartTruncated = false;
        let _smartVisibleRanges = null;
        if (smart?.truncated) {
            out = smart.text;
            _smartTruncated = true;
            _smartVisibleRanges = Array.isArray(smart.ranges) ? smart.ranges : null;
            _renderedLineCount = 0;
        } else if (Buffer.byteLength(rendered, 'utf8') > READ_MAX_OUTPUT_BYTES) {
            let lo = 0;
            let hi = rendered.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (Buffer.byteLength(rendered.slice(0, mid), 'utf8') <= READ_MAX_OUTPUT_BYTES) lo = mid;
                else hi = mid - 1;
            }
            const slice = rendered.slice(0, lo);
            const completeRenderedLines = Math.max(0, slice.split('\n').length - 1);
            _renderedLineCount = completeRenderedLines;
            _byteCapTruncated = true;
            out = slice + `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
        } else {
            out = rendered;
        }
        if (hasRangeArgs) {
            if (sliced.length === 0 && offset >= lineCount) {
                out = `(no lines in range; file has ${lineCount} lines)`;
            } else if (_byteCapTruncated) {
                const emittedStart = offset + 1;
                const emittedEnd = offset + _renderedLineCount;
                const capKb = Math.round(READ_MAX_OUTPUT_BYTES / 1024);
                const footer = `[lines ${emittedStart}-${emittedEnd} of ${lineCount}; output truncated at ${capKb} KB${emittedEnd < lineCount ? `; pass offset:${emittedEnd} to continue` : ''}]`;
                out += `${out ? '\n' : ''}${footer}`;
            } else if (Buffer.byteLength(rendered, 'utf8') <= READ_MAX_OUTPUT_BYTES) {
                const emittedStart = offset + 1;
                const emittedEnd = offset + sliced.length;
                const footer = `[lines ${emittedStart}-${emittedEnd} of ${lineCount}${emittedEnd < lineCount ? `; pass offset:${emittedEnd} to continue` : ''}]`;
                out += `${out ? '\n' : ''}${footer}`;
            }
        }
        // Smart cap. Only engages when the caller asked for
        // the default read (no offset/limit, full:false) AND the file
        // is over the line/byte threshold. Explicit ranges always see
        // byte-exact output.
        // W1 H: smart-middle elision drops lines the model never
        // saw — don't claim full-file coverage when it triggered.
        if (!hasRangeArgs && !wantFull) {
            if (!_smartTruncated && content.length > 0) {
                out = appendReadContextAdvisory(out, { filePath, lineCount, bytes: st.size });
            }
        }
        // CC parity: empty file gets a system-reminder instead of
        // a bare `1│` line. The reminder makes the empty-state
        // explicit so the agent doesn't assume content was elided.
        if (content.length === 0) {
            // W1 M: filename can contain `<` or `</system-reminder>`
            // sequences; XML-escape before interpolation so a hostile
            // path can't terminate the envelope and inject markup.
            const _safePath = normalizeOutputPath(filePath)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            out = `<system-reminder>File exists but has empty contents: ${_safePath}</system-reminder>`;
        }
        const isFullFileView = offset === 0 && offset + limit >= lineCount && !_smartTruncated && !_byteCapTruncated;
        const _visibleRanges = _smartTruncated && _smartVisibleRanges
            ? _smartVisibleRanges
            : (_renderedLineCount > 0
                ? [{ startLine: offset + 1, endLine: Math.min(lineCount, offset + _renderedLineCount) }]
                : []);
        const _rangeHashes = !isFullFileView ? _rangeHashesForReadRanges(content, _visibleRanges) : [];
        // Hash the full body once when the whole file is in view: both the
        // snapshot contentHash and (for ≤64KiB) the race-guard prefix hash
        // are SHA-256 over the identical `content`, so computing it twice
        // here was pure duplicate CPU on the common small full-file read.
        const _fullContentHash = isFullFileView ? _hashText(content) : '';
        const snapshotMeta = {
            source: 'read',
            fileLineCount: lineCount,
            ranges: isFullFileView
                ? [{ startLine: 1, endLine: Infinity }]
                : _visibleRanges,
            ...(isFullFileView ? { contentHash: _fullContentHash } : {}),
            ...(_rangeHashes.length > 0 ? { rangeHashes: _rangeHashes } : {}),
        };
        // Race-guard prefix hash. content is the full file body here
        // (regular branch, st.size <= READ_MAX_SIZE_BYTES). For files
        // ≤64KiB the prefix hash equals the full-content hash, so reuse
        // _fullContentHash when it was computed; otherwise hash the 64KiB
        // head (sufficient to detect a same-mtime / same-size rewrite of
        // any bytes within the first 64KiB — the common case).
        const _regPrefixHash = (content.length <= 65536 && _fullContentHash)
            ? _fullContentHash
            : _hashText(content.length <= 65536 ? content : content.slice(0, 65536));
        _cacheSet(cacheKey, out, { paths: [fullPath], readSnapshotMeta: snapshotMeta, contentPrefixHash: _regPrefixHash });
        if (_readStableForRawCache) _rawContentCacheSet(fullPath, st, rawBuf);
        _recordReadSnapshot(fullPath, st, readStateScope, snapshotMeta);
        return withSymbolReadNote(out, args);
    }
    catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
}
