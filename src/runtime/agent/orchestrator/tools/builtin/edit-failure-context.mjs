import { readFileSync } from 'fs';
import { findActualString } from '../edit-normalize.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { READ_MAX_SIZE_BYTES } from './read-constants.mjs';
import { isBinaryFile } from './binary-file.mjs';
import { hashText } from './hash-utils.mjs';
import { rangeHashesForReadRanges } from './snapshot-helpers.mjs';
import {
    compactEditContext,
    countOccurrences,
    lineContextAround,
} from './edit-context-utils.mjs';
import { findEditHint } from './edit-hint.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';

export function recordPreviewSnapshot(fullPath, scope, content, range) {
    if (!fullPath || !range) return false;
    try {
        recordReadSnapshot(fullPath, undefined, scope, {
            source: 'edit_failure_preview',
            ranges: [range],
            rangeHashes: rangeHashesForReadRanges(content, [range]),
        });
        return true;
    } catch {
        return false;
    }
}

export function editFailureContextHint(content, startLine, endLine, options = {}, meta = {}) {
    if (options.includePreview === false) return '';
    const rendered = compactEditContext(content, startLine, endLine, {
        maxLines: options.previewMaxLines || 20,
        maxChars: options.previewMaxChars || 1400,
    });
    const canRecord = options.recordPreviewSnapshot === true && meta.matchesLength === 1;
    const recorded = canRecord
        ? recordPreviewSnapshot(options.fullPath, options.scope, options.snapshotContent ?? content, rendered.range)
        : false;
    return `\n  context ${rendered.range.startLine}-${rendered.range.endLine}${recorded ? ' (snapshot recorded)' : ''}:\n${rendered.text}`;
}

export function buildStaleEditRecovery({ fullPath, scope, oldStrings = [], recordPreviewSnapshot: shouldRecordPreview = false } = {}) {
    let content = '';
    try { content = readFileSync(fullPath, 'utf-8'); }
    catch { return ''; }
    const candidates = (Array.isArray(oldStrings) ? oldStrings : [])
        .map((entry) => typeof entry === 'string' ? entry : entry?.old_string)
        .filter((s) => typeof s === 'string' && s.length > 0)
        .slice(0, 3);
    for (const oldString of candidates) {
        const actual = findActualString(content, oldString) || oldString;
        const count = countOccurrences(content, actual);
        if (count !== 1) continue;
        const idx = content.indexOf(actual);
        const startLine = lineForIndex(content, idx);
        const endLine = startLine + actual.split('\n').length - 1;
        return editFailureContextHint(content, startLine, endLine, {
            fullPath,
            scope,
            snapshotContent: content,
            recordPreviewSnapshot: shouldRecordPreview,
            previewMaxLines: 12,
            previewMaxChars: 1000,
        }, { matchesLength: 1 });
    }
    if (candidates[0]) {
        const hint = findEditHint(content, candidates[0], null);
        if (hint) return `\n  current file:${hint}`;
    }
    return '';
}

export function lineForIndex(content, index) {
    if (index <= 0) return 1;
    const end = Math.min(index, content.length);
    let lineNo = 1;
    for (let i = 0; i < end; i++) {
        if (content.charCodeAt(i) === 10) lineNo++;
    }
    return lineNo;
}

export function primeReadSnapshotForEdit({ fullPath, filePath, st, scope, oldStrings = [], lineRange = null }) {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_EDIT_AUTO_SNAPSHOT || ''))) return null;
    if (!st || st.size > READ_MAX_SIZE_BYTES || isBinaryFile(fullPath, st.size)) return null;
    let rawBuf;
    try { rawBuf = readFileSync(fullPath); }
    catch { return null; }
    if (!Buffer.isBuffer(rawBuf)) return null;
    const content = rawBuf.toString('utf-8');
    const lines = content.split('\n');
    recordReadSnapshot(fullPath, st, scope, {
        source: 'auto_snapshot',
        contentHash: hashText(content),
    });

    const out = [
        `Edit snapshot primed from disk for ${normalizeOutputPath(filePath)} (no prior read in this scope).`,
    ];
    const checks = [];
    let firstContext = null;
    for (let i = 0; i < Math.min(oldStrings.length, 5); i++) {
        const entry = oldStrings[i] || {};
        const label = entry.label || `edit ${i}`;
        const oldString = entry.old_string;
        if (typeof oldString !== 'string' || oldString.length === 0) continue;
        const count = countOccurrences(content, oldString);
        checks.push(`${label}: old_string ${count === 1 ? 'found once' : count === 0 ? 'not found' : `found ${count} times`}`);
        if (!firstContext && count > 0) {
            const idx = content.indexOf(oldString);
            const startLine = lineForIndex(content, idx);
            const endLine = startLine + oldString.split('\n').length - 1;
            firstContext = lineContextAround(content, startLine, endLine);
        }
    }
    if (checks.length > 0) out.push(`Match check: ${checks.join('; ')}`);
    if (lineRange) {
        out.push(`Line check: requested ${lineRange.startLine}-${lineRange.endLine}; file has ${lines.length} lines.`);
        out.push(`Context around requested lines:\n${lineContextAround(content, lineRange.startLine, lineRange.endLine)}`);
    } else if (firstContext) {
        out.push(`Context around first match:\n${firstContext}`);
    }
    const diagnostic = out.join('\n');
    return { content, rawBuf, diagnostic: diagnostic || undefined };
}
