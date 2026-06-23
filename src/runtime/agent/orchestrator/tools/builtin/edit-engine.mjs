import { readFileSync, statSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { performance } from 'perf_hooks';
import { markCodeGraphDirtyPaths } from '../code-graph.mjs';
import {
    diagnoseFoldTierAmbiguity as _diagnoseFoldTierAmbiguity,
    findActualString as _findActualString,
    stripTrailingWhitespacePerLine as _stripTrailingWhitespacePerLine,
    stripTrailingWhitespaceForEdit as _stripTrailingWhitespaceForEdit,
    preserveQuoteTypography as _preserveQuoteTypography,
    formatStageInline as _formatStageInline,
    formatStageNote as _formatStageNote,
} from '../edit-normalize.mjs';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { createMutationContentCache, isValidUtf8Buffer as _isValidUtf8Buffer } from '../mutation-content-cache.mjs';
import {
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import {
    findSimilarFile,
    normalizeErrorMessage,
} from './path-diagnostics.mjs';
import { normalizePathAndStripLineCoordinate } from './read-args.mjs';
import {
    withBuiltinPathLocks,
    withPathLock as _withPathLock,
} from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { hashText as _hashText } from './hash-utils.mjs';
import { statMatchesSnapshot as _statMatchesSnapshot } from './snapshot-helpers.mjs';
import {
    invalidateBuiltinResultCache,
    getPathMutationGeneration as _getPathMutationGeneration,
    rawContentCacheGet as _rawContentCacheGet,
    seedRawContentCacheAfterWrite as _seedRawContentCacheAfterWrite,
} from './cache-layers.mjs';
import {
    getReadSnapshot as _getReadSnapshot,
    isSnapshotStale as _isSnapshotStale,
    readContentIfSnapshotHashMatches as _readContentIfSnapshotHashMatches,
    recordReadSnapshot as _recordReadSnapshot,
} from './read-snapshot-runtime.mjs';
import {
    captureStableBaseStatSnapshot as _captureStableBaseStatSnapshot,
    captureExpectedTargetSnapshot as _captureExpectedTargetSnapshot,
    materialiseByteReplacements as _materialiseByteReplacements,
} from './edit-byte-utils.mjs';
import {
    nativeEditShouldAttempt as _nativeEditShouldAttempt,
    runNativeExactEdit as _runNativeExactEdit,
} from './native-edit-runner.mjs';
import {
    countLiteralOccurrences as _countLiteralOccurrences,
    findCrlfNormalisedMatches as _findCrlfNormalisedMatches,
    findLiteralOccurrenceState as _findLiteralOccurrenceState,
    formatMatchLines as _formatMatchLines,
    occurrenceLinesCrlf as _occurrenceLinesCrlf,
    occurrenceLinesPlain as _occurrenceLinesPlain,
    replacementForOriginalSlice as _replacementForOriginalSlice,
    replaceRangesFromOriginal as _replaceRangesFromOriginal,
    replaceSingleLiteralAt as _replaceSingleLiteralAt,
    validateEditChunkSize as _validateEditChunkSize,
} from './edit-match-utils.mjs';
import {
    diagnoseBatchPeers as _diagnoseBatchPeers,
    editNeedleEncodingNote as _editNeedleEncodingNote,
} from './edit-diagnostics.mjs';
import {
    countLfInString as _countLfInString,
    maybeAutoStripLineNumberPrefixes as _maybeAutoStripLineNumberPrefixes,
    postEditSnapshotMeta as _postEditSnapshotMeta,
    shiftSnapshotRangesForEdit as _shiftSnapshotRangesForEdit,
    lineRangeForSubstring as _lineRangeForSubstring,
} from './edit-context-utils.mjs';
import {
    tryBuildExactEditBuffer as _tryBuildExactEditBufferImpl,
    tryBuildMultiExactEditBuffer as _tryBuildMultiExactEditBufferImpl,
} from './edit-byte-plan.mjs';
import { tryWriteSameSizeByteReplacementsSync as _tryWriteSameSizeByteReplacementsSyncImpl } from './edit-partial-write.mjs';
import {
    buildStaleEditRecovery as _buildStaleEditRecovery,
    editFailureContextHint as _editFailureContextHint,
    primeReadSnapshotForEdit as _primeReadSnapshotForEdit,
} from './edit-failure-context.mjs';
import { validatePreparedEditBase as _validatePreparedEditBase } from './edit-base-guard.mjs';
import {
    commitPreparedEditCheckedUnlocked as _commitPreparedEditCheckedUnlockedImpl,
    commitPreparedEditUnlocked as _commitPreparedEditUnlockedImpl,
} from './edit-commit.mjs';
import { atomicWrite } from './atomic-write.mjs';
import {
    hasUnsafeWin32Component,
    isWindowsDevicePath,
} from './device-paths.mjs';
import { assertEditTargetUtf8 as _assertEditTargetUtf8 } from './edit-utf8-guard.mjs';
import { attemptStaleEditAutoRefresh as _attemptStaleEditAutoRefresh } from './edit-stale-refresh.mjs';

function _optionalEditMissDetails(content, oldString) {
    return _editNeedleEncodingNote(content, oldString);
}

function _foldTierAmbiguityError(content, oldString, filePath, editPrefix = '', peerArgs = null) {
    const amb = _diagnoseFoldTierAmbiguity(content, oldString);
    if (!amb || amb.count <= 1) return null;
    const stageNote = _formatStageInline(amb.stage);
    return `Error [code 9]: ${editPrefix}old_string found ${amb.count} times in ${filePath}${stageNote};${_formatMatchLines(amb.lines, amb.count)} set replace_all:true or provide more unique context${peerArgs ? _diagnoseBatchPeers(...peerArgs) : ''}`;
}

function _ioTraceEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_IO_TRACE || ''));
}

function _ioTraceStart() {
    return _ioTraceEnabled() ? performance.now() : 0;
}

function _ioTrace(event, fields = {}) {
    if (!_ioTraceEnabled()) return;
    try {
        process.stderr.write(`[io-trace] ${JSON.stringify({
            event,
            ts: Date.now(),
            ...fields,
        })}\n`);
    } catch {}
}

function _ioTraceDone(event, started, fields = {}) {
    if (!started || !_ioTraceEnabled()) return;
    _ioTrace(event, {
        ...fields,
        ms: Number((performance.now() - started).toFixed(3)),
    });
}

function _editTraceEnabled() {
    return _ioTraceEnabled() || /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_EDIT_TRACE || ''));
}

function _editTrace(event, fields = {}) {
    if (!_editTraceEnabled()) return;
    try {
        process.stderr.write(`[edit-trace] ${JSON.stringify({
            event,
            ts: Date.now(),
            ...fields,
        })}\n`);
    } catch {}
}

function _editPathTrace(event, filePath, fields = {}) {
    if (!_editTraceEnabled()) return;
    _editTrace(event, {
        path: normalizeOutputPath(filePath),
        ...fields,
    });
}

function _loadEditTargetBytes(fullPath) {
    try {
        const rawBuf = readFileSync(fullPath);
        if (!Buffer.isBuffer(rawBuf)) return null;
        return { rawBuf, content: rawBuf.toString('utf-8') };
    } catch {
        return null;
    }
}

/** Authoritative target bytes while the path lock is held (cold-path TOCTOU guard). */
function _readEditTargetBytesUnderLock(fullPath, filePath, traceReason = null, mode = 'single') {
    const loaded = _loadEditTargetBytes(fullPath);
    if (!loaded) return null;
    if (traceReason) {
        _editPathTrace('edit_lock_cold_reread', filePath, { mode, reason: traceReason });
    }
    return loaded;
}

function _tryStaleSnapshotAutoRefresh({
    fullPath,
    filePath,
    scope,
    stat,
    readRanges,
    oldStrings,
    readCache,
    recordPreviewSnapshot = false,
}) {
    const refreshed = _attemptStaleEditAutoRefresh({
        fullPath,
        filePath,
        scope,
        stat,
        readRanges,
        oldStrings,
        readCache,
        recordPreviewSnapshot,
    });
    if (!refreshed) return null;
    if (refreshed.ok === false && typeof refreshed.error === 'string') {
        return { error: refreshed.error };
    }
    if (refreshed.ok === true && typeof refreshed.content === 'string' && Buffer.isBuffer(refreshed.rawBuf)) {
        return { content: refreshed.content, rawBuf: refreshed.rawBuf };
    }
    return null;
}

function _tryBuildExactEditBuffer(rawBuf, oldStr, newStr, replaceAll, snapshot, filePath) {
    return _tryBuildExactEditBufferImpl(rawBuf, oldStr, newStr, replaceAll, snapshot, filePath);
}

function _tryBuildMultiExactEditBuffer(rawBuf, edits, args, snapshot, filePath) {
    return _tryBuildMultiExactEditBufferImpl(rawBuf, edits, args, snapshot, filePath);
}

// Edit input normalization helpers (_normalizeForMatch, _nfcFoldMatch,
// _findActualString, _stripTrailingWhitespacePerLine, _formatStageInline,
// _formatStageNote) extracted to ./edit-normalize.mjs — see import at top
// of file. Pipeline: byte-exact → exact → curly-quote fold → nfc-fold →
// rstrip-fold → indent-fold → eol-fold (edit-normalize; last-resort + code 9)
// → crlf-fold (engine slow-path).

const _partialWriteHooks = {
    ioTraceStart: _ioTraceStart,
    ioTraceDone: _ioTraceDone,
    validatePreparedEditBase: (...args) => _validatePreparedEditBase(...args),
};

function _tryWriteSameSizeByteReplacementsSync(fullPath, replacements, options = {}) {
    return _tryWriteSameSizeByteReplacementsSyncImpl(fullPath, replacements, options, _partialWriteHooks);
}

async function _prepareMultiEdit(args, workDir, readStateScope, _pathOpts, _options = {}) {
    args.path = normalizePathAndStripLineCoordinate(args.path, workDir);
    const filePath = args.path;
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!filePath) return { ok: false, error: 'Error: path is required' };
    if (edits.length === 0) return { ok: false, error: 'Error: edits array is required' };
    // R12: Win32 component guard — reject trailing dot/space or NTFS ADS
    // suffix (foo.txt:ads) and reserved device names (NUL, CON, …) before
    // resolve so a relative path can't be coerced into a device alias.
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(filePath)) {
        return { ok: false, error: `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}` };
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(filePath)) {
        return { ok: false, error: `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}` };
    }
    const fullPath = resolveAgainstCwd(filePath, workDir);
    // R1: short-circuit UNC/SMB paths before ANY stat/read on the edit
    // target to prevent NTLM credential leakage via implicit network
    // auth. Mirrors CC FileEditTool.ts:176.
    if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
        return { ok: false, error: `Error: UNC/SMB paths are not supported (R1: NTLM-leak prevention): ${filePath}` };
    }
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath)) {
        return { ok: false, error: `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}` };
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath)) {
        return { ok: false, error: `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}` };
    }
    let mEditStat;
    try { mEditStat = statSync(fullPath); }
    catch (err) {
        if (err && err.code === 'ENOENT') {
            const similar = findSimilarFile(fullPath);
            const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
            return { ok: false, error: `Error [code 4]: file not found: ${filePath}${hint}` };
        }
        return { ok: false, error: `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}` };
    }
    if (mEditStat.size > 1073741824) {
        return { ok: false, error: `Error: edit refused: file too large (size: ${mEditStat.size}B, cap: 1GiB)` };
    }
    let mEditPreloadedContent = null;
    let mEditPreloadedRawBuf = null;
    let mEditSnapshot = _getReadSnapshot(fullPath, readStateScope);
    if (!mEditSnapshot) {
        const _mPrimed = _primeReadSnapshotForEdit({
            fullPath,
            filePath,
            st: mEditStat,
            scope: readStateScope,
            oldStrings: [],
        });
        mEditSnapshot = _getReadSnapshot(fullPath, readStateScope);
        if (_mPrimed) {
            _editPathTrace('edit_auto_snapshot', filePath, { mode: 'multi' });
            if (typeof _mPrimed.content === 'string' && Buffer.isBuffer(_mPrimed.rawBuf)) {
                mEditPreloadedContent = _mPrimed.content;
                mEditPreloadedRawBuf = _mPrimed.rawBuf;
            }
        }
    }
    const mEditSnapshotReadCache = createMutationContentCache();
    if (mEditSnapshot && _isSnapshotStale(mEditStat, mEditSnapshot, fullPath, mEditSnapshotReadCache)) {
        mEditPreloadedContent = _readContentIfSnapshotHashMatches(fullPath, mEditSnapshot, mEditSnapshotReadCache, mEditStat);
        if (mEditPreloadedContent !== null) {
            const cached = mEditSnapshotReadCache.getEntry(fullPath);
            if (Buffer.isBuffer(cached?.rawBuf)) mEditPreloadedRawBuf = cached.rawBuf;
        }
        if (mEditPreloadedContent === null) {
            const _staleRefresh = _tryStaleSnapshotAutoRefresh({
                fullPath,
                filePath,
                scope: readStateScope,
                stat: mEditStat,
                readRanges: mEditSnapshot?.ranges,
                oldStrings: edits,
                readCache: mEditSnapshotReadCache,
                recordPreviewSnapshot: false,
            });
            if (_staleRefresh?.error) return { ok: false, error: _staleRefresh.error };
            if (_staleRefresh?.content) {
                mEditPreloadedContent = _staleRefresh.content;
                mEditPreloadedRawBuf = _staleRefresh.rawBuf;
                mEditSnapshot = _getReadSnapshot(fullPath, readStateScope);
            } else {
                const recovery = _buildStaleEditRecovery({
                    fullPath,
                    scope: readStateScope,
                    oldStrings: edits,
                    recordPreviewSnapshot: false,
                });
                return { ok: false, error: `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}${recovery}` };
            }
        }
    } else {
        const cached = mEditSnapshotReadCache.getEntry(fullPath);
        if (typeof cached?.content === 'string') {
            mEditPreloadedContent = cached.content;
            if (Buffer.isBuffer(cached.rawBuf)) mEditPreloadedRawBuf = cached.rawBuf;
        }
    }
    try {
        try {
            mEditStat = statSync(fullPath);
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                const similar = findSimilarFile(fullPath);
                const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                return { ok: false, error: `Error [code 4]: file not found: ${filePath}${hint}` };
            }
            return { ok: false, error: `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}` };
        }
        if (!mEditSnapshot) {
            const _cold = _readEditTargetBytesUnderLock(fullPath, filePath, 'no_snapshot', 'multi');
            if (!_cold) {
                return { ok: false, error: `Error: failed to read edit target: ${filePath}` };
            }
            mEditPreloadedContent = _cold.content;
            mEditPreloadedRawBuf = _cold.rawBuf;
        } else if (mEditPreloadedRawBuf !== null && mEditSnapshot
            && typeof mEditSnapshot.contentHash === 'string') {
            const _primed = _loadEditTargetBytes(fullPath);
            if (_primed) {
                if (_hashText(_primed.rawBuf) !== _hashText(mEditPreloadedRawBuf)) {
                    _editPathTrace('edit_lock_cold_reread', filePath, {
                        mode: 'multi',
                        reason: 'auto_snapshot_content_drift',
                    });
                }
                if (_hashText(_primed.rawBuf) === mEditSnapshot.contentHash) {
                    mEditPreloadedContent = _primed.content;
                    mEditPreloadedRawBuf = _primed.rawBuf;
                } else {
                    mEditPreloadedContent = null;
                    mEditPreloadedRawBuf = null;
                }
            }
        }
        let rawContent = mEditPreloadedRawBuf;
        try {
            if (rawContent === null) {
                const cachedRaw = _rawContentCacheGet(fullPath, mEditStat);
                rawContent = cachedRaw
                    || (mEditPreloadedContent === null
                    ? readFileSync(fullPath)
                    : Buffer.from(mEditPreloadedContent, 'utf-8'));
            }
        }
        catch (err) { return { ok: false, error: `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}` }; }
        let baseStatSnapshot = null;
        try {
            const postReadStat = statSync(fullPath);
            if (_statMatchesSnapshot(postReadStat, mEditStat) && postReadStat.size === rawContent.length) {
                baseStatSnapshot = {
                    mtimeMs: postReadStat.mtimeMs,
                    ctimeMs: postReadStat.ctimeMs,
                    size: postReadStat.size,
                    ino: Number(postReadStat.ino),
                };
            }
        } catch { /* fall back to hash compare in _validatePreparedEditBase */ }
        const baseContentHash = _hashText(rawContent);
        const expectedTargetSnapshot = _captureExpectedTargetSnapshot(fullPath, mEditStat);
        // Reviewer issue #3: validate encoding before the multi-edit
        // byte-exact buffer build too. Previously this branch returned a
        // prepared edit (and reached commit) before reaching the
        // legacy `_isValidUtf8Buffer` check further below, so a Shift-JIS
        // / Latin-1 / binary file could be mutated on the multi byte-exact
        // path.
        {
            const _utf8Err = _assertEditTargetUtf8(rawContent, filePath);
            if (_utf8Err) return { ok: false, error: _utf8Err };
        }
        const exactBufferEdit = _tryBuildMultiExactEditBuffer(rawContent, edits, args, mEditSnapshot, filePath);
        if (exactBufferEdit?.error) return { ok: false, error: exactBufferEdit.error };
        if (Buffer.isBuffer(exactBufferEdit?.updated) || (exactBufferEdit?.sameSize && Array.isArray(exactBufferEdit.replacements))) {
            return {
                ok: true,
                filePath,
                fullPath,
                edits,
                snapshot: mEditSnapshot,
                content: exactBufferEdit.updated || null,
                baseRawContent: rawContent,
                sameSizeByteReplacements: exactBufferEdit.sameSize ? exactBufferEdit.replacements : null,
                contentHash: exactBufferEdit.contentHash || (Buffer.isBuffer(exactBufferEdit.updated) ? _hashText(exactBufferEdit.updated) : null),
                baseContentHash,
                baseMutationGeneration: _getPathMutationGeneration(fullPath),
                baseStatSnapshot,
                expectedTargetSnapshot,
                baseMode: mEditStat.mode & 0o777,
                stageCounts: {},
            };
        }
        if (!_isValidUtf8Buffer(rawContent)) {
            const _bomNote = (rawContent.length >= 2 && rawContent[0] === 0xFF && rawContent[1] === 0xFE)
                ? 'file is UTF-16LE (BOM FF FE) — edit only supports UTF-8; use write (preserves UTF-16) or convert the file'
                : (rawContent.length >= 2 && rawContent[0] === 0xFE && rawContent[1] === 0xFF)
                    ? 'file is UTF-16BE (BOM FE FF) — edit only supports UTF-8; convert the file first'
                    : 'file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix)';
            return { ok: false, error: `Error: ${_bomNote}. Edit aborted to prevent silent corruption. Path: ${filePath}` };
        }
        let content = mEditPreloadedContent;
        if (content === null) content = rawContent.toString('utf-8');
        // CC parity: when new_string is empty (pure deletion) and old_string
        // is followed by a newline in the file, swallow that newline as part
        // of the match so the deletion doesn't leave an empty line behind.
        // Mirrors FileEditTool/utils.ts applyEditToFile's stripTrailingNewline
        // branch. CRLF fallback path keeps current behaviour to avoid range
        // arithmetic complications.
        const _absorbTrailingNewline = (cur, oldStr, newStr, replaceAll) => {
            if (newStr !== '' || oldStr.endsWith('\n')) return oldStr;
            // For replace_all pure deletion, do NOT globally rewrite oldStr —
            // mixed-suffix occurrences (some followed by \n, some bare / at
            // EOF) need per-occurrence absorption handled by the replace_all
            // branch below; a single global eOldStr would skip bare sites.
            if (replaceAll) return oldStr;
            if (cur.includes(oldStr + '\r\n')) return oldStr + '\r\n';
            return cur.includes(oldStr + '\n') ? oldStr + '\n' : oldStr;
        };
        // Sequential apply tracks an accumulated line delta so partial-
        // coverage windows shift with the bytes. Each edit's delta is
        // (newline count in new_string − newline count in old_string),
        // multiplied by the number of occurrences actually replaced.
        let _rollingSnapshot = mEditSnapshot;
        const _bumpRollingSnapshot = (beforeContent, needle, lineDelta, replaceAll) => {
            if (!Number.isFinite(lineDelta) || lineDelta === 0 || typeof needle !== 'string') return;
            const span = _lineRangeForSubstring(beforeContent, needle, { replaceAll: replaceAll === true });
            if (!span) return;
            _rollingSnapshot = _shiftSnapshotRangesForEdit(_rollingSnapshot, {
                editStartLine: span.startLine,
                editEndLine: span.endLine,
                lineDelta,
            });
        };
        // Stage stats surface fold / nfc-fold / crlf-fold counts up to
        // the caller so the response can flag non-exact matches without
        // touching the per-edit return shape.
        const _stageCounts = {};
        // Hoisted markdown predicate — same trailing-whitespace policy as
        // the single-edit case, computed once per call.
        const _IS_MD_PATH = /\.(?:md|mdx)$/i.test(filePath);
        // Independence invariant (matches fast-path semantics in
        // tryBuildMultiExactEditBuffer): reject batches where one edit's
        // new_string contains another edit's old_string. The slow path
        // applies sequentially against a mutating buffer, so a later
        // edit's old_string could match bytes that an earlier edit's
        // new_string just synthesised (or, conversely, an earlier edit
        // could destroy a later edit's anchor). Surfacing the invariant
        // up-front makes batches deterministic and matches the fast-path
        // contract that callers already see.
        if (edits.length > 1) {
            for (let a = 0; a < edits.length; a++) {
                const ea = edits[a];
                if (!ea || typeof ea.old_string !== 'string' || typeof ea.new_string !== 'string') continue;
                for (let b = 0; b < edits.length; b++) {
                    if (a === b) continue;
                    const eb = edits[b];
                    if (!eb || typeof eb.old_string !== 'string') continue;
                    if (eb.old_string.length === 0) continue;
                    if (ea.new_string.indexOf(eb.old_string) !== -1) {
                        return { ok: false, error: `Error [code 12]: edits are not independent — edit ${a}'s new_string contains edit ${b}'s old_string in ${filePath}; split into separate edit() calls or reorder so no later edit matches bytes produced by an earlier edit.` };
                    }
                }
            }
        }
        for (let i = 0; i < edits.length; i++) {
            const _contentBeforeEdit = content;
            const entry = edits[i];
            if (!entry || typeof entry.old_string !== 'string' || typeof entry.new_string !== 'string') {
                return { ok: false, error: `Error: edit ${i} must have old_string and new_string` };
            }
            {
                const _nulIdx = entry.new_string.indexOf('\u0000');
                if (_nulIdx !== -1) {
                    return { ok: false, error: `Error [code 11]: edit ${i} — new_string contains NUL byte (U+0000) at offset ${_nulIdx} — source text must not contain NUL: ${filePath}` };
                }
            }
            let { old_string: _origOld, new_string, replace_all } = entry;
            // Same line-prefix recovery as the single-edit case (see edit
            // handler). Sequential apply still validates each item, so a
            // bad strip simply fails further down with code 8 instead of
            // here.
            if (typeof _origOld === 'string' && /^\s*\d+[\t│→]/.test(_origOld)) {
                const _stripped = _maybeAutoStripLineNumberPrefixes(_origOld);
                if (_stripped !== null) {
                    _editPathTrace('edit_auto_strip_line_numbers', filePath, { mode: 'multi', index: i });
                    _origOld = _stripped;
                } else {
                    return { ok: false, error: `Error: edit ${i} — old_string mixes Read line-number-prefixed lines ("<n>│…") with raw lines — strip the prefix from every line (or none) before Edit: ${filePath}` };
                }
            }
            // Same trailing whitespace normalization as the single-edit
            // case. Markdown (`.md` / `.mdx`) skips the strip because two
            // trailing spaces is the hard-line-break syntax. `_IS_MD_PATH`
            // is hoisted above the loop so per-edit cost is one regex hit.
            if (!_IS_MD_PATH) {
                const _strippedNew = _stripTrailingWhitespaceForEdit(new_string, _origOld);
                if (_strippedNew !== new_string) {
                    _editPathTrace('edit_trim_trailing_ws', filePath, { mode: 'multi', index: i });
                    new_string = _strippedNew;
                }
            }
            if (_origOld.length === 0) {
                return { ok: false, error: `Error: edit ${i} — old_string must be non-empty` };
            }
            if (new_string === _origOld) {
                return { ok: false, error: `Error: edit ${i} — new_string must differ from old_string` };
            }
            const _matchInfo = {};
            const _origLiteralOccurrence = _findLiteralOccurrenceState(content, _origOld);
            // Move size gate to the FOLD-FALLBACK path: exact-unique
            // byte matches are safe at any size, so the >=30-line
            // code-10 wording only fires when we are about to leave
            // exact and try fold/fuzzy. A unique exact hit
            // (count === 1, or replace_all) bypasses the gate; an
            // ambiguous exact hit (count > 1 without replace_all)
            // surfaces via the standard code-9 path below.
            if (_origLiteralOccurrence.count === 0) {
                const _sizeErr = _validateEditChunkSize(_origOld, replace_all === true, false);
                if (_sizeErr) return { ok: false, error: _sizeErr.replace('Error [code 10]:', `Error [code 10]: edit ${i} —`) };
            }
            const _matchedOld = _origLiteralOccurrence.count > 0
                ? _origOld
                : (_findActualString(content, _origOld, _matchInfo) || _origOld);
            if (_origLiteralOccurrence.count > 0) _matchInfo.stage = 'exact';
            if (_matchInfo.stage && _matchInfo.stage !== 'exact') {
                _stageCounts[_matchInfo.stage] = (_stageCounts[_matchInfo.stage] || 0) + 1;
            }
            // CC parity: typography preservation (see edit-normalize.mjs).
            const _newAfterTypo = _preserveQuoteTypography(_origOld, _matchedOld, new_string);
            if (_newAfterTypo !== new_string) {
                _editPathTrace('edit_typography_preserve', filePath, { mode: 'multi', index: i });
                new_string = _newAfterTypo;
            }
            const old_string = _absorbTrailingNewline(content, _matchedOld, new_string, replace_all === true);
            const _shiftedSnapshot = _rollingSnapshot;
            const _oldNL = (old_string.match(/\n/g) || []).length;
            const _newNL = (new_string.match(/\n/g) || []).length;
            const _perOccurrenceDelta = _newNL - _oldNL;
            const _oldStringLiteralOccurrence = (old_string === _origOld && _origLiteralOccurrence.count > 0)
                ? _origLiteralOccurrence
                : _findLiteralOccurrenceState(content, old_string);
            if (replace_all === true) {
                let _occurrences = 0;
                if (_oldStringLiteralOccurrence.count > 0) {
                    let _occIdx = 0;
                    while ((_occIdx = content.indexOf(old_string, _occIdx)) !== -1) {
                        _occurrences++;
                        _occIdx += old_string.length;
                    }
                }
                if (_occurrences > 0) {
                    const _indentFixedNewAll = new_string;
                    // Pure-deletion (new_string === '' with no trailing line
                    // terminator on old): absorb a trailing \r\n / \n / \r
                    // PER OCCURRENCE. Mixed-suffix sites (some followed by
                    // a newline, some bare / at EOF) must all be removed;
                    // a single global eOldStr rewrite would skip every bare
                    // occurrence.
                    if (new_string === '' && !old_string.endsWith('\n') && !old_string.endsWith('\r')) {
                        const _ranges = [];
                        let _absorbedNewlines = 0;
                        let _scan = 0;
                        while ((_scan = content.indexOf(old_string, _scan)) !== -1) {
                            let _end = _scan + old_string.length;
                            if (content[_end] === '\r' && content[_end + 1] === '\n') { _end += 2; _absorbedNewlines += 1; }
                            else if (content[_end] === '\n') { _end += 1; _absorbedNewlines += 1; }
                            else if (content[_end] === '\r') { _end += 1; _absorbedNewlines += 1; }
                            _ranges.push({ start: _scan, end: _end });
                            _scan = _scan + old_string.length;
                        }
                        content = _replaceRangesFromOriginal(content, _ranges, '');
                        _bumpRollingSnapshot(_contentBeforeEdit, old_string, _perOccurrenceDelta * _ranges.length - _absorbedNewlines, replace_all);
                        continue;
                    }
                    content = content.split(old_string).join(_replacementForOriginalSlice(_indentFixedNewAll, old_string, content));
                    _bumpRollingSnapshot(_contentBeforeEdit, old_string, _perOccurrenceDelta * _occurrences, replace_all);
                    continue;
                }
                const crlfMatch = _findCrlfNormalisedMatches(content, old_string);
                if (!crlfMatch || crlfMatch.ranges.length === 0) {
                    const _foldAmb = _foldTierAmbiguityError(content, old_string, filePath, `edit ${i} — `, [content, edits, i, _findCrlfNormalisedMatches]);
                    if (_foldAmb) return { ok: false, error: _foldAmb };
                    // Promote `not found` to code 7 (snapshot mismatch) when this
                    // session has already mutated the file: the old_string almost
                    // certainly targets pre-mutation bytes, and the caller should
                    // re-read before retrying instead of debugging fold tiers.
                    // Use fullPath — the generation cache is keyed by canonical
                    // resolved path (see baseMutationGeneration at function tail),
                    // not the raw filePath which can be relative.
                    // code 7 promotion removed: `_gen > 0` alone mis-classified a
                    // simply-wrong old_string (absent from both pre-mutation and
                    // current bytes) as a stale snapshot. Stay an honest code 8 —
                    // the code 8 hint below already covers the real pre-mutation case.
                    return { ok: false, error: `Error [code 8]: edit ${i} — old_string not found in ${filePath} (no exact/fold/nfc-fold/crlf-fold match).${_optionalEditMissDetails(content, old_string, _shiftedSnapshot, { path: filePath, newString: new_string, replaceAll: replace_all === true, editIndex: i }, [content, edits, i, _findCrlfNormalisedMatches])}` };
                }
                const _crlfOccurrences = crlfMatch.ranges.length;
                content = _replaceRangesFromOriginal(content, crlfMatch.ranges, new_string);
                _bumpRollingSnapshot(_contentBeforeEdit, crlfMatch.normalisedOld, _perOccurrenceDelta * _crlfOccurrences, replace_all);
                _stageCounts['crlf-fold'] = (_stageCounts['crlf-fold'] || 0) + 1;
            } else {
                const occurrence = _oldStringLiteralOccurrence;
                if (occurrence.count > 1) {
                    const count = _countLiteralOccurrences(content, old_string);
                    return { ok: false, error: `Error [code 9]: edit ${i} — old_string found ${count} times in ${filePath}${_formatStageInline(_matchInfo.stage)};${_formatMatchLines(_occurrenceLinesPlain(content, old_string), count)} set replace_all:true or provide more unique context${_diagnoseBatchPeers(content, edits, i, _findCrlfNormalisedMatches)}` };
                }
                if (occurrence.count === 1) {
                    const _indentFixedNewOne = new_string;
                    content = _replaceSingleLiteralAt(content, occurrence.index, old_string, _replacementForOriginalSlice(_indentFixedNewOne, old_string, content));
                    _bumpRollingSnapshot(_contentBeforeEdit, old_string, _perOccurrenceDelta, replace_all);
                    continue;
                }
                const crlfMatch = _findCrlfNormalisedMatches(content, old_string);
                const crlfCount = crlfMatch ? crlfMatch.ranges.length : 0;
                if (crlfCount === 0) {
                    const _foldAmb = _foldTierAmbiguityError(content, old_string, filePath, `edit ${i} — `, [content, edits, i, _findCrlfNormalisedMatches]);
                    if (_foldAmb) return { ok: false, error: _foldAmb };
                    // Snapshot-mismatch promotion (see replace_all branch above):
                    // a mutated file with a missing old_string is almost always
                    // a stale snapshot, not a typo. Use fullPath for the cache key.
                    // code 7 promotion removed: `_gen > 0` alone mis-classified a
                    // simply-wrong old_string (absent from both pre-mutation and
                    // current bytes) as a stale snapshot. Stay an honest code 8 —
                    // the code 8 hint below already covers the real pre-mutation case.
                    return { ok: false, error: `Error [code 8]: edit ${i} — old_string not found in ${filePath} (no exact/fold/nfc-fold/crlf-fold match).${_optionalEditMissDetails(content, old_string, _shiftedSnapshot, { path: filePath, newString: new_string, replaceAll: replace_all === true, editIndex: i }, [content, edits, i, _findCrlfNormalisedMatches])}` };
                }
                if (crlfCount > 1) return { ok: false, error: `Error [code 9]: edit ${i} — old_string found ${crlfCount} times in ${filePath} (via crlf-fold);${_formatMatchLines(_occurrenceLinesCrlf(content, crlfMatch.ranges), crlfCount)} set replace_all:true or provide more unique context${_diagnoseBatchPeers(content, edits, i, _findCrlfNormalisedMatches)}` };
                content = _replaceRangesFromOriginal(content, crlfMatch.ranges, new_string);
                _bumpRollingSnapshot(_contentBeforeEdit, crlfMatch.normalisedOld, _perOccurrenceDelta, replace_all);
                _stageCounts['crlf-fold'] = (_stageCounts['crlf-fold'] || 0) + 1;
            }
        }
        return { ok: true, filePath, fullPath, edits, snapshot: _rollingSnapshot, content, baseRawContent: rawContent, baseContentHash, baseMutationGeneration: _getPathMutationGeneration(fullPath), baseStatSnapshot, expectedTargetSnapshot, baseMode: mEditStat.mode & 0o777, stageCounts: _stageCounts };
    } catch (err) {
        return { ok: false, error: `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}` };
    }
}

const _editCommitHooks = {
    ioTraceStart: _ioTraceStart,
    ioTraceDone: _ioTraceDone,
};

function _commitPreparedEditUnlocked(prepared, readStateScope, options = {}) {
    return _commitPreparedEditUnlockedImpl(prepared, readStateScope, options, _editCommitHooks);
}

function _commitPreparedEditCheckedUnlocked(prepared, readStateScope, options = {}) {
    return _commitPreparedEditCheckedUnlockedImpl(prepared, readStateScope, options, _editCommitHooks);
}

export async function runMultiEdit(args, workDir, readStateScope, _pathOpts, options = {}) {
    const filePath = normalizePathAndStripLineCoordinate(args?.path, workDir);
    if (!filePath) return 'Error: path is required';
    // R12: Win32 component guard — reject trailing dot/space or NTFS ADS
    // suffix (foo.txt:ads) and reserved device names before resolve so a
    // relative path can't be coerced into a device alias.
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(filePath)) {
        return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(filePath)) {
        return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
    }
    const fullPath = resolveAgainstCwd(filePath, workDir);
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath)) {
        return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath)) {
        return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
    }
    return withBuiltinPathLocks([fullPath], () => withAdvisoryLocks([fullPath], async () => {
        const prepared = await _prepareMultiEdit({ ...args, path: filePath }, workDir, readStateScope, _pathOpts, options);
        if (!prepared.ok) return prepared.error;
        try {
            const commit = await _commitPreparedEditCheckedUnlocked(prepared, readStateScope, options);
            if (!commit.ok) return commit.error;
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
        return `Edited: ${normalizeOutputPath(prepared.filePath)} (${prepared.edits.length} replacements applied)${_formatStageNote(prepared.stageCounts)}`;
    }));
}

export async function runBatchEdit(args, workDir, readStateScope, _pathOpts, executeChildBuiltinTool, options = {}) {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) return 'Error: edits array is required';
    // Shallow-copy each entry so we don't mutate the caller's array in
    // place. The previous shape rewrote `e.path` on the caller's object,
    // which leaks the normalised path back out and breaks idempotent
    // retries from the caller's perspective.
    const normalizedEdits = edits.map((e) => (
        e && typeof e === 'object'
            ? { ...e, path: normalizePathAndStripLineCoordinate(e.path, workDir) }
            : e
    ));
    const groups = new Map();
    const missingPath = [];
    for (const e of normalizedEdits) {
        if (!e || !e.path) { missingPath.push(e); continue; }
        if (!groups.has(e.path)) groups.set(e.path, []);
        groups.get(e.path).push(e);
    }
    const parseLeadError = (body) => {
        const first = String(body).split('\n')[0] || '';
        if (!/^Error(\s|\[)/.test(first)) return null;
        const colonIdx = first.indexOf(': ');
        const msg = colonIdx !== -1 ? first.slice(colonIdx + 2) : first;
        const retryHint = String(body).includes('snapshot recorded now') && !msg.includes('Retry the edit directly')
            ? ' (snapshot recorded; retry the same edit directly, no read needed)'
            : '';
        return `${msg}${retryHint}`;
    };
    const preparedResults = await Promise.all([...groups.entries()].map(async ([path, items]) => {
        const prepared = await _prepareMultiEdit({
            path,
            edits: items.map(({ path: _p, ...rest }) => rest),
        }, workDir, readStateScope, null, options);
        if (!prepared.ok) {
            const errMsg = parseLeadError(prepared.error) || prepared.error;
            return { ok: false, path, line: `FAIL ${normalizeOutputPath(path)}: ${errMsg}` };
        }
        return { ok: true, path, items, prepared, line: `OK ${normalizeOutputPath(path)} (${items.length})${_formatStageNote(prepared.stageCounts)}` };
    }));
    const missingLines = missingPath.map(() => 'FAIL (missing-path): path is required');
    const lines = [...preparedResults.map((result) => result.line), ...missingLines];
    const failed = lines.filter((line) => line.startsWith('FAIL ')).length;
    if (failed > 0) {
        return `Error: batch edit preflight failed (${failed} of ${lines.length}); no changes written\n${lines.join('\n')}`;
    }
    const batchLockPaths = preparedResults.map((result) => result.prepared.fullPath);
    return withBuiltinPathLocks(batchLockPaths, () => withAdvisoryLocks(batchLockPaths, async () => {
        const lockPreparedResults = [];
        for (const result of preparedResults) {
            const prepared = await _prepareMultiEdit({
                path: result.path,
                edits: result.items.map(({ path: _p, ...rest }) => rest),
            }, workDir, readStateScope, null, options);
            if (!prepared.ok) {
                const errMsg = parseLeadError(prepared.error) || prepared.error;
                return `Error: batch edit lock prepare failed for ${normalizeOutputPath(result.path)}: ${errMsg}; no changes written`;
            }
            lockPreparedResults.push({
                ok: true,
                path: result.path,
                items: result.items,
                prepared,
                line: `OK ${normalizeOutputPath(result.path)} (${result.items.length})${_formatStageNote(prepared.stageCounts)}`,
            });
        }
        const prewriteResults = lockPreparedResults.map((result) => {
            const err = _validatePreparedEditBase(result.prepared);
            return err ? `FAIL ${normalizeOutputPath(result.path)}: ${err}` : result.line;
        });
        const prewriteFailed = prewriteResults.filter((line) => line.startsWith('FAIL ')).length;
        if (prewriteFailed > 0) {
            return `Error: batch edit prewrite check failed (${prewriteFailed} of ${lockPreparedResults.length}); no changes written\n${prewriteResults.join('\n')}`;
        }
        // Cross-file atomicity (capture-and-restore): snapshot every
        // target's original bytes BEFORE any write. On the first commit
        // failure, restore every already-committed file from its captured
        // bytes so the batch is all-or-nothing. Partial state is reported
        // only when a restore itself fails — an invariant-based recovery,
        // no heuristic fallback.
        const originals = new Map();
        for (const result of lockPreparedResults) {
            const captured = result.prepared.baseRawContent;
            if (!Buffer.isBuffer(captured)) {
                return `Error: batch edit pre-capture failed for ${normalizeOutputPath(result.path)}: missing base bytes from prepare; no changes written`;
            }
            originals.set(result.prepared.fullPath, captured);
        }
        const commitResults = [];
        const committed = [];
        let commitFailureIndex = -1;
        for (let i = 0; i < lockPreparedResults.length; i++) {
            const result = lockPreparedResults[i];
            try {
                await _commitPreparedEditUnlocked(result.prepared, readStateScope, options);
                commitResults.push(result.line);
                committed.push(result);
            } catch (err) {
                commitResults.push(`FAIL ${normalizeOutputPath(result.path)}: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`);
                commitFailureIndex = i;
                break;
            }
        }
        if (commitFailureIndex !== -1) {
            // Reviewer issue #1: include the FAILING target in the rollback
            // set. _commitPreparedEditUnlocked can mutate the target before
            // throwing — same-size in-place byte writes happen via
            // tryWriteSameSizeByteReplacementsSync BEFORE the error throw,
            // and the post-atomicWrite side effects (cache seed / snapshot
            // record) can also throw after a successful rename. If we only
            // restore `committed`, the failing target keeps the partial /
            // post-atomic mutation while reporting "no changes written".
            const restoreFailures = [];
            const restoreTargets = [...committed, lockPreparedResults[commitFailureIndex]];
            for (const prior of restoreTargets) {
                const orig = originals.get(prior.prepared.fullPath);
                try {
                    await atomicWrite(prior.prepared.fullPath, orig, {
                        sessionId: options?.sessionId,
                        mode: prior.prepared.baseMode,
                        expectedTargetSnapshot: _captureExpectedTargetSnapshot(prior.prepared.fullPath),
                    });
                    invalidateBuiltinResultCache([prior.prepared.fullPath]);
                    _seedRawContentCacheAfterWrite(prior.prepared.fullPath, orig);
                    markCodeGraphDirtyPaths([prior.prepared.fullPath]);
                    // Restore the read-snapshot too so subsequent reads
                    // observe the original bytes — otherwise a downstream
                    // edit/read would see the post-commit stale snapshot
                    // (recorded by _commitPreparedEditUnlocked on the
                    // already-rolled-back files) and fail code 7.
                    let _restoreStat = null;
                    try { _restoreStat = statSync(prior.prepared.fullPath); } catch {}
                    _recordReadSnapshot(prior.prepared.fullPath, _restoreStat || undefined, readStateScope, {
                        source: 'edit_rollback',
                        contentHash: _hashText(orig),
                    });
                } catch (rerr) {
                    restoreFailures.push(`FAIL ${normalizeOutputPath(prior.path)} (restore): ${normalizeErrorMessage(rerr instanceof Error ? rerr.message : String(rerr))}`);
                }
            }
            if (restoreFailures.length > 0) {
                return `Error: batch edit write failed and rollback incomplete (${restoreFailures.length} of ${restoreTargets.length} file(s) left in mutated state); manual recovery required\n${commitResults.join('\n')}\n${restoreFailures.join('\n')}`;
            }
            return `Error: batch edit write failed (1 of ${lockPreparedResults.length}); rolled back ${restoreTargets.length} file(s) (including failing target); no changes written\n${commitResults.join('\n')}`;
        }
        return commitResults.join('\n');
    }));
}

// --- Tool execution ---
export async function runSingleEdit(args, workDir, readStateScope, options = {}) {
            args.path = normalizePathAndStripLineCoordinate(args.path, workDir);
            const filePath = args.path;
            let oldStr = args.old_string;
            let newStr = args.new_string;
            const replaceAll = args.replace_all === true;
            if (!filePath || typeof oldStr !== 'string' || oldStr.length === 0)
                return 'Error: path and non-empty old_string are required.';
            if (typeof newStr !== 'string')
                return 'Error: new_string must be a string';
            {
                const _nulIdx = newStr.indexOf('\u0000');
                if (_nulIdx !== -1)
                    return `Error [code 11]: new_string contains NUL byte (U+0000) at offset ${_nulIdx} — source text must not contain NUL: ${filePath}`;
            }
            if (newStr === oldStr)
                return 'Error: new_string must differ from old_string';
            if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(filePath)) {
                return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
            }
            if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(filePath)) {
                return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
            }
            // Size gate moved to the FOLD-FALLBACK path below
            // (post-_tryBuildExactEditBuffer, before _findActualString).
            // An exact-unique byte match is safe at any size; the
            // >=30-line code-10 wording only fires once the buffered
            // exact attempt has missed and we are about to enter the
            // fragile fold/fuzzy tier.
            // Line-prefix recovery: Read returns `<n>│<content>` (legacy `\t`
            // also covered for muscle-memory pastes). If the model copies
            // that rendering straight into old_string the on-disk file has
            // no matching separator-prefixed line, so the match would
            // silently fail. Auto-strip when every line carries a prefix;
            // surface a guidance error when only some lines do, since
            // mixing rendered + raw lines means we cannot infer intent.
            if (/^\s*\d+[\t│→]/.test(oldStr)) {
                const _stripped = _maybeAutoStripLineNumberPrefixes(oldStr);
                if (_stripped !== null) {
                    _editPathTrace('edit_auto_strip_line_numbers', filePath, { mode: 'single' });
                    oldStr = _stripped;
                    if (newStr === oldStr)
                        return 'Error: new_string must differ from old_string (after auto-stripping Read line-number prefix from old_string)';
                } else {
                    return `Error: old_string mixes Read line-number-prefixed lines ("<n>│…") with raw lines — strip the prefix from every line (or none) before Edit: ${filePath}`;
                }
            }
            // CC parity (FileEditTool.stripTrailingWhitespace): drop trailing
            // space/tab from each new_string line. Models routinely emit stray
            // spaces at line ends; in source code that has no semantic meaning,
            // so silent diffs from those bytes are pure noise. Markdown is the
            // sole exception — `"  \n"` is the hard-line-break syntax (`<br>`),
            // altering it changes rendered output. Line terminators (LF / CRLF
            // / lone CR) are preserved byte-exact.
            if (!/\.(?:md|mdx)$/i.test(filePath)) {
                const _strippedNew = _stripTrailingWhitespaceForEdit(newStr, oldStr);
                if (_strippedNew !== newStr) {
                    _editPathTrace('edit_trim_trailing_ws', filePath, { mode: 'single' });
                    newStr = _strippedNew;
                    if (newStr === oldStr)
                        return 'Error: new_string must differ from old_string (after trimming trailing whitespace from new_string; rename target to .md/.mdx to preserve trailing spaces)';
                }
            }
            const fullPath = resolveAgainstCwd(filePath, workDir);
            // R1: short-circuit UNC/SMB paths before ANY stat/read on the
            // edit target to prevent NTLM credential leakage via implicit
            // network auth. Mirrors CC FileEditTool.ts:176.
            if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
                return `Error: UNC/SMB paths are not supported (R1: NTLM-leak prevention): ${filePath}`;
            }
            if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath)) {
                return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(filePath)}`;
            }
            if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath)) {
                return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(filePath)}`;
            }
            // Fast path: when a snapshot already exists, skip the pre-lock stat.
            // The lock-protected stat below still catches ENOENT and drift; the
            // pre-lock stat is only needed to seed auto-snapshot on cold edits.
            let _coldPrimedContent = null;
            let _coldPrimedRawBuf = null;
            let _coldPrimedStat = null;
            {
                let _preLockSnap = _getReadSnapshot(fullPath, readStateScope);
                if (!_preLockSnap) {
                    let _preLockStat;
                    try { _preLockStat = statSync(fullPath); }
                    catch (err) {
                        if (err && err.code === 'ENOENT') {
                            const similar = findSimilarFile(fullPath);
                            const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                            return `Error [code 4]: file not found: ${filePath}${hint}`;
                        }
                        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                    }
                    // Auto-snapshot: same invariant as _runMultiEdit. Capture
                    // in-process, continue. Lock-protected re-snapshot inside
                    // _withPathLock below still catches concurrent external
                    // writes, so the auto path doesn't weaken CAS guarantees.
                    const _sPrimed = _primeReadSnapshotForEdit({
                        fullPath,
                        filePath,
                        st: _preLockStat,
                        scope: readStateScope,
                        oldStrings: [],
                    });
                    _preLockSnap = _getReadSnapshot(fullPath, readStateScope);
                    if (_sPrimed) {
                        _editPathTrace('edit_auto_snapshot', filePath, { mode: 'single' });
                        if (typeof _sPrimed.content === 'string' && Buffer.isBuffer(_sPrimed.rawBuf)) {
                            _coldPrimedContent = _sPrimed.content;
                            _coldPrimedRawBuf = _sPrimed.rawBuf;
                            _coldPrimedStat = _preLockStat;
                        }
                    } else if (!_preLockSnap) {
                        const _cold = _loadEditTargetBytes(fullPath);
                        if (!_cold) {
                            return `Error: failed to read edit target: ${filePath}`;
                        }
                        _coldPrimedContent = _cold.content;
                        _coldPrimedRawBuf = _cold.rawBuf;
                        _coldPrimedStat = _preLockStat;
                        _editPathTrace('edit_cold_no_snapshot', filePath, { mode: 'single' });
                    }
                }
            }
            // CAS guard: serialise concurrent edits to the same path.
            // After acquiring the lock, re-stat + re-hash to detect drift
            // that occurred between the pre-lock snapshot check and now.
            return _withPathLock(fullPath, () => withAdvisoryLocks([fullPath], async () => {
                let editStat;
                try { editStat = statSync(fullPath); }
                catch (err) {
                    if (err && err.code === 'ENOENT') {
                        const similar = findSimilarFile(fullPath);
                        const hint = similar ? ` Did you mean "${normalizeOutputPath(similar)}"?` : '';
                        return `Error [code 4]: file not found: ${filePath}${hint}`;
                    }
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
                let editSnapshot = _getReadSnapshot(fullPath, readStateScope);
                // Error [code 7]: detect stale read via mtime drift (Anthropic
                // readFileState timestamp check parity). +1ms slack absorbs
                // filesystem timestamp resolution noise on NTFS/exFAT.
                let editPreloadedContent = null;
                let editPreloadedRawBuf = null;
                const editSnapshotReadCache = createMutationContentCache();
                if (!editSnapshot) {
                    const _cold = _readEditTargetBytesUnderLock(fullPath, filePath, 'no_snapshot');
                    if (!_cold) {
                        return `Error: failed to read edit target: ${filePath}`;
                    }
                    editPreloadedContent = _cold.content;
                    editPreloadedRawBuf = _cold.rawBuf;
                } else {
                    const _editSnapStale = _isSnapshotStale(editStat, editSnapshot, fullPath, editSnapshotReadCache);
                    if (!_editSnapStale && _coldPrimedContent !== null && editSnapshot
                        && typeof editSnapshot.contentHash === 'string'
                        && _coldPrimedStat && _statMatchesSnapshot(editStat, _coldPrimedStat)) {
                        const _lockedPrimed = _loadEditTargetBytes(fullPath);
                        if (_lockedPrimed) {
                            if (Buffer.isBuffer(_coldPrimedRawBuf)
                                && _hashText(_lockedPrimed.rawBuf) !== _hashText(_coldPrimedRawBuf)) {
                                _editPathTrace('edit_lock_cold_reread', filePath, {
                                    mode: 'single',
                                    reason: 'auto_snapshot_content_drift',
                                });
                            }
                            if (_hashText(_lockedPrimed.rawBuf) === editSnapshot.contentHash) {
                                editPreloadedContent = _lockedPrimed.content;
                                editPreloadedRawBuf = _lockedPrimed.rawBuf;
                            }
                        }
                    }
                    if (_editSnapStale) {
                        editPreloadedContent = _readContentIfSnapshotHashMatches(fullPath, editSnapshot, editSnapshotReadCache, editStat);
                        if (editPreloadedContent !== null) {
                            const cached = editSnapshotReadCache.getEntry(fullPath);
                            if (Buffer.isBuffer(cached?.rawBuf)) editPreloadedRawBuf = cached.rawBuf;
                        }
                        if (editPreloadedContent === null) {
                            const _staleRefresh = _tryStaleSnapshotAutoRefresh({
                                fullPath,
                                filePath,
                                scope: readStateScope,
                                stat: editStat,
                                readRanges: editSnapshot?.ranges,
                                oldStrings: [{ old_string: oldStr, replace_all: replaceAll }],
                                readCache: editSnapshotReadCache,
                                recordPreviewSnapshot: !replaceAll,
                            });
                            if (_staleRefresh?.error) return _staleRefresh.error;
                            if (_staleRefresh?.content) {
                                editPreloadedContent = _staleRefresh.content;
                                editPreloadedRawBuf = _staleRefresh.rawBuf;
                                editSnapshot = _getReadSnapshot(fullPath, readStateScope);
                            } else {
                                const recovery = _buildStaleEditRecovery({
                                    fullPath,
                                    scope: readStateScope,
                                    oldStrings: [oldStr],
                                    recordPreviewSnapshot: !replaceAll,
                                });
                                return `Error [code 7]: file modified since read (lint / formatter / external write) — read it again before editing: ${filePath}${recovery}`;
                            }
                        }
                    } else {
                        const cached = editSnapshotReadCache.getEntry(fullPath);
                        if (typeof cached?.content === 'string' && Buffer.isBuffer(cached.rawBuf)) {
                            editPreloadedContent = cached.content;
                            editPreloadedRawBuf = cached.rawBuf;
                        }
                    }
                }
                try {
                    if (editStat.size > 1073741824) {
                        return `Error: edit refused: file too large (size: ${editStat.size}B, cap: 1GiB)`;
                    }
                    // Reviewer issue #3: validate encoding before the native
                    // exact-edit dispatch too. Without this, the rust binary
                    // would happily rewrite a Shift-JIS / Latin-1 / binary
                    // file on the byte-exact code path while only the JS
                    // fold path refused it. We read the buffer once, run
                    // the shared guard, and reuse it downstream so non-
                    // native paths don't double-read.
                    let _preNativeRawBuf = editPreloadedRawBuf !== null
                        ? editPreloadedRawBuf
                        : (_rawContentCacheGet(fullPath, editStat)
                            || (editPreloadedContent === null
                            ? await fsPromises.readFile(fullPath)
                            : Buffer.from(editPreloadedContent, 'utf-8')));
                    {
                        const _utf8Err = _assertEditTargetUtf8(_preNativeRawBuf, filePath);
                        if (_utf8Err) return _utf8Err;
                    }
                    if (_nativeEditShouldAttempt({ editStat, editSnapshot, oldStr, newStr, preloadedContent: editPreloadedContent, preloadedRawBuf: editPreloadedRawBuf })) {
                        let nativeSignal = options?.signal || null;
                        if (!nativeSignal && options?.sessionId) {
                            try { nativeSignal = await getAbortSignalForSession(options.sessionId); } catch { nativeSignal = null; }
                        }
                        const nativeEdit = await _runNativeExactEdit({ fullPath, oldStr, newStr, replaceAll, signal: nativeSignal });
                        if (nativeEdit?.ok) {
                            invalidateBuiltinResultCache([fullPath]);
                            markCodeGraphDirtyPaths([fullPath]);
                            let writtenStat = null;
                            try { writtenStat = statSync(fullPath); } catch {}
                            _recordReadSnapshot(fullPath, writtenStat || undefined, readStateScope, {
                                source: 'edit_native',
                                contentHash: nativeEdit.contentHash,
                            });
                            _ioTrace('edit_native', {
                                pathHash: _hashText(fullPath).slice(0, 12),
                                replacements: nativeEdit.replacements,
                                roundtripMs: Number(nativeEdit.roundtripMs.toFixed(3)),
                                rustTotalMs: Number(nativeEdit.totalMs.toFixed(3)),
                                readMs: Number(nativeEdit.readMs.toFixed(3)),
                                applyMs: Number(nativeEdit.applyMs.toFixed(3)),
                                writeMs: Number(nativeEdit.writeMs.toFixed(3)),
                            });
                            return `Edited: ${normalizeOutputPath(filePath)} (native)`;
                        }
                        if (nativeEdit && nativeEdit.fallback === false) {
                            return `Error: native edit failed — ${normalizeErrorMessage(nativeEdit.error || 'unknown native edit error')}`;
                        }
                    }
                    // D-R1-3: refuse edits on non-UTF-8 files before the
                    // utf-8 decode round-trip silently corrupts bytes via
                    // U+FFFD replacement. Use Buffer.isUtf8 (Node>=18) or
                    // a byte-level walk as fallback.
                    // Fix J-3: always read raw bytes and validate encoding,
                    // even when editPreloadedContent was set via contentHash
                    // preload — the cached string bypasses the guard otherwise.
                    // I/O perf: single async Buffer read serves both UTF-8
                    // validation AND content matching below; previous shape
                    // did two sync readFileSync inside _withPathLock.
                    const _rawBuf = _preNativeRawBuf;
                    const _baseStatSnapshot = _captureStableBaseStatSnapshot(fullPath, editStat, _rawBuf);
                    const _baseContentHash = _hashText(_rawBuf);
                    const _baseMutationGen = _getPathMutationGeneration(fullPath);
                    const _preWriteBaseCheck = () => _validatePreparedEditBase({
                        fullPath,
                        filePath,
                        baseStatSnapshot: _baseStatSnapshot,
                        baseContentHash: _baseContentHash,
                        baseMutationGeneration: _baseMutationGen,
                    });
                    // UTF-8 already validated against _preNativeRawBuf above
                    // (covers native dispatch + byte-exact + fold paths).
                    // The shared `_assertEditTargetUtf8` helper enforces
                    // the same error wording for every byte-exact write
                    // path (single byte-exact buffer, multi byte-exact
                    // buffer, native exact-edit).
                    const _byteExactEdit = _tryBuildExactEditBuffer(_rawBuf, oldStr, newStr, replaceAll, editSnapshot, filePath);
                    if (_byteExactEdit?.error) return _byteExactEdit.error;
                    if (_byteExactEdit?.sameSize && Array.isArray(_byteExactEdit.replacements)) {
                        const partial = _tryWriteSameSizeByteReplacementsSync(fullPath, _byteExactEdit.replacements, {
                            baseStatSnapshot: _baseStatSnapshot,
                            baseMutationGeneration: _baseMutationGen,
                            baseContentHash: _baseContentHash,
                            contentHash: _byteExactEdit.contentHash,
                            fsync: options?.fsync,
                            filePath,
                        });
                        if (partial?.error) return partial.error;
                        if (partial?.ok) {
                            invalidateBuiltinResultCache([fullPath]);
                            markCodeGraphDirtyPaths([fullPath]);
                            const _partialAfter = _materialiseByteReplacements(_rawBuf, _byteExactEdit.replacements);
                            const _partialSnap = _postEditSnapshotMeta(editSnapshot, 'edit', _partialAfter, {
                                contentBeforeEdit: _rawBuf,
                                oldStr,
                                newStr,
                                replaceAll,
                            });
                            _recordReadSnapshot(fullPath, partial.stat || undefined, readStateScope, _partialSnap);
                            return `Edited: ${normalizeOutputPath(filePath)}`;
                        }
                    }
                    if (!Buffer.isBuffer(_byteExactEdit?.updated) && Array.isArray(_byteExactEdit?.replacements)) {
                        _byteExactEdit.updated = _materialiseByteReplacements(_rawBuf, _byteExactEdit.replacements);
                    }
                    if (Buffer.isBuffer(_byteExactEdit?.updated)) {
                        const _baseErr = _preWriteBaseCheck();
                        if (_baseErr) return _baseErr;
                        await atomicWrite(fullPath, _byteExactEdit.updated, {
                            sessionId: options?.sessionId,
                            mode: editStat.mode & 0o777,
                            expectedTargetSnapshot: _captureExpectedTargetSnapshot(fullPath, editStat),
                        });
                        invalidateBuiltinResultCache([fullPath]);
                        const writtenStat = _seedRawContentCacheAfterWrite(fullPath, _byteExactEdit.updated);
                        markCodeGraphDirtyPaths([fullPath]);
                        _recordReadSnapshot(fullPath, writtenStat || undefined, readStateScope, _postEditSnapshotMeta(editSnapshot, 'edit', _byteExactEdit.updated, {
                            contentBeforeEdit: _rawBuf,
                            oldStr,
                            newStr,
                            replaceAll,
                        }));
                        return `Edited: ${normalizeOutputPath(filePath)}`;
                    }
                    let content = editPreloadedContent === null
                        ? _rawBuf.toString('utf-8')
                        : editPreloadedContent;
                    // CC parity: pure deletion (newStr === '') swallows the
                    // trailing newline that follows oldStr in the file so the
                    // edit doesn't leave a stray empty line. Only the literal
                    // match path absorbs; CRLF fallback keeps existing
                    // semantics so range arithmetic stays simple.
                    // CC parity: also try curly-quote normalization to find the
                    // file's actual substring when the model emitted straight
                    // quotes against a curly-quoted source (or vice versa).
                    // _findActualString returns the byte-exact slice that the
                    // file holds at the match position; downstream code keeps
                    // operating on that exact slice.
                    const _matchInfo = {};
                    const _oldLiteralOccurrence = _findLiteralOccurrenceState(content, oldStr);
                    // Fold-fallback size gate: only when the buffered
                    // exact attempt has returned null AND no literal
                    // hit survives in the decoded `content` view do we
                    // refuse large chunks. An exact-unique landed edit
                    // (handled above via _byteExactEdit.updated) never
                    // reaches here.
                    if (_oldLiteralOccurrence.count === 0) {
                        const _foldSizeErr = _validateEditChunkSize(oldStr, replaceAll, false);
                        if (_foldSizeErr) return _foldSizeErr;
                    }
                    const _matchedOldStr = _oldLiteralOccurrence.count > 0
                        ? oldStr
                        : (_findActualString(content, oldStr, _matchInfo) || oldStr);
                    if (_oldLiteralOccurrence.count > 0) _matchInfo.stage = 'exact';
                    // CC parity: preserve the file's curly-quote typography when
                    // the model wrote straight quotes and the matched bytes had
                    // curly ones. Heuristic exception — see edit-normalize.mjs
                    // preserveQuoteTypography for the carved-out justification.
                    const _newStrAfterTypo = _preserveQuoteTypography(oldStr, _matchedOldStr, newStr);
                    if (_newStrAfterTypo !== newStr) {
                        _editPathTrace('edit_typography_preserve', filePath, { mode: 'single' });
                        newStr = _newStrAfterTypo;
                    }
                    // Pure-deletion newline absorption.
                    //
                    // Single-occurrence path: extend the match over a trailing
                    // LF/CRLF when present so the deletion doesn't leave a stray
                    // empty line (CC parity). Previous shape used a global
                    // `content.includes(X+'\n')` probe and rewrote eOldStr to
                    // `X+'\n'`; under replace_all that left bare-X occurrences
                    // (no following newline) unmatched. Switch to per-
                    // occurrence range collection below when replace_all is
                    // set, and keep the simple form for single replace.
                    let eOldStr = _matchedOldStr;
                    let _pureDeletionRanges = null;
                    if (newStr === '' && !_matchedOldStr.endsWith('\n')) {
                        if (replaceAll) {
                            const ranges = [];
                            let scan = 0;
                            while ((scan = content.indexOf(_matchedOldStr, scan)) !== -1) {
                                let end = scan + _matchedOldStr.length;
                                if (content[end] === '\r' && content[end + 1] === '\n') end += 2;
                                else if (content[end] === '\n') end += 1;
                                ranges.push({ start: scan, end });
                                scan = scan + _matchedOldStr.length;
                            }
                            if (ranges.length > 0) _pureDeletionRanges = ranges;
                        } else {
                            // Ambiguity must be judged on the ORIGINAL bare
                            // _matchedOldStr occurrence count, not the newline-
                            // absorbed eOldStr. Absorbing first can collapse a
                            // >1-occurrence bare match into a unique extended
                            // literal (e.g. 'X' present as 'X\r\n...X'),
                            // silently single-deleting instead of surfacing the
                            // ambiguous-match (code 9) error below. Only absorb
                            // when the bare match is unique; otherwise leave
                            // eOldStr as _matchedOldStr so the occurrence.count
                            // > 1 ambiguous branch fires.
                            const _bareOccurrence = _findLiteralOccurrenceState(content, _matchedOldStr);
                            if (_bareOccurrence.count <= 1) {
                                if (content.includes(_matchedOldStr + '\r\n')) {
                                    eOldStr = _matchedOldStr + '\r\n';
                                } else if (content.includes(_matchedOldStr + '\n')) {
                                    eOldStr = _matchedOldStr + '\n';
                                }
                            }
                        }
                    }
                    let updated;
                    const occurrence = (eOldStr === oldStr && _oldLiteralOccurrence.count > 0)
                        ? _oldLiteralOccurrence
                        : _findLiteralOccurrenceState(content, eOldStr);
                    if (occurrence.count === 0) {
                        const crlfMatch = _findCrlfNormalisedMatches(content, oldStr);
                        const crlfCount = crlfMatch ? crlfMatch.ranges.length : 0;
                        if (crlfCount === 0) {
                            const _foldAmb = _foldTierAmbiguityError(content, oldStr, filePath);
                            if (_foldAmb) return _foldAmb;
                            return `Error [code 8]: old_string not found in ${filePath} (no exact/fold/nfc-fold/crlf-fold match).${_optionalEditMissDetails(content, oldStr, editSnapshot, { path: filePath, newString: newStr, replaceAll })}`;
                        }
                        if (crlfCount > 1 && !replaceAll)
                            return `Error [code 9]: old_string found ${crlfCount} times in ${filePath} (via crlf-fold);${_formatMatchLines(_occurrenceLinesCrlf(content, crlfMatch.ranges), crlfCount)} set replace_all:true or provide more unique context`;
                        updated = _replaceRangesFromOriginal(content, replaceAll ? crlfMatch.ranges : crlfMatch.ranges.slice(0, 1), newStr);
                        _matchInfo.stage = 'crlf-fold';
                    } else {
                        if (occurrence.count > 1 && !replaceAll) {
                            const count = _countLiteralOccurrences(content, eOldStr);
                            return `Error [code 9]: old_string found ${count} times in ${filePath}${_formatStageInline(_matchInfo.stage)};${_formatMatchLines(_occurrenceLinesPlain(content, eOldStr), count)} set replace_all:true or provide more unique context`;
                        }
                        if (replaceAll && Array.isArray(_pureDeletionRanges) && _pureDeletionRanges.length > 0) {
                            // Per-occurrence pure-deletion: extend each match
                            // over its own trailing LF/CRLF instead of a
                            // single global `eOldStr+'\n'` literal that would
                            // miss bare-X occurrences. See range collection
                            // above.
                            updated = _replaceRangesFromOriginal(content, _pureDeletionRanges, newStr);
                        } else {
                            const _indentFixedNewStr = newStr;
                            const _eolPreservedNewStr = _replacementForOriginalSlice(_indentFixedNewStr, eOldStr, content);
                            updated = replaceAll
                                ? content.split(eOldStr).join(_eolPreservedNewStr)
                                : _replaceSingleLiteralAt(content, occurrence.index, eOldStr, _eolPreservedNewStr);
                        }
                    }
                    // Atomic write — see `write` handler for rationale.
                    const _baseErrFinal = _preWriteBaseCheck();
                    if (_baseErrFinal) return _baseErrFinal;
                    await atomicWrite(fullPath, updated, {
                        sessionId: options?.sessionId,
                        mode: editStat.mode & 0o777,
                        expectedTargetSnapshot: _captureExpectedTargetSnapshot(fullPath, editStat),
                    });
                    invalidateBuiltinResultCache([fullPath]);
                    const writtenStat = _seedRawContentCacheAfterWrite(fullPath, updated);
                    markCodeGraphDirtyPaths([fullPath]);
                    // Refresh the snapshot to the post-write mtime so a chain
                    // of edits against the same file doesn't trip the stale
                    // check on the second hop. Keep partial-read coverage
                    // partial; an edit should not imply the model saw the
                    // whole file.
                    _recordReadSnapshot(fullPath, writtenStat || undefined, readStateScope, _postEditSnapshotMeta(editSnapshot, 'edit', updated, {
                        contentBeforeEdit: content,
                        oldStr: eOldStr,
                        newStr,
                        replaceAll,
                    }));
                    // Stage note surfaces non-exact matches so the model
                    // learns to send literal bytes next time and the user
                    // can spot silent typography / whitespace drift. Exact
                    // matches stay terse — they are the steady-state path.
                    const _stageNote = (_matchInfo.stage && _matchInfo.stage !== 'exact')
                        ? _formatStageNote({ [_matchInfo.stage]: 1 })
                        : '';
                    return `Edited: ${normalizeOutputPath(filePath)}${_stageNote}`;
                }
                catch (err) {
                    return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
                }
            }));
}
