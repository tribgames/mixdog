import { isAbsolute } from 'path';
import { canonicalizeGlobSlashes, normalizeOutputPath } from '../path-utils.mjs';
import {
    relativePathPrefix,
} from '../search-path-diagnostics.mjs';
import {
    normalizeGrepLine,
    splitGrepCountPrefix,
    splitGrepLinePrefix,
} from '../grep-formatting.mjs';

export function expandLegacyEscapedAlternationPattern(rawPattern) {
    if (typeof rawPattern !== 'string' || !rawPattern.includes('\\|')) return null;
    const parts = rawPattern.split('\\|').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts : null;
}

export function relativeGrepLine(line, workDir, pathOnly = false, outputMode = 'content', filenameOmitted = false) {
    const normalized = normalizeGrepLine(line, pathOnly, outputMode, filenameOmitted);
    if (!workDir) return normalized;
    if (pathOnly) return relativePathPrefix(normalized, workDir);
    if (filenameOmitted) return normalized;
    const split = splitGrepLinePrefix(normalized);
    if (split) {
        return relativePathPrefix(normalized.slice(0, split.pathEnd), workDir) + normalized.slice(split.pathEnd);
    }
    if (outputMode === 'count') {
        const countSplit = splitGrepCountPrefix(normalized);
        if (countSplit) {
            return relativePathPrefix(normalized.slice(0, countSplit.pathEnd), workDir) + normalized.slice(countSplit.pathEnd);
        }
    }
    return normalized;
}

export function uniqueStrings(values) {
    return Array.from(new Set(values.filter((value) => typeof value === 'string' && value)));
}

export function isRgRegexParseError(err) {
    const msg = `${err?.stderr || ''}\n${err?.message || err || ''}`;
    return /regex parse error/i.test(msg);
}

export function regexPatternToFixedTerms(pattern) {
    const raw = String(pattern || '');
    if (!raw) return [];
    return raw
        .split(/\\?\|/g)
        .map((part) => part.trim())
        .map((part) => part
            .replace(/\\[bB]/g, '')
            .replace(/^\^/, '')
            .replace(/\$$/, '')
            .replace(/\\([\\.^$*+?()[\]{}|/-])/g, '$1')
            .trim())
        .filter((part) => part.length > 0);
}

export function coerceNonNegInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return Math.floor(n);
}

export function globMtimeTiePath(entry) {
    const p = String(entry?.path ?? entry?.full ?? '');
    return process.platform === 'win32' ? p.toLocaleLowerCase() : p;
}

export function splitGlobString(value) {
    const out = [];
    const str = String(value);
    let depth = 0;
    let token = '';
    const flush = () => {
        const trimmed = token.trim();
        if (trimmed) out.push(trimmed);
        token = '';
    };
    for (const ch of str) {
        if (ch === '{') {
            depth++;
            token += ch;
        } else if (ch === '}') {
            if (depth > 0) depth--;
            token += ch;
        } else if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
            flush();
        } else {
            token += ch;
        }
    }
    flush();
    return out;
}

export function isRedundantAllFilesGlob(value) {
    const g = canonicalizeGlobSlashes(String(value || '').trim())
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
    return g === '**/*' || g === '**';
}

export function parseGrepCountLine(line) {
    const text = String(line || '');
    const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
    const idx = text.lastIndexOf(':');
    if (idx <= searchFrom) return null;
    const count = Number(text.slice(idx + 1));
    if (!Number.isFinite(count) || count <= 0) return null;
    const path = text.slice(0, idx);
    if (!path) return null;
    return { path, count };
}
