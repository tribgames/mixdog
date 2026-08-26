import { readFile } from 'fs/promises';
import { executeSingleReadTool } from './read-single-tool.mjs';
import { imageMimeForPath, readImageAsContent } from './read-image.mjs';
import { readEntryCoalescedDiskWindow } from './read-batch.mjs';
import { readPathStringGuardError } from './read-open.mjs';
import { parseReadLineNumberArg } from './read-args.mjs';
import { assertPathsReachable } from './fs-reachability.mjs';
import { existsSync } from 'fs';
import { coerceReadFamilyPathArg, hasGlobMagic } from './path-utils.mjs';
import { readIoAdmission } from '../../../../shared/tool-workload-gates.mjs';
import { currentToolExecutionOwner } from '../../../../shared/tool-execution-owner.mjs';

// Per-entry status in a batch. A conclusively missing file is not a failed
// read — that is why its body is `[path absent]` and not `Error:` — but it is
// not `ok` either: the header said `missing.png [ok]` above a body saying the
// file does not exist, which is the one line a skimming reader trusts. Absence
// gets its own tag so the header and the body agree.
function batchEntryStatus(body, failed, textBody) {
    if (failed) return 'error';
    return /^\s*\[path absent\]/.test(String(textBody ?? body ?? '')) ? 'absent' : 'ok';
}

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

function _collectReachCandidates(p) {
    const out = [];
    const push = (s) => { if (typeof s === 'string' && s) out.push(s); };
    if (typeof p === 'string') push(p);
    else if (Array.isArray(p)) for (const e of p) push((e && typeof e === 'object') ? (e.path ?? e.file_path) : e);
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
// run before any filesystem access. Besides bounding a dead mount, its Stats
// objects seed the real read so the common path does not immediately re-stat.
async function _readReachPreflight(rawPath, workDir, helpers) {
    const {
        normalizeInputPath, resolveAgainstCwd,
    } = helpers;
    // A guarded path (UNC/SMB, Windows device, ADS, /dev/* block) must be
    // REJECTED here, not skipped: skipping would let the later guard/open
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
        if (guardMsg) return { error: guardMsg, statsByPath: null };
        // Dedup by resolved path so a batch repeating the same file (or the
        // same union window) issues one stat probe, not one per entry —
        // bounding the preflight's FS work to the distinct target set.
        if (seenFull.has(full)) continue;
        seenFull.add(full);
        candidates.push(full);
    }
    if (candidates.length === 0) return { error: null, statsByPath: new Map() };
    try {
        const stats = await assertPathsReachable(candidates);
        const statsByPath = new Map();
        for (let i = 0; i < candidates.length; i++) {
            if (stats[i]) statsByPath.set(candidates[i], stats[i]);
        }
        return { error: null, statsByPath };
    } catch (e) {
        return { error: `Error: ${e?.message || e}`, statsByPath: null };
    }
}

// Per-file hard cap for glob fan-out. Sampling many files at the single-file
// default turns one call into thousands of context lines, while format/shape
// evidence needs only a small head from each file. Exact-path reads keep the
// standard defaults.
// MIXDOG_READ_GLOB_SURVEY_LIMIT overrides for A/B runs.
const READ_GLOB_SURVEY_LIMIT = 25;
const READ_GLOB_OUTPUT_BUDGET_BYTES = 10 * 1024;
function _readGlobSurveyLimit() {
    const parsed = parseInt(process.env.MIXDOG_READ_GLOB_SURVEY_LIMIT ?? '', 10);
    return parsed > 0 ? parsed : READ_GLOB_SURVEY_LIMIT;
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
        READ_MAX_OUTPUT_BYTES,
    } = helpers;
    // `file_path` alias — the official SDK schema uses `file_path`;
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
    // Reachability preflight up front (all shapes) — before
    // readPathStringGuardError / image stat.
    // options._skipReachPreflight: set only by the batch dispatcher on its
    // child reads (below). The parent batch call already ran this exact
    // preflight over EVERY candidate path in the array (_collectReachCandidates
    // covers array/object shapes), so re-running it per child re-stats the same
    // mounts N times. The UNC/device/ADS string guards still run inside the
    // child (readPathStringGuardError / image fast-path) — only the async
    // reachability stat is skipped, never the security guards.
    if (options?._skipReachPreflight !== true) {
        const _preflight = await _readReachPreflight(args.path, workDir, helpers);
        if (_preflight.error) return _preflight.error;
        options = { ...options, _preflightStats: _preflight.statsByPath };
    }
    // Image files (png/jpg/jpeg/gif/webp): return an MCP image block so the
    // model can actually SEE the image. native Read does this, but mixdog's
    // Read is shim-blocked, so this is the only image-view path. Batch children
    // opt into this rich path for full image reads and the parent flattens each
    // child's content parts into one structured result. mediaTextOnly remains
    // available for callers that explicitly require a flat text result.
    if (options?.mediaTextOnly !== true && typeof args.path === 'string' && imageMimeForPath(args.path)) {
        const _imgNorm = normalizeInputPath(args.path);
        // W1 H: device-file / UNC / Windows-device / ADS guards must run
        // BEFORE the image fast-path so stat/readFile of a
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
        const _imgResult = await readImageAsContent(
            _imgFull,
            normalizeOutputPath(_imgNorm),
            options?._preflightStats?.get?.(_imgFull) || null,
        );
        if (_imgResult) return _imgResult;
    }
    // head-glob sampling: read "/app/logs/*.log" limit=5 fans out to the
    // parallel per-file batch below — same semantics as `head -n5 *.log`,
    // one result with per-file headers. Literal paths always win: a REAL
    // file named "[id].tsx" or "{slug}.md" is read as itself; only a
    // non-existent magic path expands. Cap 10 files (glob's mtime order,
    // newest first); top-level offset/limit apply per file. Zero glob
    // matches fall through to the single-read path so the raw pattern gets
    // the standard ENOENT + suggestion machinery.
    if (typeof args.path === 'string' && hasGlobMagic(args.path) && typeof executeChildBuiltinTool === 'function') {
        const _globNorm = normalizeInputPath(args.path);
        let _literalExists = false;
        try { _literalExists = existsSync(resolveAgainstCwd(_stripLineCoordForReach(_globNorm), workDir)); } catch { /* treat as non-literal */ }
        if (!_literalExists) {
            const READ_GLOB_CAP = 10;
            let _globOut = '';
            try { _globOut = String(await executeChildBuiltinTool('glob', { pattern: _globNorm, head_limit: READ_GLOB_CAP + 1 }, workDir) || ''); }
            catch { _globOut = ''; }
            // Note lines the glob tool can emit; everything else is a path.
            // The old prefix filter dropped legitimate names such as
            // `[id].tsx`, `(draft).md` or `...rest.ts`.
            const _isGlobNoteLine = (l) => (
                l.startsWith('# ')
                || l.startsWith('... [')
                || l.startsWith('(no ')
                || l.startsWith('Error: ')
                || (/^\[.+\]$/.test(l) && /\s/.test(l))
            );
            const _globFiles = _globOut.split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !_isGlobNoteLine(l));
            if (_globFiles.length > 0) {
                const _capped = _globFiles.slice(0, READ_GLOB_CAP);
                const _capNote = _globFiles.length > READ_GLOB_CAP
                    ? `\n[glob expansion capped at ${READ_GLOB_CAP} files (newest first); narrow the pattern for the rest]`
                    : '';
                const _surveyArgs = { ...args, path: _capped, file_path: undefined };
                const _survey = _readGlobSurveyLimit();
                const _requestedLimit = Number(_surveyArgs.limit);
                _surveyArgs.limit = Number.isFinite(_requestedLimit) && _requestedLimit > 0
                    ? Math.min(Math.trunc(_requestedLimit), _survey)
                    : _survey;
                const _expanded = await executeReadTool(
                    _surveyArgs,
                    workDir, readStateScope, executeChildBuiltinTool, {
                        ...options,
                        readOutputBudgetBytes: Math.min(
                            Number(options?.readOutputBudgetBytes) > 0
                                ? Number(options.readOutputBudgetBytes)
                                : READ_GLOB_OUTPUT_BUDGET_BYTES,
                            READ_GLOB_OUTPUT_BUDGET_BYTES,
                        ),
                    }, helpers,
                );
                if (!_capNote) return _expanded;
                if (typeof _expanded === 'string') return _expanded + _capNote;
                if (_expanded && typeof _expanded === 'object' && Array.isArray(_expanded.content)) {
                    return { ..._expanded, content: [..._expanded.content, { type: 'text', text: _capNote.trim() }] };
                }
                return _expanded;
            }
        }
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
        // Per-file batch: each entry carries its own options.
        // Coalesce same-path entries: multiple chunks for the same
        // file are merged into a single wider read (min offset to max
        // offset+limit) so the file is only opened once. The merged
        // result is sliced back into the original per-entry windows
        // for response assembly. Non-same-path entries are untouched.
        const rawEntries = args.path.map((r) => {
            // `file_path` alias on a per-entry batch: file_path is
            // 1-based (SDK schema), so decrement a positive offset to
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
        // A path[] Read shares one byte ceiling. Reserve room for headers and
        // split the remaining body budget across distinct disk windows.
        const _readCallBudget = Number(options?.readOutputBudgetBytes) > 0
            ? Math.min(READ_MAX_OUTPUT_BYTES, Math.trunc(Number(options.readOutputBudgetBytes)))
            : READ_MAX_OUTPUT_BYTES;
        const _headerReserve = Math.min(
            Math.max(2_048, entries.reduce((sum, entry) => (
                sum + Buffer.byteLength(String(normalizeOutputPath(entry?.path || '(missing-path)')), 'utf8') + 128
            ), 0)),
            Math.floor(_readCallBudget / 2),
        );
        const _perTaskOutputBudget = Math.max(
            256,
            Math.floor((_readCallBudget - _headerReserve) / Math.max(1, tasks.length)),
        );
        const results = new Array(entries.length);
        const readChains = new Map();
        await Promise.all(tasks.map(({ entry, index }) => {
            if (!entry || !entry.path) {
                results[index] = { path: '(missing-path)', mode: 'full', body: 'Error: path is required.' };
                return Promise.resolve();
            }
            const run = async () => {
                const _diskWin = readEntryCoalescedDiskWindow(entry);
                let readEntry = _diskWin
                    ? { ...entry, offset: _diskWin.offset, limit: _diskWin.limit }
                    : entry;
                if ((!readEntry.mode || readEntry.mode === 'full')
                    && readEntry.offset == null
                    && readEntry.limit == null
                    && readEntry.full !== true) {
                    readEntry = { ...readEntry, offset: 0, limit: 2000 };
                }
                // Full image children retain their rich blocks; the aggregate
                // assembler below flattens them without stringification.
                // Other media (PDF/notebook) remains text-only in a batch so
                // its existing per-entry rendering contract is unchanged.
                const richImage = (!readEntry.mode || readEntry.mode === 'full')
                    && !!imageMimeForPath(readEntry.path);
                const body = await executeChildBuiltinTool('read', readEntry, workDir, {
                    suppressReadUnchangedStub: true,
                    mediaTextOnly: !richImage,
                    _skipReachPreflight: true,
                    forceReadRangeStream: true,
                    readOutputBudgetBytes: _perTaskOutputBudget,
                    toolOutputMaxBytes: _perTaskOutputBudget,
                });
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
                const body = needsSlice && typeof r.body === 'string'
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
                        const rawLines = (await readFile(fullPath, 'utf-8')).split('\n');
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
        const richPartsFor = (value) => (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && Array.isArray(value.content)
        ) ? value.content : null;
        const bodyTextFor = (value) => {
            const parts = richPartsFor(value);
            if (!parts) return String(value || '');
            return parts
                .map((part) => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
                .filter(Boolean)
                .join('\n');
        };
        const bodyFailed = (value) => (
            value?.isError === true
            || classifyResultKind(bodyTextFor(value)) === 'error'
        );
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
        const failedReads = orderedResults.filter((r) => bodyFailed(r.body)).length;
        // reject_partial:true — when the caller asked for all-or-none,
        // refuse to return a mixed payload that downstream parsers
        // would have to disambiguate per-entry.
        // All-or-none is about DELIVERY: an entry that returned no content did
        // not deliver, whether it failed outright or was conclusively absent.
        // Counting only hard failures let a batch with a missing file through
        // as a mixed payload — exactly what the caller asked not to receive.
        const undelivered = orderedResults.filter(
            (r) => batchEntryStatus(r.body, bodyFailed(r.body), bodyTextFor(r.body)) !== 'ok',
        );
        if (undelivered.length > 0 && args.reject_partial === true) {
            const reasons = undelivered
                .map((r) => `${normalizeOutputPath(r.path)}: ${bodyTextFor(r.body).split('\n')[0] || 'structured media read failed'}`)
                .join('; ');
            return `Error: batch read rejected (${undelivered.length} of ${orderedResults.length} failed; reject_partial:true) — ${reasons}`;
        }
        // Default: surface per-entry status tags ([ok]/[error]) so a
        // downstream classifyResultKind treats the aggregate as a
        // structured report rather than a single error string. The
        // header avoids the leading `Error:` prefix because some
        // entries succeeded; failure count is reported in parens.
        const header = failedReads > 0
            ? `read ${orderedResults.length} (${failedReads} failed)${summaryLine}`
            : `read ${orderedResults.length}${summaryLine}`;
        const hasRichBodies = orderedResults.some((r) => richPartsFor(r.body) !== null);
        if (hasRichBodies) {
            const content = [{ type: 'text', text: header }];
            const seenTextEntryBody = new Map();
            const seenRichEntryBody = new WeakMap();
            for (let i = 0; i < orderedResults.length; i++) {
                const r = orderedResults[i];
                const path = normalizeOutputPath(r.path);
                const mode = r.n !== undefined ? `${r.mode} n=${r.n}` : r.mode;
                // Default full mode carries no information — tag only non-default modes.
                const modeTag = mode && mode !== 'full' ? ` [${mode}]` : '';
                const textBody = bodyTextFor(r.body);
                const status = batchEntryStatus(r.body, bodyFailed(r.body), textBody);
                const match = /\[TRUNCATED (?:—|-) file is (\d+) lines \/ (\d+) KB\./.exec(textBody);
                const suffix = match ? ` (truncated ${match[1]}L/${match[2]}KB)` : '';
                const entryHeader = `${path}${modeTag} [${status}]${suffix}`;
                const richParts = richPartsFor(r.body);
                let priorIdx;
                if (richParts) {
                    let seenByKey = seenRichEntryBody.get(r.body);
                    if (!seenByKey) {
                        seenByKey = new Map();
                        seenRichEntryBody.set(r.body, seenByKey);
                    }
                    const key = JSON.stringify([path, mode]);
                    priorIdx = seenByKey.get(key);
                    if (priorIdx === undefined) seenByKey.set(key, i);
                } else {
                    const key = JSON.stringify([path, mode, r.body || '']);
                    priorIdx = seenTextEntryBody.get(key);
                    if (priorIdx === undefined) seenTextEntryBody.set(key, i);
                }
                if (priorIdx !== undefined) {
                    content.push({ type: 'text', text: `${entryHeader} [= entry #${priorIdx + 1}, identical result omitted]` });
                    continue;
                }
                content.push({ type: 'text', text: entryHeader });
                if (richParts) content.push(...richParts);
                else content.push({ type: 'text', text: String(r.body || '') });
            }
            if (args._batchCapNote) content.push({ type: 'text', text: args._batchCapNote });
            return { content };
        }
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
            const modeTag = mode && mode !== 'full' ? ` [${mode}]` : '';
            const status = batchEntryStatus(
                r.body,
                classifyResultKind(String(r.body || '')) === 'error',
                String(r.body || ''),
            );
            const dupKey = JSON.stringify([path, mode, r.body || '']);
            const priorIdx = _seenEntryBody.get(dupKey);
            if (priorIdx !== undefined) {
                return `${path}${modeTag} [${status}] [= entry #${priorIdx + 1}, identical result omitted]`;
            }
            _seenEntryBody.set(dupKey, _i);
            const match = /\[TRUNCATED (?:—|-) file is (\d+) lines \/ (\d+) KB\./.exec(r.body || '');
            const suffix = match ? ` (truncated ${match[1]}L/${match[2]}KB)` : '';
            return `${path}${modeTag} [${status}]${suffix}\n${r.body}`;
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
    const runReadIo = (task) => readIoAdmission.run(
        options?.callerSessionId || options?.sessionId || currentToolExecutionOwner(),
        task,
        { signal: options?.signal || options?.abortSignal || null },
    );
    if (args.mode === 'head') return runReadIo(() => executeChildBuiltinTool('head', { path: args.path, n: args.n }, workDir));
    if (args.mode === 'tail') return runReadIo(() => executeChildBuiltinTool('tail', { path: args.path, n: args.n }, workDir));
    if (args.mode === 'count') return runReadIo(() => executeChildBuiltinTool('wc', { path: args.path }, workDir));
    if (args.mode === 'summary') return runReadIo(() => executeChildBuiltinTool('summary', { path: args.path, n: args.n, limit: args.limit }, workDir));
    if (args.mode === 'hex') return runReadIo(() => executeChildBuiltinTool('hex', { path: args.path, n: args.n, offset: args.offset }, workDir));
    return runReadIo(() => executeSingleReadTool(args, workDir, readStateScope, options, helpers));

}
