// manager/prefetch-bridge.mjs
// Explicit-prefetch bridge extracted verbatim from manager.mjs. Runs Lead-
// supplied files[]/callers[]/references[] prefetch outside the agent loop.
import { isAgentOwner } from '../../agent-owner.mjs';
import { executeInternalTool } from '../../internal-tools.mjs';
import { classifyResultKind } from '../result-classification.mjs';
import { tryPrefetchCached, setPrefetchCached } from '../read-dedup.mjs';
import { _executeCodeGraphToolLazy } from './runtime-loaders.mjs';

export async function _tryBridgeExplicitPrefetch(session, explicitPrefetch) {
    if (!explicitPrefetch || typeof explicitPrefetch !== 'object') return null;
    if (!isAgentOwner(session)) return null;
    const parts = [];
    const failed = [];
    const totalEntries = [];
    // files[] — string entries use the default head excerpt; object entries
    // {path, n?, full?} let the caller widen the window or pull the full file
    // so worker doesn't have to re-read deep ranges of an already-prefetched
    // file (a recurring iter burner observed in baseline session telemetry).
    const _rawFilesIn = Array.isArray(explicitPrefetch.files) ? explicitPrefetch.files : [];
    const _readOptsByFile = new Map();
    const files = [];
    const _seenFiles = new Set();
    const _addPrefetchFile = (file, opts = null) => {
        if (typeof file !== 'string' || !file) return;
        if (!_seenFiles.has(file)) {
            _seenFiles.add(file);
            files.push(file);
        }
        if (!opts || Object.keys(opts).length === 0) return;
        const prev = _readOptsByFile.get(file) || {};
        const merged = { ...prev };
        if (opts.mode === 'full') {
            merged.mode = 'full';
            delete merged.n;
        } else if (merged.mode !== 'full' && Number.isFinite(opts.n) && opts.n > 0) {
            merged.n = Math.max(Number(merged.n) || 0, opts.n);
        }
        if (Object.keys(merged).length > 0) _readOptsByFile.set(file, merged);
    };
    for (const entry of _rawFilesIn) {
        if (typeof entry === 'string' && entry) {
            _addPrefetchFile(entry);
        } else if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path) {
            const opts = {};
            if (entry.full === true) opts.mode = 'full';
            else if (Number.isFinite(entry.n) && entry.n > 0) opts.n = entry.n;
            _addPrefetchFile(entry.path, opts);
        }
    }
    if (files.length > 0) {
        totalEntries.push(...files);
        // R20: per-file prefetch cache (cross-dispatch, process-local).
        // Try each file from cache first; batch misses into one disk read.
        const { resolve: _pfResolve, isAbsolute: _pfIsAbs, normalize: _pfNorm } = await import('path');
        const _pfCwd = session.cwd || null;
        function _pfAbsPath(f) {
            const abs = _pfIsAbs(f) ? f : _pfResolve(_pfCwd || process.cwd(), f);
            return _pfNorm(abs);
        }
        const fileHits = [];   // { file, abs, content } — satisfied from cache
        const fileMisses = []; // { file, abs } — need disk read
        for (const f of files) {
            const abs = _pfAbsPath(f);
            // Skip the cross-dispatch cache when the caller asked for a
            // non-default window (custom n or full-file). Cache key is the
            // path alone, so a default-window cache hit would silently feed
            // the wrong slice back to the next caller.
            const hit = _readOptsByFile.has(f) ? null : tryPrefetchCached(abs);
            if (hit) {
                fileHits.push({ file: f, abs, content: hit.content });
            } else {
                fileMisses.push({ file: f, abs });
            }
        }
        // Disk read for misses (single batch call).
        const missFiles = fileMisses.map(m => m.file);
        const missResults = {}; // file → content string
        if (missFiles.length > 0) {
            // Read each miss file individually so we can cache per-file.
            // The files list is small (typically 2-5), so N awaits is fine.
            await Promise.all(missFiles.map(async (f) => {
                const opts = _readOptsByFile.get(f) || {};
                const readArgs = { path: f };
                if (opts.mode === 'full') {
                    readArgs.mode = 'full';
                } else {
                    readArgs.mode = 'head';
                    readArgs.n = Number.isFinite(opts.n) ? opts.n : 120;
                }
                const out = await executeInternalTool('read', readArgs).catch((e) => {
                    process.stderr.write(`[agent-prefetch] file read failed (${f}): ${e && e.message || e}\n`);
                    return null;
                });
                if (out !== null) {
                    missResults[f] = String(out);
                }
            }));
            // Cache successful miss results.
            for (const { file, abs } of fileMisses) {
                const content = missResults[file];
                if (content && classifyResultKind(content) !== 'error') {
                    // Only cache default-window reads; custom-window results
                    // would poison the shared cross-dispatch cache.
                    if (!_readOptsByFile.has(file)) setPrefetchCached(abs, content);
                } else if (content === undefined || classifyResultKind(content) === 'error') {
                    failed.push(file);
                }
            }
        }
        // Assemble combined output preserving original file order.
        const readParts = [];
        const hitByFile = new Map(fileHits.map((h) => [h.file, h]));
        for (const f of files) {
            const hitEntry = hitByFile.get(f);
            if (hitEntry) {
                readParts.push(hitEntry.content);
                continue;
            }
            const content = missResults[f];
            if (content && classifyResultKind(content) !== 'error') {
                readParts.push(content);
            }
            // else: already pushed to failed above
        }
        if (readParts.length > 0) {
            parts.push(`### prefetch files\nread ${readParts.length}\n\n${readParts.join('\n\n')}`);
        }
        // Log hit/miss counters so dispatch telemetry shows prefetch effectiveness.
        if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
            process.stderr.write(
                `[prefetch] files=${files.length} cached=${fileHits.length} miss=${fileMisses.length} failed=${failed.length}\n`
            );
        }
        // Attach stats to session so post-hoc analyzers (inspect-session.mjs)
        // can see prefetch effectiveness without parsing stderr logs.
        if (session && typeof session === 'object') {
            if (!session.prefetchStats) session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0 };
            session.prefetchStats.files += files.length;
            session.prefetchStats.cached += fileHits.length;
            session.prefetchStats.miss += fileMisses.length;
            session.prefetchStats.failed += failed.length;
        }
    }
    // callers[]
    const callers = Array.isArray(explicitPrefetch.callers) ? explicitPrefetch.callers.filter(c => c && typeof c.symbol === 'string') : [];
    {
        const callerTasks = callers.map(({ symbol, file }) => {
            const cgArgs = { mode: 'callers', symbol };
            if (file) cgArgs.file = file;
            if (session?.cwd) cgArgs.cwd = session.cwd;
            totalEntries.push(symbol);
            return _executeCodeGraphToolLazy('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[agent-prefetch] callers(${symbol}) failed: ${e && e.message || e}\n`);
                    return { symbol, out: null };
                });
        });
        const callerResults = await Promise.allSettled(callerTasks);
        for (const r of callerResults) {
            const { symbol, out } = r.status === 'fulfilled' ? r.value : { symbol: '?', out: null };
            if (out && classifyResultKind(String(out)) !== 'error') {
                parts.push(`### prefetch callers ${symbol}\n${out}`);
            } else {
                failed.push(symbol);
            }
        }
    }
    // references[]
    const references = Array.isArray(explicitPrefetch.references) ? explicitPrefetch.references.filter(r => r && typeof r.symbol === 'string') : [];
    {
        const refTasks = references.map(({ symbol, file }) => {
            const cgArgs = { mode: 'references', symbol };
            if (file) cgArgs.file = file;
            if (session?.cwd) cgArgs.cwd = session.cwd;
            totalEntries.push(symbol);
            return _executeCodeGraphToolLazy('code_graph', cgArgs, session?.cwd)
                .then(out => ({ symbol, out }))
                .catch(e => {
                    process.stderr.write(`[agent-prefetch] references(${symbol}) failed: ${e && e.message || e}\n`);
                    return { symbol, out: null };
                });
        });
        const refResults = await Promise.allSettled(refTasks);
        for (const r of refResults) {
            const { symbol, out } = r.status === 'fulfilled' ? r.value : { symbol: '?', out: null };
            if (out && classifyResultKind(String(out)) !== 'error') {
                parts.push(`### prefetch references ${symbol}\n${out}`);
            } else {
                failed.push(symbol);
            }
        }
    }
    if (session && typeof session === 'object' && (callers.length > 0 || references.length > 0)) {
        if (!session.prefetchStats) session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0, callers: 0, references: 0 };
        session.prefetchStats.callers = (session.prefetchStats.callers || 0) + callers.length;
        session.prefetchStats.references = (session.prefetchStats.references || 0) + references.length;
    }
    if (parts.length === 0) {
        // All entries failed but Lead presence must still be signalled — emit
        // warn-only so the gate logic can distinguish "prefetch was requested"
        // from "no prefetch at all".
        if (totalEntries.length > 0 && failed.length > 0) {
            return `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>`;
        }
        return null;
    }
    const warnLine = failed.length > 0
        ? `<prefetch-warn>${failed.length} of ${totalEntries.length} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>\n`
        : '';
    return `${warnLine}<prefetch>\n${parts.join('\n\n')}\n</prefetch>`;
}
