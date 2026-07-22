/**
 * Search path diagnostics: ENOENT recovery + path-shape helpers shared by
 * grep/glob in search-tool.mjs. Extracted verbatim so search-tool.mjs stays a
 * thin executor; search-tool.mjs re-exports these for unchanged importers.
 */
import { statSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import { findBySuffixStrip, findDirectoryByBasename, findFileByBasename, listSiblings } from './path-diagnostics.mjs';
import { normalizeOutputPath, resolveAgainstCwd } from './path-utils.mjs';

// Deterministic ENOENT recovery: when a grep path does not exist, surface
// indexed files that share the missing path's basename, turning a guessed or
// misplaced path (e.g. session/result-compression.mjs vs the real
// tools/result-compression.mjs) into the actual file in one step. Exact
// basename only — no stem/token fuzzing — so the hint is high-signal and
// noise-free. Invariant: every ENOENT runs the same basename lookup; there is
// no "guessed a lot" branch. Returns '' (appends nothing) when no same-named
// indexed file exists or the glob child is unavailable.
export async function _suggestIndexedPaths(missingPath, executeChildBuiltinTool, workDir) {
    if (typeof executeChildBuiltinTool !== 'function') return '';
    const base = String(missingPath).replace(/\\/g, '/').split('/').pop();
    // Skip when there is no usable basename or it carries glob magic (the
    // pattern, not a literal filename, would not map to a real file).
    if (!base || /[*?[\]{}]/.test(base)) return '';
    try {
        const out = await executeChildBuiltinTool('glob', { pattern: `**/${base}`, head_limit: 6 }, workDir);
        if (typeof out !== 'string') return '';
        // Drop ONLY the exact diagnostic forms glob emits: the empty-result line
        // ("(no files found ...", "(no entries after offset ...") and the
        // suffix/warning lines ("... [N more entries]", "... [warning] ...").
        // A broad startsWith('(' / '...' / 'Error') would wrongly drop real
        // paths like ErrorBoundary.mjs or a "(draft)/x.mjs" leading segment.
        const hits = out.split('\n')
            .filter((s) => s && !/^\(no (?:files found|entries\b)/.test(s) && !/^\.\.\. \[/.test(s))
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 5);
        return hits.length ? `\n[path not found here; same-named indexed file(s): ${hits.join(', ')}]` : '';
    } catch {
        return '';
    }
}

// Models occasionally glue a quoted segment onto an otherwise-unquoted path
// (e.g. `C:/Project/mixdog/"src/x.mjs"` — prefix bare, trailing segment
// wrapped in literal quote chars from a mis-escaped interpolation). But
// quote chars CAN be legit path content (POSIX `src/Bob's/file.mjs`), so
// stripping is existence-guarded: keep the original if it stats, only fall
// back to the stripped variant otherwise. Cost is one statSync and only on
// the rare quote-containing path.
export function stripEmbeddedPathQuotes(p) {
    if (typeof p !== 'string' || !p) return p;
    if (!p.includes('"') && !p.includes("'")) return p;
    try { statSync(p); return p; } catch { /* fall through to stripped */ }
    return p.replace(/['"]/g, '');
}

// Reuse read's own ENOENT recovery (path-diagnostics findBySuffixStrip /
// findFileByBasename — the exact fs scans read-single-tool.mjs already runs
// for its "same filename exists at" hint) so a grep/glob path miss redirects
// to the real location instead of dead-ending. No new fs scan is added here;
// this only calls the two helpers read already calls, with a caller-supplied
// action verb ("Search"/"List") in place of read's "Read". Gated to genuine
// not-found codes: EACCES/EPERM etc. keep their real failure semantics and
// must not trigger same-basename guidance or the BFS scan.
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

const ENOENT_FIND_NUDGE = 'Locate with find on the basename before retrying.';

// Per-invocation memo for the ENOENT recovery fs scans. A single grep/glob
// ENOENT surfaces the SAME missing path through tryReadFamilyEnoentRedirect
// (resolveUniqueEnoentRedirect) AND buildNotFoundHint (which re-runs
// resolveUniqueEnoentRedirect plus its own findFileByBasename). Threading an
// optional cache object keyed on that single path collapses the repeated
// suffix-strip / basename BFS into one scan. Absent cache → scan fresh
// (unchanged behavior for callers that don't pass one).
function cachedSuffixStrip(workDir, missingPath, cache) {
    if (!cache) return findBySuffixStrip(workDir, missingPath);
    if (!('suffixHit' in cache)) cache.suffixHit = findBySuffixStrip(workDir, missingPath);
    return cache.suffixHit;
}
function cachedFileByBasename(workDir, missingPath, cache) {
    if (!cache) return findFileByBasename(workDir, missingPath);
    if (!('fileHits' in cache)) cache.fileHits = findFileByBasename(workDir, missingPath);
    return cache.fileHits;
}

function isDirectoryPathGuess(missingPath) {
    const base = basename(String(missingPath || '').replace(/\\/g, '/'));
    if (!base || /[*?[\]{}]/.test(base)) return false;
    if (/\.[a-zA-Z0-9]{1,12}$/.test(base)) return false;
    return true;
}

function nearestExistingParentRel(workDir, missingPath) {
    try {
        const segments = String(missingPath).replace(/\\/g, '/').split('/')
            .filter((s) => s && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s));
        for (let i = segments.length - 1; i > 0; i--) {
            const candidate = join(workDir, ...segments.slice(0, i));
            try {
                if (statSync(candidate).isDirectory()) {
                    return segments.slice(0, i).join('/');
                }
            } catch { /* keep walking up */ }
        }
        if (statSync(workDir).isDirectory()) return '.';
    } catch { /* fall through */ }
    return null;
}

function spaceJoinedPathHint(requestedPath) {
    if (typeof requestedPath !== 'string') return '';
    const trimmed = requestedPath.trim();
    if (!/\s/.test(trimmed)) return '';
    const segments = trimmed.split(/\s+/).filter(Boolean);
    if (segments.length < 2) return '';
    return ' Pass multiple scopes as path[] array (not a space-joined string).';
}

function appendEnoentFindNudge(text = '') {
    const base = String(text || '');
    if (base.includes(ENOENT_FIND_NUDGE)) return base;
    const sep = base.length && !/\s$/.test(base) ? ' ' : '';
    return `${base}${sep}${ENOENT_FIND_NUDGE}`;
}

export function finalizeReadFamilyEnoentTail(hint, requestedPath, errCode = 'ENOENT') {
    if (!NOT_FOUND_CODES.has(String(errCode || 'ENOENT'))) return String(hint || '');
    return appendEnoentFindNudge(String(hint || '') + spaceJoinedPathHint(requestedPath));
}

function resolveUniqueEnoentRedirect(workDir, missingPath, errCode = 'ENOENT', cache = null) {
    if (!NOT_FOUND_CODES.has(String(errCode || 'ENOENT'))) return null;
    const suffixHit = cachedSuffixStrip(workDir, missingPath, cache);
    if (suffixHit) return suffixHit;
    const elsewhere = cachedFileByBasename(workDir, missingPath, cache);
    if (elsewhere.length === 1) return elsewhere[0];
    if (isDirectoryPathGuess(missingPath)) {
        const dirHits = findDirectoryByBasename(workDir, missingPath, { limit: 3 });
        if (dirHits.length === 1) return dirHits[0];
    }
    return null;
}

function redirectedFromPrefix(requestedPath) {
    return `[redirected from ${normalizeOutputPath(requestedPath)}]\n`;
}

export async function tryReadFamilyEnoentRedirect({
    workDir,
    resolvedPath,
    requestedPath,
    errCode,
    options,
    rerun,
    cache = null,
}) {
    if (options?._enoentRedirectFrom) return null;
    const target = resolveUniqueEnoentRedirect(workDir, resolvedPath, errCode, cache);
    if (!target) return null;
    const body = await rerun(target, { ...options, _enoentRedirectFrom: resolvedPath });
    const shown = requestedPath ?? resolvedPath;
    return redirectedFromPrefix(shown) + body;
}

export function buildNotFoundHint(workDir, missingPath, actionVerb, errCode = 'ENOENT', cache = null) {
    if (!NOT_FOUND_CODES.has(String(errCode || 'ENOENT'))) return '';
    if (resolveUniqueEnoentRedirect(workDir, missingPath, errCode, cache)) return '';
    const elsewhere = cachedFileByBasename(workDir, missingPath, cache);
    if (elsewhere.length) {
        return ` Not found at this path; the same filename exists at: ${elsewhere.map((p) => `"${normalizeOutputPath(p)}"`).join(', ')}. ${actionVerb} that path directly.`;
    }
    if (isDirectoryPathGuess(missingPath)) {
        const dirHits = findDirectoryByBasename(workDir, missingPath, { limit: 5 });
        if (dirHits.length > 1) {
            return ` Not found at this path; same-named directories exist at: ${dirHits.slice(0, 5).map((p) => `"${normalizeOutputPath(p)}"`).join(', ')}. ${actionVerb} one of those paths directly.`;
        }
        if (dirHits.length === 1) {
            return ` Not found at this path; the same directory name exists at: "${normalizeOutputPath(dirHits[0])}". ${actionVerb} that path directly.`;
        }
        const parentRel = nearestExistingParentRel(workDir, missingPath);
        if (parentRel) {
            const resolvedParent = parentRel === '.' ? workDir : resolveAgainstCwd(parentRel, workDir);
            // Compact hint: drop log/artifact noise, keep at most 3 candidates.
            const siblings = listSiblings(resolvedParent, 12)
                .filter((n) => !/\.(log|log\.\d+|tmp|bak)$/i.test(n))
                .slice(0, 3);
            if (siblings.length) {
                const shown = parentRel === '.' ? '.' : normalizeOutputPath(parentRel);
                return ` Not found; under "${shown}" try: ${siblings.map((n) => `"${n}"`).join(', ')}.`;
            }
        }
    }
    return '';
}

export function relativePathPrefix(pathPrefix, workDir) {
    if (!workDir) return pathPrefix;
    const cwdFwd = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const absFwd = String(pathPrefix || '').replace(/\\/g, '/');
    const haystack = process.platform === 'win32' ? absFwd.toLocaleLowerCase() : absFwd;
    const needle = process.platform === 'win32' ? cwdFwd.toLocaleLowerCase() : cwdFwd;
    if (haystack.startsWith(needle + '/') || haystack === needle) {
        return absFwd.slice(cwdFwd.length + 1) || '.';
    }
    return pathPrefix;
}

export function relativeSearchResultPath(path, workDir) {
    const normalizedWorkDir = normalizeOutputPath(workDir);
    const normalizedAbs = normalizeOutputPath(path);
    if (normalizedAbs.startsWith(normalizedWorkDir + '/') || normalizedAbs.startsWith(normalizedWorkDir + '\\')) {
        return normalizedAbs.slice(normalizedWorkDir.length + 1);
    }
    return normalizedAbs;
}

export function resolveSearchScope(root, workDir) {
    return isAbsolute(root) ? resolve(root) : resolveAgainstCwd(root, workDir);
}

export function isUncOrSmbPath(path) {
    if (typeof path !== 'string' || !path) return false;
    return path.startsWith('\\\\') || path.startsWith('//');
}

export function uncRefusalMessage(toolName, original, resolved) {
    const shown = normalizeOutputPath(resolved || original || '');
    return `Error: ${toolName} refuses UNC/SMB path ${JSON.stringify(shown)}; remote share access is blocked to prevent NTLM credential leaks`;
}

export function basePathDiagnostic(basePaths, workDir, statCache = null) {
    return basePaths.map((basePath) => {
        const resolved = resolveSearchScope(basePath, workDir);
        // Reuse the caller's call-scoped stat cache (glob preflight + per-group
        // rg runs already stat'd this same resolved root) instead of re-stating.
        let st = null;
        let err = null;
        const cached = statCache && statCache.get(resolved);
        if (cached) { st = cached.st; err = cached.err; }
        else { try { st = statSync(resolved); } catch (e) { err = e; } }
        if (!err) {
            return `${normalizeOutputPath(basePath)}: ${st.isDirectory() ? 'path exists (dir)' : 'path exists (file)'}`;
        }
        return `${normalizeOutputPath(basePath)}: path does not exist (${err?.code || 'ENOENT'})`
            + finalizeReadFamilyEnoentTail(buildNotFoundHint(workDir, resolved, 'Search', err?.code), basePath, err?.code);
    }).join('; ');
}
