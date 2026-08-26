import { NOISE_DIR_NAMES } from './glob-walk.mjs';

// Derived from NOISE_DIR_NAMES so the rg fast path and the walker stay in
// sync. Each noise directory becomes a recursive negative glob; Windows
// reserved device names are appended separately.
export const DEFAULT_IGNORE_GLOBS = [
    ...[...NOISE_DIR_NAMES].map((name) => `!**/${name}/**`),
    '!**/nul',
    '!**/con',
    '!**/prn',
    '!**/aux',
    '!**/com[1-9]',
    '!**/lpt[1-9]',
];

// Kernel-virtual trees mounted at the filesystem root hold no user files and
// can stall or poison a full-root walk: procfs re-enumerates every pid on each
// pass and /proc/kcore presents as a terabyte-scale sparse file. A scan rooted
// at `/` prunes them up front; the globs are ROOT-ANCHORED (no `**/` prefix),
// so a scan rooted at or inside one of them (path /proc/...) keeps full
// visibility, and ordinary project directories named `proc`/`sys`/`dev` are
// never affected because the exclusion only applies when the walk root is `/`.
export function rootScanIgnoreGlobs(resolvedRoot, platform = process.platform) {
    if (platform === 'win32') return [];
    return String(resolvedRoot || '') === '/'
        ? ['!proc/**', '!sys/**', '!dev/**']
        : [];
}

export function buildGrepCacheKey(parts) {
    const {
        patterns,
        searchPath,
        globPatterns,
        outputMode,
        headLimit,
        offset,
        caseInsensitive,
        showLineNumbers,
        beforeN,
        afterN,
        contextN,
        multilineMode,
        fileType,
        onlyMatching,
        pcre2,
        withFilename,
        contextCharBudget = 0,
        flatOutput = false,
        patternCapTotal = 0,
        candidatesKey = '',
    } = parts;
    return [
        'grep',
        patterns.join('\x01'),
        searchPath,
        globPatterns.join('\x01'),
        outputMode,
        String(headLimit),
        String(offset),
        caseInsensitive ? 'i1' : 'i0',
        showLineNumbers ? 'n1' : 'n0',
        beforeN ?? '',
        afterN ?? '',
        contextN ?? '',
        multilineMode ? 'm1' : 'm0',
        onlyMatching ? 'o1' : 'o0',
        Array.isArray(fileType) ? fileType.join('\x01') : (fileType || ''),
        pcre2 ? 'p1' : 'p0',
        withFilename ? 'H1' : 'H0',
        'cb' + String(contextCharBudget || 0),
        flatOutput ? 'flat1' : 'flat0',
        // Cap total keeps a capped request (first-N of M patterns, carrying the
        // "[capped at N of M]" notice) from colliding with an exact N-pattern
        // request or with a differently-capped one (of 15 vs of 20).
        'pc' + String(patternCapTotal || 0),
        // Candidate-file scoping (fan-out prefilter) changes which files rg
        // visits and their order; scoped results get their own cache slot so
        // they never collide with an unscoped run of the same pattern.
        'cd' + String(candidatesKey || ''),
    ].join('|');
}

export function buildGrepRgArgs(parts) {
    const {
        patterns,
        searchPath,
        globPatterns,
        outputMode,
        caseInsensitive,
        showLineNumbers,
        beforeN,
        afterN,
        contextN,
        multilineMode,
        fileType,
        onlyMatching,
        fixedStrings = false,
        pcre2 = false,
        withFilename = false,
        candidateFiles = null,
    } = parts;
    // `--hidden`: search dotfiles/dot-dirs (.github, .mixdog) that
    // rg skips by default. The DEFAULT_IGNORE_GLOBS below still exclude .git and
    // the other noise dirs, so this only surfaces user-relevant hidden paths.
    const rgArgs = ['--color', 'never', '--hidden'];
    if (outputMode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
    } else if (outputMode === 'count') {
        rgArgs.push('--count');
    } else {
        rgArgs.push('--no-heading');
        if (withFilename) rgArgs.push('-H');
        if (showLineNumbers) rgArgs.push('--line-number');
        if (beforeN !== null) rgArgs.push('-B', String(beforeN));
        if (afterN !== null) rgArgs.push('-A', String(afterN));
        if (contextN !== null) rgArgs.push('-C', String(contextN));
        rgArgs.push('--max-columns=500', '--max-columns-preview');
        if (onlyMatching) rgArgs.push('--only-matching');
    }
    if (caseInsensitive) rgArgs.push('-i');
    if (fixedStrings) rgArgs.push('-F');
    // PCRE2 engine: opt-in only when the caller already confirmed (via
    // rgSupportsPcre2() in search-tool.mjs) that the installed rg binary was
    // built with PCRE2 support. Enables lookaround/backreference patterns
    // that the default Rust regex engine rejects outright.
    if (pcre2) rgArgs.push('-P');
    if (multilineMode) rgArgs.push('-U', '--multiline-dotall');
    if (Array.isArray(fileType)) {
        for (const t of fileType) if (t) rgArgs.push('--type', t);
    } else if (fileType) {
        rgArgs.push('--type', fileType);
    }
    // Apply noise-dir exclusions, but NOT the one matching a directory the
    // caller explicitly targeted — otherwise a grep inside e.g. node_modules/foo
    // would exclude its own root and match nothing (recall bug). Device-name
    // globs (no trailing /**) always apply. searchPath is normalized to forward
    // slashes and de-trailing-slashed for the comparison.
    const _sp = String(searchPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    // A positive --glob filter that NAMES a pruned directory is asking to
    // search inside it; only the path operand used to count, so
    // `glob:"__pycache__/*.pyc"` matched nothing while the files were there.
    // Negative filters never re-admit their own target.
    const _namedByGlobs = new Set(
        (Array.isArray(globPatterns) ? globPatterns : [])
            .filter((g) => typeof g === 'string' && g && !g.startsWith('!'))
            .flatMap((g) => g.replace(/\\/g, '/').split('/'))
            .filter((segment) => segment && !/[*?[\]{}]/.test(segment)),
    );
    for (const ex of DEFAULT_IGNORE_GLOBS) {
        const m = /^!\*\*\/([^/]+)\/\*\*$/.exec(ex);
        if (m) {
            const name = m[1];
            if (_sp === name || _sp.endsWith(`/${name}`) || _sp.includes(`/${name}/`) || _sp.startsWith(`${name}/`)) continue;
            if (_namedByGlobs.has(name)) continue;
        }
        rgArgs.push('--glob', ex);
    }
    for (const g of globPatterns) rgArgs.push('--glob', g);
    for (const p of patterns) rgArgs.push('-e', p);
    // `--` end-of-options separator so a searchPath like `-foo` or
    // `--type` is treated as a positional path, not parsed as an rg
    // option. Patterns already use `-e`, so the separator only needs to
    // guard the trailing path operand.
    if (Array.isArray(candidateFiles) && candidateFiles.length > 0) {
        // Fan-out prefilter scoping: search ONLY the candidate files (paths
        // relative to the spawn cwd) instead of walking searchPath — explicit
        // file operands skip the directory walk entirely.
        rgArgs.push('--', ...candidateFiles);
    } else {
        rgArgs.push('--', searchPath);
    }
    return rgArgs;
}

export function buildGlobCacheKey({ patterns, basePath, headLimit, offset, extraIgnore, sort, patternCapTotal = 0 }) {
    // extraIgnore (rg ignore globs from _extraIgnoreDirs) alters which files
    // match, so it MUST partake in the key — otherwise calls that differ only
    // by extra ignores collide and return stale over-/under-filtered results.
    // Sorted so the same ignore set in any order maps to one key.
    const extra = Array.isArray(extraIgnore) && extraIgnore.length ? [...extraIgnore].sort().join('\x01') : '';
    // patternCapTotal: a capped pattern set (first-N of M) must not collide with
    // an exact N-pattern request or a differently-capped one.
    return ['glob', patterns.join('\x01'), basePath, headLimit ?? '', offset ?? '', sort || 'natural', extra, 'pc' + String(patternCapTotal || 0)].join('|');
}

export function buildListCacheKey(parts) {
    const {
        mode,
        inputPath,
        depth,
        hidden,
        sort,
        typeFilter,
        headLimit,
        offset,
        namePattern,
        minSize,
        maxSize,
        modifiedAfter,
        modifiedBefore,
        includeNoise,
        meta,
    } = parts;
    return [
        'list',
        mode,
        inputPath,
        depth,
        hidden ? 'h1' : 'h0',
        sort || '',
        typeFilter || '',
        headLimit,
        offset ?? '',
        namePattern || '',
        minSize ?? '',
        maxSize ?? '',
        modifiedAfter || '',
        modifiedBefore || '',
        includeNoise ? 'n1' : 'n0',
        meta ? 'm1' : 'm0',
    ].join('|');
}
