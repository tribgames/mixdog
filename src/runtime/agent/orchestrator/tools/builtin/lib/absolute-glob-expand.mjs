// Direct filesystem expansion for an ABSOLUTE glob pattern.
//
// The inventory walker never follows a symlinked directory — the right call on
// a project tree, where following them means cycles and duplicated subtrees.
// But a virtual filesystem is built almost entirely out of symlinks:
// /sys/block/sda is a link into /sys/devices, and /sys/block/sda/device is
// another one. A pattern like /sys/block/sd*/size therefore enumerates NOTHING
// through the walker, and the caller is told the path does not exist while it
// plainly does.
//
// The pattern itself is the bound here: only segments that match are descended,
// one readdir per surviving directory, no recursive `**`, plus a candidate cap
// and a wall-clock deadline. Returns the matches (possibly empty), or null when
// the pattern is not expandable this way and the caller should keep its own
// answer.
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';

import { hasGlobMagic, normalizeOutputPath } from '../path-utils.mjs';

const DEFAULT_DEADLINE_MS = 1_500;
const DEFAULT_CANDIDATE_CAP = 200;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One path SEGMENT's matcher, or null when the segment uses a construct this
 *  expander will not approximate. */
function segmentMatcher(segment) {
    if (segment.includes('**')) return null;
    let source = '';
    for (let index = 0; index < segment.length; index += 1) {
        const char = segment[index];
        if (char === '*') { source += '[^/]*'; continue; }
        if (char === '?') { source += '[^/]'; continue; }
        if (char === '[') {
            const end = segment.indexOf(']', index + 1);
            if (end < 0) return null;
            source += segment.slice(index, end + 1);
            index = end;
            continue;
        }
        if (char === '{') {
            const end = segment.indexOf('}', index + 1);
            if (end < 0) return null;
            const alternatives = segment.slice(index + 1, end).split(',').map(escapeRegExp);
            source += `(?:${alternatives.join('|')})`;
            index = end;
            continue;
        }
        source += escapeRegExp(char);
    }
    try {
        return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
    } catch {
        return null;
    }
}

export async function expandAbsoluteGlob(pattern, {
    limit = 25,
    deadlineMs = DEFAULT_DEADLINE_MS,
    candidateCap = DEFAULT_CANDIDATE_CAP,
} = {}) {
    const raw = String(pattern || '').replace(/\\/g, '/');
    if (!raw || !isAbsolute(raw) || !hasGlobMagic(raw)) return null;
    const root = parse(raw).root;
    if (!root) return null;
    const segments = raw.slice(root.length).split('/').filter(Boolean);
    if (segments.length === 0) return null;
    const stopAt = Date.now() + Math.max(1, deadlineMs);

    let current = [root];
    for (const segment of segments) {
        if (Date.now() >= stopAt) return null;
        if (!hasGlobMagic(segment)) {
            current = current.map((dir) => join(dir, segment));
            continue;
        }
        const matcher = segmentMatcher(segment);
        if (!matcher) return null;
        const next = [];
        for (const dir of current) {
            if (next.length >= candidateCap || Date.now() >= stopAt) break;
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const name of entries) {
                if (!matcher.test(name)) continue;
                next.push(join(dir, name));
                if (next.length >= candidateCap) break;
            }
        }
        current = next;
        if (current.length === 0) return [];
    }

    // stat (not lstat) so a symlinked target counts as the file/dir it names —
    // that is the whole point of expanding these scopes.
    const found = [];
    for (const candidate of current) {
        if (found.length >= limit || Date.now() >= stopAt) break;
        try {
            const info = await stat(candidate);
            if (info.isFile() || info.isDirectory()) found.push(normalizeOutputPath(candidate));
        } catch { /* a pattern match that cannot be stat'ed is not a result */ }
    }
    return found;
}

/** Expand every absolute pattern in a list; returns deduped matches in order. */
export async function expandAbsoluteGlobs(patterns, options = {}) {
    const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(
        (value) => typeof value === 'string' && value,
    );
    const seen = new Set();
    const out = [];
    for (const pattern of list) {
        if (out.length >= (options.limit ?? 25)) break;
        const matches = await expandAbsoluteGlob(pattern, options);
        if (!matches) continue;
        for (const match of matches) {
            if (seen.has(match)) continue;
            seen.add(match);
            out.push(match);
        }
    }
    return out;
}
