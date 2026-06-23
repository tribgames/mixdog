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
    } = parts;
    // `--hidden` (CC parity): search dotfiles/dot-dirs (.github, .claude) that
    // rg skips by default. The DEFAULT_IGNORE_GLOBS below still exclude .git and
    // the other noise dirs, so this only surfaces user-relevant hidden paths.
    const rgArgs = ['--color', 'never', '--hidden'];
    if (outputMode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
    } else if (outputMode === 'count') {
        rgArgs.push('--count');
    } else {
        rgArgs.push('--no-heading');
        if (showLineNumbers) rgArgs.push('--line-number');
        if (beforeN !== null) rgArgs.push('-B', String(beforeN));
        if (afterN !== null) rgArgs.push('-A', String(afterN));
        if (contextN !== null) rgArgs.push('-C', String(contextN));
        rgArgs.push('--max-columns=500', '--max-columns-preview');
        if (onlyMatching) rgArgs.push('--only-matching');
    }
    if (caseInsensitive) rgArgs.push('-i');
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
    for (const ex of DEFAULT_IGNORE_GLOBS) {
        const m = /^!\*\*\/([^/]+)\/\*\*$/.exec(ex);
        if (m) {
            const name = m[1];
            if (_sp === name || _sp.endsWith(`/${name}`) || _sp.includes(`/${name}/`) || _sp.startsWith(`${name}/`)) continue;
        }
        rgArgs.push('--glob', ex);
    }
    for (const g of globPatterns) rgArgs.push('--glob', g);
    for (const p of patterns) rgArgs.push('-e', p);
    // `--` end-of-options separator so a searchPath like `-foo` or
    // `--type` is treated as a positional path, not parsed as an rg
    // option. Patterns already use `-e`, so the separator only needs to
    // guard the trailing path operand.
    rgArgs.push('--', searchPath);
    return rgArgs;
}

export function buildGlobCacheKey({ patterns, basePath, headLimit, offset, extraIgnore }) {
    // extraIgnore (rg ignore globs from _extraIgnoreDirs) alters which files
    // match, so it MUST partake in the key — otherwise calls that differ only
    // by extra ignores collide and return stale over-/under-filtered results.
    // Sorted so the same ignore set in any order maps to one key.
    const extra = Array.isArray(extraIgnore) && extraIgnore.length ? [...extraIgnore].sort().join('\x01') : '';
    return ['glob', patterns.join('\x01'), basePath, headLimit ?? '', offset ?? '', extra].join('|');
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
    ].join('|');
}
