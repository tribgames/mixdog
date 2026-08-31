import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { extractGlobBaseDirectory } from '../path-utils.mjs';

function addGroup(groups, root, pattern) {
    if (!groups.has(root)) groups.set(root, []);
    const patterns = groups.get(root);
    if (!patterns.includes(pattern)) patterns.push(pattern);
}

function relativeStaticPrefix(pattern) {
    const text = String(pattern || '');
    if (!text || text.startsWith('!') || isAbsolute(text)) return null;
    const { baseDir, relativePattern } = extractGlobBaseDirectory(text);
    if (!baseDir || !relativePattern) return null;
    const segments = String(baseDir).replace(/\\/g, '/').split('/');
    if (segments.some((segment) =>
        !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
        return null;
    }
    return { segments, relativePattern };
}

async function safeStaticRoot(root, segments, lstatFn, cache) {
    let current;
    try {
        current = resolve(root);
    } catch {
        return null;
    }
    const resolvedRoot = current;
    for (const segment of segments) {
        current = resolve(current, segment);
        const rel = relative(resolvedRoot, current);
        if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
            return null;
        }
        let pending = cache.get(current);
        if (!pending) {
            pending = Promise.resolve().then(() => lstatFn(current));
            cache.set(current, pending);
        }
        let st;
        try {
            st = await pending;
        } catch {
            return null;
        }
        if (!st.isDirectory() || st.isSymbolicLink()) return null;
    }
    return current;
}

export async function buildGlobPatternGroups({
    patterns,
    baseEntries,
    resolveRoot,
    lstatFn = lstat,
}) {
    const groups = new Map();
    const relativePatterns = patterns.filter((pattern) => !isAbsolute(pattern));
    const canTryNarrowing = relativePatterns.length > 0
        && !patterns.some((pattern) => String(pattern).startsWith('!'))
        && baseEntries.every((entry) => !entry.prefix);
    let narrowed = null;

    if (canTryNarrowing) {
        const statCache = new Map();
        const candidates = new Map();
        let complete = true;
        for (let patternIndex = 0; patternIndex < patterns.length && complete; patternIndex += 1) {
            const pattern = patterns[patternIndex];
            if (isAbsolute(pattern)) continue;
            const prefix = relativeStaticPrefix(pattern);
            if (!prefix) {
                complete = false;
                break;
            }
            for (let baseIndex = 0; baseIndex < baseEntries.length; baseIndex += 1) {
                const entry = baseEntries[baseIndex];
                let resolvedBase;
                try {
                    resolvedBase = resolveRoot(entry.root);
                } catch {
                    complete = false;
                    break;
                }
                const root = await safeStaticRoot(resolvedBase, prefix.segments, lstatFn, statCache);
                if (!root) {
                    complete = false;
                    break;
                }
                candidates.set(`${patternIndex}:${baseIndex}`, {
                    root,
                    pattern: prefix.relativePattern,
                });
            }
        }
        if (complete) narrowed = candidates;
    }

    for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
        const pattern = patterns[patternIndex];
        if (isAbsolute(pattern)) {
            const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern);
            addGroup(groups, baseDir || baseEntries[0]?.root || '.', relativePattern);
            continue;
        }
        for (let baseIndex = 0; baseIndex < baseEntries.length; baseIndex += 1) {
            const entry = baseEntries[baseIndex];
            const planned = narrowed?.get(`${patternIndex}:${baseIndex}`);
            if (planned) {
                addGroup(groups, planned.root, planned.pattern);
            } else {
                addGroup(groups, entry.root, entry.prefix ? `${entry.prefix}/${pattern}` : pattern);
            }
        }
    }
    return groups;
}
