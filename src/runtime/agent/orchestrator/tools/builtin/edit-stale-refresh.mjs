import { readFileSync } from 'fs';
import {
    diagnoseFoldTierAmbiguity,
    findActualString,
    formatStageInline,
} from '../edit-normalize.mjs';
import { assertEditTargetUtf8 } from './edit-utf8-guard.mjs';
import { hashText } from './hash-utils.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import {
    countLiteralOccurrences,
    findCrlfNormalisedMatches,
    findLiteralOccurrenceState,
    formatMatchLines,
    occurrenceLinesCrlf,
    occurrenceLinesPlain,
} from './edit-match-utils.mjs';
import { buildStaleEditRecovery } from './edit-failure-context.mjs';

function normalizeOldStringEntries(oldStrings) {
    const out = [];
    const src = Array.isArray(oldStrings) ? oldStrings : [];
    for (let i = 0; i < src.length; i++) {
        const entry = src[i];
        if (typeof entry === 'string') {
            out.push({ old_string: entry, replace_all: false, label: `edit ${i}` });
            continue;
        }
        if (!entry || typeof entry.old_string !== 'string') continue;
        out.push({
            old_string: entry.old_string,
            replace_all: entry.replace_all === true,
            label: entry.label || `edit ${i}`,
        });
    }
    return out;
}

function foldTierAmbiguityError(content, oldString, filePath, editPrefix = '') {
    const amb = diagnoseFoldTierAmbiguity(content, oldString);
    if (!amb || amb.count <= 1) return null;
    const stageNote = formatStageInline(amb.stage);
    return `Error [code 9]: ${editPrefix}old_string found ${amb.count} times in ${filePath}${stageNote};${formatMatchLines(amb.lines, amb.count)} set replace_all:true or provide more unique context`;
}

function oldStringMatchableOnCurrent(content, oldStr, replaceAll, { filePath, editPrefix }) {
    const literal = findLiteralOccurrenceState(content, oldStr);
    if (literal.count === 1) return { ok: true };
    if (literal.count > 1) {
        if (replaceAll) return { ok: true };
        const count = countLiteralOccurrences(content, oldStr);
        return {
            ok: false,
            error: `Error [code 9]: ${editPrefix}old_string found ${count} times in ${filePath} (exact);${formatMatchLines(occurrenceLinesPlain(content, oldStr), count)} set replace_all:true or provide more unique context`,
        };
    }

    const matchInfo = {};
    const matched = findActualString(content, oldStr, matchInfo) || null;
    if (matched) {
        const occ = findLiteralOccurrenceState(content, matched);
        if (occ.count === 1 || replaceAll) return { ok: true };
        const count = countLiteralOccurrences(content, matched);
        return {
            ok: false,
            error: `Error [code 9]: ${editPrefix}old_string found ${count} times in ${filePath}${formatStageInline(matchInfo.stage)};${formatMatchLines(occurrenceLinesPlain(content, matched), count)} set replace_all:true or provide more unique context`,
        };
    }

    const crlfMatch = findCrlfNormalisedMatches(content, oldStr);
    const crlfCount = crlfMatch ? crlfMatch.ranges.length : 0;
    if (crlfCount === 1 || (crlfCount > 1 && replaceAll)) return { ok: true };
    if (crlfCount > 1) {
        return {
            ok: false,
            error: `Error [code 9]: ${editPrefix}old_string found ${crlfCount} times in ${filePath} (via crlf-fold);${formatMatchLines(occurrenceLinesCrlf(content, crlfMatch.ranges), crlfCount)} set replace_all:true or provide more unique context`,
        };
    }

    const foldAmb = foldTierAmbiguityError(content, oldStr, filePath, editPrefix);
    if (foldAmb) return { ok: false, error: foldAmb };

    return { ok: false, notFound: true };
}

/**
 * When a read snapshot is stale and bytes no longer match the snapshot hash,
 * re-load current disk and allow the edit only if every old_string is
 * matchable on current content (unique unless replace_all). On success,
 * refresh the read snapshot to current bytes.
 */
export function attemptStaleEditAutoRefresh({
    fullPath,
    filePath,
    scope = null,
    stat = null,
    readRanges = [],
    oldStrings = [],
    readCache = null,
    recordPreviewSnapshot = false,
} = {}) {
    if (!fullPath) return null;

    let rawBuf;
    try {
        rawBuf = readFileSync(fullPath);
    } catch {
        return null;
    }
    if (!Buffer.isBuffer(rawBuf)) return null;

    const displayPath = filePath || normalizeOutputPath(fullPath);
    const utf8Err = assertEditTargetUtf8(rawBuf, displayPath);
    if (utf8Err) return { ok: false, error: utf8Err };

    const content = rawBuf.toString('utf-8');
    const entries = normalizeOldStringEntries(oldStrings);
    if (entries.length === 0) return null;

    for (const entry of entries) {
        const editPrefix = entries.length > 1 ? `${entry.label} — ` : '';
        const verdict = oldStringMatchableOnCurrent(content, entry.old_string, entry.replace_all, {
            filePath: displayPath,
            editPrefix,
        });
        if (verdict.error) return { ok: false, error: verdict.error };
        if (verdict.notFound) {
            // Friction fix (Codex-style): the snapshot is stale AND the
            // old_string is absent from CURRENT disk bytes. Don't force a
            // wasteful re-read turn — report a plain not-found against current
            // content (code 8) with recovery context, so the model can correct
            // the string in place without a separate Read call. Commit-time
            // race protection (validatePreparedEditBase / atomicWrite) is
            // unchanged.
            const recovery = buildStaleEditRecovery({
                fullPath,
                scope,
                oldStrings: entries,
                recordPreviewSnapshot,
            });
            return {
                ok: false,
                error: `Error [code 8]: old_string not found in ${displayPath} (file changed since read; matched against current content)${recovery}`,
            };
        }
    }

    try {
        recordReadSnapshot(fullPath, stat || undefined, scope, {
            source: 'stale_auto_refresh',
            contentHash: hashText(content),
            ranges: Array.isArray(readRanges) ? readRanges : [],
            replaceExisting: true,
        });
    } catch {
        return null;
    }

    if (readCache && typeof readCache.seedBuffer === 'function') {
        readCache.seedBuffer(fullPath, rawBuf);
    } else if (readCache) {
        readCache.rawBuf = rawBuf;
        readCache.content = content;
    }

    return { ok: true, content, rawBuf };
}