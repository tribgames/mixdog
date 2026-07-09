import { readFileSync } from 'fs';
import { executeSingleReadTool } from './read-single-tool.mjs';
import { imageMimeForPath, readImageAsContent } from './read-image.mjs';
import { readEntryCoalescedDiskWindow } from './read-batch.mjs';
import { readPathStringGuardError } from './read-open.mjs';
import { parseReadLineNumberArg } from './read-args.mjs';
import { assertPathsReachable } from './fs-reachability.mjs';
import { coerceReadFamilyPathArg } from './path-utils.mjs';

function hasLineCoordinate(path) {
    return typeof path === 'string' && /(?:#L\d+|:\d+(?:-\d+)?(?::|$))/i.test(path);
}

// Pure-regex strip of a trailing line coordinate (`:N`, `:N-M`, `#LN`) — NO
// filesystem access. Used only to derive a statable base path for the async
// reachability preflight; the real read path does precise line-vs-colon
// disambiguation later (which uses existsSync and would itself block on a dead
// mount). A Windows drive colon `C:\...` is not a trailing `:digits`.
function _stripLineCoordForReach(s) {
    // Mirror the real resolver's coordinate suffix shapes (read-args.mjs):
    // `:N`, `:N-M`, `:N:C` (line:col / trailing detail), and `#LN`/`#LN-M`/`#LN...`.
    return String(s)
        .replace(/#L\d+(?:-L?\d+)?(?:\b.*)?$/i, '')
        .replace(/:\d+(?:-\d+)?(?::.*)?$/, '');
}

// Batch fan-out cap: array/object read shapes read only the first N entries
// (the >N slice below truncates the rest with a `_batchCapNote`). The
// reachability preflight must honour the SAME cap so a path that will be
// capped away is never stat-probed and can never reject the batch via a guard.
const READ_BATCH_PATH_CAP = 10;

function _collectReachCandidates(p) {
    const out = [];
    const push = (s) => { if (typeof s === 'string' && s) out.push(s); };
    if (typeof p === 'string') push(p);
    // Only the first READ_BATCH_PATH_CAP entries survive the fan-out cap, so
    // preflight only the paths that will actually be read. Capped-away paths
    // (incl. UNC/device) must NOT be probed or allowed to fail the batch.
    else if (Array.isArray(p)) for (const e of p.slice(0, READ_BATCH_PATH_CAP)) push((e && typeof e === 'object') ? (e.path ?? e.file_path) : e);
    return out;
}

// Same messages the inline string guards emit (image fast-path / single path).
// Used by the preflight to REJECT guarded paths up front so the later sync
// existsSync line-coordinate disambiguation never touches a UNC/device path.
function _guardedReadError(p, helpers) {
    const { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component, isBlockedDevicePath, normalizeOutputPath } = helpers;
    const o = (x) => (typeof normalizeOutputPath === 'function' ? normalizeOutputPath(x) : x);
    if (typeof isUncPath === 'function' && isUncPath(p))
        return `Error: cannot read UNC / SMB path (network credential leak risk): ${o(p)}`;
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(p))
        return `Error: cannot read Windows device path (reserved name or raw-device namespace): ${o(p)}`;
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(p))
        return `Error: cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${o(p)}`;
    if (typeof isBlockedDevicePath === 'function' && isBlockedDevicePath(p))
        return `Error: cannot read device file (would block or produce infinite output): ${o(p)}`;
    return null;
}

// Reachability preflight for EVERY read shape (scalar / array / reads[]). MUST
// run before any sync FS — including path normalization and the image
// stat/read. A dead mount would otherwise freeze the event loop, defeating even
// the 630s dispatch ceiling.
async function _readReachPreflight(rawPath, workDir, helpers) {
    const {
        normalizeInputPath, resolveAgainstCwd,
    } = helpers;
    // A guarded path (UNC/SMB, Windows device, ADS, /dev/* block) must be
    // REJECTED here, not skipped: skipping would let the later sync guard/open
    // path touch it and trigger NTLM/raw-device access or hang. Reject up front
    // with the same message the inline guards emit.
    // normalizeInputPath FIRST (FS-pure) so we stat the same path the real read
    // opens (e.g. /mnt/z/... -> Z:\...). Reachability is per-mount/dir, so the
    // line-coordinate strip only needs to land in the right directory — exact
    // suffix parsing is not required for the stat to be representative.
    const candidates = [];
    const seenFull = new Set();
    for (const raw of _collectReachCandidates(rawPath)) {
        const stripped = _stripLineCoordForReach(normalizeInputPath(raw));
        const full = resolveAgainstCwd(stripped, workDir);
        const guardMsg = _guardedReadError(stripped, helpers) || _guardedReadError(full, helpers);
        if (guardMsg) return guardMsg;
        // Dedup by resolved path so a batch repeating the same file (or the
        // same union window) issues one stat probe, not one per entry —
        // bounding the preflight's FS work to the distinct target set.
        if (seenFull.has(full)) continue;
        seenFull.add(full);
        candidates.push(full);
    }
    if (candidates.length === 0) return null;
    try { await assertPathsReachable(candidates); return null; }
    catch (e) { return `Error: ${e?.message || e}`; }
}

export async function executeReadTool(args, workDir, readStateScope, executeChildBuiltinTool, options = {}, helpers = {}) {
    const {
        classifyResultKind,
        coalesceObjectReadEntries,
        coerceShapeFlex,
        isBlockedDevicePath,
        isUncPath,
        isWindowsDevicePath,
        hasUnsafeWin32Component,
        normalizeInputPath,
        normalizeOutputPath,
        normaliseReadLineWindowArgs,
        resolveAgainstCwd,
        sliceReadBodyByLines,
        _hashText,
        _isFullModeReadEntry,
        _mergeReadRanges,
        _rangeHashesFromRenderedReadText,
        _readEntryLineWindow,
        _recordReadSnapshot,
    } = helpers;
    // CC `file_path` alias — official SDK schema uses `file_path`;
    // mixdog has historically used `path`. Honor `file_path` so a
    // CC-trained agent's call shape works without translation.
    const usedFilePathAlias = typeof args.file_path === 'string' && !args.path;
    if (usedFilePathAlias) {
        args.path = args.file_path;
        const ccOffset = Number(args.offset);
        if (args.offset !== undefined && args.offset !== null && Number.isFinite(ccOffset) && ccOffset > 0) {
            args.offset = Math.trunc(ccOffset) - 1;
        }
    }
    args.path = coerceReadFamilyPathArg(args.path, workDir);
    // Reachability preflight up front (all shapes) — before readPathStringGuardError /
    // image stat, all of which can touch sync FS.
    // options._skipReachPreflight: set only by the batch dispatcher on its
    // child reads (below). The parent batch call already ran this exact
    // preflight over EVERY candidate path in the array (_collectReachCandidates
    // covers array/object shapes), so re-running it per child re-stats the same
    // mounts N times. The UNC/device/ADS string guards still run inside the
    // child (readPathStringGuardError / image fast-path) — only the async
    // reachability stat is skipped, never the security guards.
    if (options?._skipReachPreflight !== true) {
        const _reErr = await _readReachPreflight(args.path, workDir, helpers);
        if (_reErr) return _reErr;
    }
    // Image files (png/jpg/jpeg/gif/webp): return an MCP image block so the
    // model can actually SEE the image. native Read does this, but mixdog's
    // Read is shim-blocked, so this is the only image-view path. Single string
    // path only — batch and head/tail/count modes stay text.
    // options.mediaTextOnly is set by the batch dispatcher (child reads are
    // assembled into a flat string), so an image content-block object would
    // stringify to "[object Object]". Skip the image fast-path in that context
    // and let the file fall through to the normal text/binary read, which
    // emits a string. Scalar reads (no mediaTextOnly) get the rich image block.
    if (options?.mediaTextOnly !== true && typeof args.path === 'string' && imageMimeForPath(args.path)) {
        const _imgNorm = normalizeInputPath(args.path);
        // W1 H: device-file / UNC / Windows-device / ADS guards must run
        // BEFORE the image fast-path so statSync/readFileSync of a
        // UNC/device path can't bypass the checks the normal read path
        // enforces (NTLM hash leak, raw-device access, ADS).
        if (typeof isUncPath === 'function' && isUncPath(_imgNorm))
            return `Error: cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(_imgNorm)}`;
        if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(_imgNorm))
            return `Error: cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(_imgNorm)}`;
        if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(_imgNorm))
            return `Error: cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(_imgNorm)}`;
        if (isBlockedDevicePath(_imgNorm))
            return `Error: cannot read device file (would block or produce infinite output): ${normalizeOutputPath(_imgNorm)}`;
        const _imgFull = resolveAgainstCwd(_imgNorm, workDir);
        if (typeof isUncPath === 'function' && isUncPath(_imgFull))
            return `Error: cannot read UNC / SMB path (network credential leak risk): ${normalizeOutputPath(_imgFull)}`;
        if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(_imgFull))
            return `Error: cannot read Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(_imgFull)}`;
        if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(_imgFull))
            return `Error: cannot read Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(_imgFull)}`;
        const _imgResult = await readImageAsContent(_imgFull, normalizeOutputPath(_imgNorm));
        if (_imgResult) return _imgResult;
    }
    // Unified-read dispatch (v0.6.283+):
    //   reads: [{path, mode?, n?, offset?, limit?, full?}]
    //                               → per-file batch (different
    //                                 ranges per file in one call)
    //   path: string[] | object[]   → parallel per-file batch
    //                                 (top-level opts apply uniformly)
    //   mode: 'head'|'tail'|'count' → head / tail / wc handlers
    //   else                        → single-file read below.
    // Single turn can touch many files or swap modes without
    // the agent iterating across multiple tool names.
    if (Array.isArray(args.path) && args.path.length > 0 && args.path[0] && typeof args.path[0] === 'object') {
        // Cap batch fan-out: never error on an oversized array, just
        // truncate and note it in the final output (mirrors list-tool.mjs
        // path[] cap pattern).
        if (args.path.length > 10) {
            const _origObjLen = args.path.length;
            args.path = args.path.slice(0, 10);
            args._batchCapNote = `... [capped at 10 of ${_origObjLen} paths]`;
        }
        // Per-file batch: each entry carries its own options.
        // Coalesce same-path entries: multiple chunks for the same
        // file are merged into a single wider read (min offset to max
        // offset+limit) so the file is only opened once. The merged
        // result is sliced back into the original per-entry windows
        // for response assembly. Non-same-path entries are untouched.
        const rawEntries = args.path.map((r) => {
            // CC `file_path` alias on a per-entry batch: file_path is
            // 1-based (CC schema), so decrement a positive offset to
            // match the 0-based `path` form. Mirrors the scalar
            // alias adjustment at line 57.
            const entryUsesFilePathAlias = typeof r?.file_path === 'string' && !r?.path;
            let entry = { path: normalizeInputPath(r?.path ?? r?.file_path ?? '') };
            if (r?.mode !== undefined) entry.mode = r.mode;
            if (r?.n !== undefined) entry.n = r.n;
            if (r?.offset !== undefined) {
                if (entryUsesFilePathAlias) {
                    const ccOff = Number(r.offset);
                    entry.offset = (Number.isFinite(ccOff) && ccOff > 0) ? Math.trunc(ccOff) - 1 : r.offset;
                } else {
                    entry.offset = r.offset;
                }
            }
            if (r?.limit !== undefined) entry.limit = r.limit;
            if (r?.full !== undefined) entry.full = r.full;
            entry = normaliseReadLineWindowArgs(entry, workDir);
            return entry;
        });
        const _invertedRawEntry = rawEntries.find((e) => e && e._invertedRangeError);
        if (_invertedRawEntry) return _invertedRawEntry._invertedRangeError;
        // Cluster nearby same-file ranges instead of merging every
        // range into one huge window. Far-apart reads stay separate,
        // which avoids scanning and then slicing thousands of lines
        // just to return two tiny windows.
        const entries = coalesceObjectReadEntries(rawEntries, (p) => resolveAgainstCwd(p, workDir));
        // Deduplicate so the same union-range is read only once per path.
        const _seen = new Map(); // cacheKey → dedupedEntries index
        const dedupedEntries = [];
        const entryToDeduped = []; // entries[i] → dedupedEntries index
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const _diskWin = readEntryCoalescedDiskWindow(e);
            const key = `${e.path}|${_diskWin?.offset ?? e.offset ?? ''}|${_diskWin?.limit ?? e.limit ?? ''}|${e.mode ?? ''}|${e.n ?? ''}|${e.full ?? ''}`;
            if (_seen.has(key)) { entryToDeduped.push(_seen.get(key)); }
            else { _seen.set(key, dedupedEntries.length); entryToDeduped.push(dedupedEntries.length); dedupedEntries.push(e); }
        }
        if (entries.length === 0) return 'Error: reads array must not be empty';
        // Dispatch deduplicated reads in parallel; re-assemble in original order.
        args = { ...args, path: dedupedEntries.map(e => e.path) };
        args._readsEntries = dedupedEntries;
        args._readsOrigEntries = entries;
        args._readsEntryToDeduped = entryToDeduped;
        args.mode = undefined; args.n = undefined; args.offset = undefined; args.limit = undefined; args.full = undefined;
    }
    if (Array.isArray(args.path)) {
        if (args.path.length > 10) {
            const _origStrLen = args.path.length;
            args.path = args.path.slice(0, 10);
            if (!args._batchCapNote) args._batchCapNote = `... [capped at 10 of ${_origStrLen} paths]`;
        }
        // Schema is `path: string | string[]` — array entries are
        // strings only. Top-level mode / n / offset / limit / full
        // apply uniformly to every entry in the batch (the only
        // caller is the manager prefetch helper, which already
        // shapes its calls that way). When _readsEntries is set,
        // per-entry options override the uniform set.
        const overrides = Array.isArray(args._readsEntries) ? args._readsEntries : null;
        const entries = args.path.map((p, i) => {
            if (overrides && overrides[i]) return overrides[i];
            let entry = (p && typeof p === 'object')
                ? { path: normalizeInputPath(p.path ?? p.file_path ?? '') }
                : { path: normalizeInputPath(p) };
            if (args.mode !== undefined) entry.mode = args.mode;
            if (args.n !== undefined) entry.n = args.n;
            if (args.offset !== undefined) entry.offset = args.offset;
            if (args.limit !== undefined) entry.limit = args.limit;
            if (args.full !== undefined) entry.full = args.full;
            entry = normaliseReadLineWindowArgs(entry, workDir);
            return entry;
        });
        const _invertedStrEntry = entries.find((e) => e && e._invertedRangeError);
        if (_invertedStrEntry) return _invertedStrEntry._invertedRangeError;
        if (entries.length === 0) return 'Error: path array must not be empty';
        // Parallel dispatch of the individual reads via the same case
        // above — reuses size cap, line-number formatting.
        // Per-file errors come back as their own string and are pasted
        // into the aggregate rather than aborting the whole batch.
        // When origEntries/entryToDeduped set (reads[] coalesce path),
        // re-order results to match the caller's original entry order.
        const _origEntries2 = Array.isArray(args._readsOrigEntries) ? args._readsOrigEntries : null;
        const _entryMap2 = Array.isArray(args._readsEntryToDeduped) ? args._readsEntryToDeduped : null;
        // Dedup string-batch entries by RESOLVED path + window so a file that
        // appears twice (incl. two path strings that resolve to the same file)
        // is stat/opened/read ONCE, not per duplicate. Duplicates copy the
        // primary's body, keeping the per-index render byte-identical. Skipped
        // when `overrides` (reads[] coalesce path) is set — those entries were
        // already deduped upstream and carry the union-slice bookkeeping.
        const _readIndexFor = new Array(entries.length);
        if (!overrides) {
            const _dedup = new Map();
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                if (!e || !e.path) { _readIndexFor[i] = i; continue; }
                const rp = resolveAgainstCwd(e.path, workDir);
                const k = `${rp}|${e.mode ?? ''}|${e.offset ?? ''}|${e.limit ?? ''}|${e.n ?? ''}|${e.full ?? ''}`;
                if (_dedup.has(k)) { _readIndexFor[i] = _dedup.get(k); }
                else { _dedup.set(k, i); _readIndexFor[i] = i; }
            }
        } else {
            for (let i = 0; i < entries.length; i++) _readIndexFor[i] = i;
        }
        const tasks = entries.map((entry, index) => ({
            entry,
            index,
            offset: _isFullModeReadEntry(entry) ? _readEntryLineWindow(entry).offset : 0,
        })).filter((t) => _readIndexFor[t.index] === t.index).sort((a, b) => {
            const ap = a.entry?.path || '';
            const bp = b.entry?.path || '';
            if (ap !== bp) return ap < bp ? -1 : 1;
            if (a.offset !== b.offset) return a.offset - b.offset;
            return a.index - b.index;
        });
        const results = new Array(entries.length);
        const readChains = new Map();
        await Promise.all(tasks.map(({ entry, index }) => {
            if (!entry || !entry.path) {
                results[index] = { path: '(missing-path)', mode: 'full', body: 'Error: path is required.' };
                return Promise.resolve();
            }
            const run = async () => {
                const _diskWin = readEntryCoalescedDiskWindow(entry);
                const readEntry = _diskWin
                    ? { ...entry, offset: _diskWin.offset, limit: _diskWin.limit }
                    : entry;
                // mediaTextOnly: a batch aggregate is assembled as a flat
                // string (String(r.body) + join), so media branches must
                // return text (pdf-parse text / notebook text), never a
                // document/image content-block object that would stringify to
                // "[object Object]" and drop the payload. Scalar reads (the
                // single-file path below) keep the rich block shapes.
                const body = await executeChildBuiltinTool('read', readEntry, workDir, { suppressReadUnchangedStub: true, mediaTextOnly: true, _skipReachPreflight: true });
                results[index] = { path: entry.path, mode: entry.mode || 'full', n: entry.n, body };
            };
            const key = entry.path || `#missing-${index}`;
            const prev = readChains.get(key) ?? Promise.resolve();
            const next = prev.then(run);
            readChains.set(key, next.catch(() => {}));
            return next;
        }));
        // Fan the primary read's result out to its duplicate indices so every
        // caller slot is populated without a second disk window.
        for (let i = 0; i < entries.length; i++) {
            const src = _readIndexFor[i];
            if (src === i) continue;
            const e = entries[i];
            const s = results[src];
            results[i] = s
                ? { path: e.path, mode: e.mode || 'full', n: e.n, body: s.body }
                : { path: e.path, mode: e.mode || 'full', n: e.n, body: 'Error: dedup mapping failed' };
        }
        const orderedResults = _origEntries2
            ? _origEntries2.map((orig, i) => {
                const r = results[_entryMap2 ? _entryMap2[i] : i] || { path: orig.path, mode: orig.mode || 'full', body: 'Error: dedup mapping failed' };
                const isFullMode = !orig.mode || orig.mode === 'full';
                // Coalesced batch reads fetch the union window from disk; every
                // caller slot must be sliced back to its original request window
                // (_orig*), not the coalesced union offset/limit fields.
                const needsSlice = isFullMode && orig._needsPerEntrySlice === true;
                const origOffset = typeof orig._origOffset === 'number' ? orig._origOffset : 0;
                const origLimit = typeof orig._origLimit === 'number'
                    ? orig._origLimit
                    : 2000;
                const body = needsSlice
                    ? sliceReadBodyByLines(r.body, origOffset, origLimit)
                    : r.body;
                return { ...r, mode: orig.mode || 'full', n: orig.n, body };
            })
            : results;
        if (_origEntries2) {
            const exactRangesByPath = new Map();
            const rangeHashesByPath = new Map();
            for (const r of orderedResults) {
                if (!r || r.mode !== 'full' || classifyResultKind(String(r.body || '')) === 'error') continue;
                const m = String(r.body || '').match(/\[lines\s+(\d+)-(\d+)\s+of\s+(\d+)/);
                if (!m) continue;
                const startLine = Number(m[1]);
                const endLineRaw = Number(m[2]);
                if (!Number.isFinite(startLine) || !Number.isFinite(endLineRaw)) continue;
                const endLine = endLineRaw;
                const fullPath = resolveAgainstCwd(r.path, workDir);
                if (!exactRangesByPath.has(fullPath)) exactRangesByPath.set(fullPath, []);
                const range = { startLine, endLine };
                exactRangesByPath.get(fullPath).push(range);
                const renderedHashes = _rangeHashesFromRenderedReadText(r.body, [range]);
                if (renderedHashes.length > 0) {
                    if (!rangeHashesByPath.has(fullPath)) rangeHashesByPath.set(fullPath, []);
                    rangeHashesByPath.get(fullPath).push(...renderedHashes);
                }
            }
            for (const [fullPath, ranges] of exactRangesByPath) {
                const mergedRanges = _mergeReadRanges(ranges);
                let rangeHashes = rangeHashesByPath.get(fullPath) || [];
                if (rangeHashes.length === 0 && mergedRanges.length > 0) {
                    try {
                        const rawLines = readFileSync(fullPath, 'utf-8').split('\n');
                        rangeHashes = mergedRanges.map((range) => {
                            const startIdx = Math.max(0, range.startLine - 1);
                            const endIdx = Math.min(rawLines.length, range.endLine);
                            return { ...range, hash: _hashText(rawLines.slice(startIdx, endIdx).join('\n')) };
                        });
                    } catch { /* best-effort range hashes */ }
                }
                _recordReadSnapshot(fullPath, undefined, readStateScope, {
                    source: 'read_batch_sliced',
                    ranges: mergedRanges,
                    rangeHashes,
                    replaceExisting: true,
                });
            }
        }
        // Header path → forward slash; error bodies already normalised
        // inside the read case's catch blocks. When `read` emitted a
        // smart-cap marker, surface the truncation state in the header
        // so downstream skimming spots it without parsing the body.
        const summaries = [];
        for (const r of orderedResults) {
            if (r.mode === 'count') {
                const m = String(r.body || '').match(/lines\t(\d+)/);
                if (m) summaries.push(`${normalizeOutputPath(r.path)} has ${m[1]} lines`);
            }
        }
        const summaryLine = summaries.length ? ` ${summaries.join('; ')}` : '';
        const failedReads = orderedResults.filter((r) => classifyResultKind(String(r.body || '')) === 'error').length;
        // reject_partial:true — when the caller asked for all-or-none,
        // refuse to return a mixed payload that downstream parsers
        // would have to disambiguate per-entry.
        if (failedReads > 0 && args.reject_partial === true) {
            const reasons = orderedResults
                .filter((r) => classifyResultKind(String(r.body || '')) === 'error')
                .map((r) => `${normalizeOutputPath(r.path)}: ${String(r.body || '').split('\n')[0]}`)
                .join('; ');
            return `Error: batch read rejected (${failedReads} of ${orderedResults.length} failed; reject_partial:true) — ${reasons}`;
        }
        // Default: surface per-entry status tags ([ok]/[error]) so a
        // downstream classifyResultKind treats the aggregate as a
        // structured report rather than a single error string. The
        // header avoids the leading `Error:` prefix because some
        // entries succeeded; failure count is reported in parens.
        const header = failedReads > 0
            ? `read ${orderedResults.length} (${failedReads} failed)${summaryLine}`
            : `read ${orderedResults.length}${summaryLine}`;
        // Identical-entry dedup: when the caller puts the exact same window
        // twice in the path array, coalesceObjectReadEntries already merges
        // the disk read, but the 1:1 request/response contract still renders
        // every index. Emit a reference placeholder for byte-identical repeats
        // (same path + same mode + same body) so the duplicate body is not
        // materialised twice -- the entry keeps its index, only the body is
        // elided. With no duplicates the output is byte-for-byte unchanged.
        const _seenEntryBody = new Map();
        const body = orderedResults.map((r, _i) => {
            const path = normalizeOutputPath(r.path);
            const mode = r.n !== undefined ? `${r.mode} n=${r.n}` : r.mode;
            const status = classifyResultKind(String(r.body || '')) === 'error' ? 'error' : 'ok';
            const dupKey = JSON.stringify([path, mode, r.body || '']);
            const priorIdx = _seenEntryBody.get(dupKey);
            if (priorIdx !== undefined) {
                return `${path} [${mode}] [${status}] [= entry #${priorIdx + 1}, identical result omitted]`;
            }
            _seenEntryBody.set(dupKey, _i);
            const match = /\[TRUNCATED (?:—|-) file is (\d+) lines \/ (\d+) KB\./.exec(r.body || '');
            const suffix = match ? ` (truncated ${match[1]}L/${match[2]}KB)` : '';
            return `${path} [${mode}] [${status}]${suffix}\n${r.body}`;
        }).join('\n\n');
        return `${header}\n\n${body}${args._batchCapNote ? `\n\n${args._batchCapNote}` : ''}`;
    }
    // W1 H: device-file / UNC / scope guards must run BEFORE mode
    // dispatches so head/tail/wc internal readers can't bypass the
    // /dev/* block that the default-mode branch enforces.
    if (typeof args.path === 'string' && args.path) {
        const _modeGuardErr = readPathStringGuardError(args.path, workDir);
        if (_modeGuardErr) return `Error: ${_modeGuardErr}`;
    }
    if (typeof args.path === 'string') {
        args.path = normalizeInputPath(args.path);
        // Symbol reads are span-driven. Models (notably gpt-5.5) co-send the whole
        // schema filled with placeholder/zero values (offset:0, limit:0, line:0,
        // context:0, pages:'', mode) alongside symbol, which
        // otherwise makes the symbol branch think a window was requested and falls
        // back to a 0-window read. Treat those zero/empty/mode params as
        // absent so the whole symbol body returns in ONE call; a MEANINGFUL window
        // (offset>0 / limit>0 / non-empty pages / real line) is kept and overrides.
        if (typeof args.symbol === 'string' && args.symbol.trim()) {
            if (args.offset === 0) delete args.offset;
            if (args.limit === 0) delete args.limit;
            if (args.line === 0) delete args.line;
            if (args.pages === '') delete args.pages;
            if (args.mode !== undefined) delete args.mode;
        }
        const sym = typeof args.symbol === 'string' ? args.symbol.trim() : '';
        if (sym) {
            const hasOffset = args.offset !== undefined && args.offset !== null;
            const hasLimit = args.limit !== undefined && args.limit !== null;
            const hasPages = args.pages !== undefined && args.pages !== null;
            const disambigLine = parseReadLineNumberArg(args.line);
            const pathHasLine = hasLineCoordinate(args.path);
            const explicitLineWindow = pathHasLine || (disambigLine != null && (
                (args.context !== undefined && args.context !== null)
                || (args.limit !== undefined && args.limit !== null)
            ));
            if (!hasPages && !explicitLineWindow) {
                const { resolveSymbolReadSpan } = await import('../code-graph.mjs');
                const span = await resolveSymbolReadSpan(workDir, {
                    symbol: sym,
                    path: args.path,
                    language: typeof args.language === 'string' ? args.language.trim() || null : null,
                    line: disambigLine,
                });
                if (span.error) return `Error: ${span.error}`;
                // offset/limit COMPOSE INSIDE the symbol body ("lines N..M of
                // the definition"). The previous behavior silently dropped
                // symbol= whenever a window arg was present, so
                // `symbol:X, limit:15` returned the FILE's first 15 lines —
                // a wasted call that looks like a successful read.
                const innerOffset = hasOffset ? Math.max(0, Math.trunc(Number(args.offset)) || 0) : 0;
                const spanRemaining = span.limit - innerOffset;
                if (spanRemaining <= 0) {
                    return `Error: offset ${innerOffset} is beyond symbol "${sym}" body (${span.limit} lines)`;
                }
                args.offset = span.offset + innerOffset;
                const innerLimit = hasLimit ? Math.max(1, Math.trunc(Number(args.limit)) || 1) : spanRemaining;
                args.limit = Math.min(innerLimit, spanRemaining);
                if (span.note) args._symbolReadNote = `symbol ${sym}: ${span.note}`;
            }
        }
        // A window (offset/limit or a path:line coordinate) beats a glance
        // mode (head/tail/summary), which would otherwise read from a file end and
        // silently drop the window. Drop the glance mode BEFORE path:line
        // compatibility normalization so any path coordinate is converted to
        // offset/limit. count/hex are not text-window ops and keep their mode.
        {
            const _win = args.offset != null || args.limit != null || hasLineCoordinate(args.path);
            if (_win && (args.mode === 'head' || args.mode === 'tail' || args.mode === 'summary')) {
                args = { ...args, mode: undefined };
            }
        }
        args = normaliseReadLineWindowArgs(args, workDir);
        if (args._invertedRangeError) return args._invertedRangeError;
    }
    // Mode routing. A window already dropped any conflicting head/tail/summary
    // glance above (so the window is served by executeSingleReadTool); what
    // remains here is a mode-only read, or count/hex which are not text windows.
    if (args.mode === 'head') return executeChildBuiltinTool('head', { path: args.path, n: args.n }, workDir);
    if (args.mode === 'tail') return executeChildBuiltinTool('tail', { path: args.path, n: args.n }, workDir);
    if (args.mode === 'count') return executeChildBuiltinTool('wc', { path: args.path }, workDir);
    if (args.mode === 'summary') return executeChildBuiltinTool('summary', { path: args.path, n: args.n, limit: args.limit }, workDir);
    if (args.mode === 'hex') return executeChildBuiltinTool('hex', { path: args.path, n: args.n, offset: args.offset }, workDir);
    return executeSingleReadTool(args, workDir, readStateScope, options, helpers);

}
