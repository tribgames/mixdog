import { snapshotCoversFullFile } from './snapshot-helpers.mjs';
import {
    firstDivergence,
    renderCodepointPreview,
    describeFirstDivergence,
    renderCharForDiff,
} from './edit-diagnostics.mjs';
import { editFailureSuffix } from './edit-match-utils.mjs';

function indentMismatchHint(_sentLine, _fileLine) {
    return '';
}

function firstLineFallbackStageHint(_content, _line) {
    return '';
}

function editNearestReadHint(_options, _line) {
    return '';
}

// Lightweight nearest-match hint for `Error [code 8]: old_string not
// found`. Probes by the first non-empty line of `old_string` (trimmed,
// capped at 60 chars then 30) so callers see where they likely meant
// to land. Substring only, no fuzzy diff, to keep the failure path cheap.
export function findEditHint(content, oldStr, snapshot = null, options = {}) {
    const oldLines = String(oldStr || '').split(/\r?\n/);
    const firstNonEmptyIndex = oldLines.findIndex((l) => l.trim().length > 0);
    const firstNonEmpty = firstNonEmptyIndex >= 0 ? oldLines[firstNonEmptyIndex] : '';
    const trimmed = firstNonEmpty.trim();
    const editIdx = Number.isInteger(options?.editIndex) ? options.editIndex : null;
    const idxTag = editIdx !== null ? ` [edit ${editIdx}]` : '';
    if (trimmed.length < 8) {
        // No probe long enough to anchor a nearest-match search. Still emit
        // an invariant divergence line so the caller knows where the closest
        // prefix landed instead of getting silence.
        const div = describeFirstDivergence(content, oldStr);
        if (!div) return '';
        return `${idxTag ? `\n  edit ${editIdx} miss:` : ''}`
            + `\n  diverge${idxTag}: at line ${div.line} col ${div.col} expected ${renderCharForDiff(div.expected)} but file has ${renderCharForDiff(div.found)} (common prefix ${div.prefixLen} chars from line ${div.startLine} col ${div.startCol})`;
    }
    const probes = [trimmed.slice(0, 60), trimmed.slice(0, 30)].filter((p) => p.length >= 8);
    const lines = String(content).split('\n');

    let normHint = '';
    try {
        const rawContent = String(content);
        const rawOld = String(oldStr);
        if (rawContent.indexOf(rawOld) === -1) {
            const nfcContent = rawContent.normalize('NFC');
            const nfcOld = rawOld.normalize('NFC');
            const nfdContent = rawContent.normalize('NFD');
            const nfdOld = rawOld.normalize('NFD');
            if (nfcOld !== rawOld && nfcContent.indexOf(nfcOld) !== -1) {
                normHint = ' Unicode normalisation mismatch: NFC-normalising old_string matches the file. Re-send old_string in NFC form (e.g. JS `s.normalize("NFC")`).';
            } else if (nfdOld !== rawOld && nfdContent.indexOf(nfdOld) !== -1 && nfcContent.indexOf(nfcOld) === -1) {
                normHint = ' Unicode normalisation mismatch: NFD form of old_string matches the file but NFC does not. The file likely stores NFD; re-send old_string in NFD form.';
            }
        }
    } catch {}

    let winStart = 1;
    let winEnd = lines.length;
    if (snapshot && !snapshotCoversFullFile(snapshot)) {
        const ranges = Array.isArray(snapshot.ranges) ? snapshot.ranges : [];
        if (ranges.length === 0) return normHint;
        winStart = ranges[0].startLine;
        const last = ranges[ranges.length - 1];
        winEnd = last.endLine === Infinity ? lines.length : Math.min(lines.length, last.endLine);
    }
    for (const probe of probes) {
        for (let i = winStart - 1; i < winEnd; i++) {
            if (lines[i] !== undefined && lines[i].includes(probe)) {
                const preview = lines[i].length > 80 ? lines[i].slice(0, 77) + '...' : lines[i];
                const sentPreview = renderCodepointPreview(firstNonEmpty, 40);
                const filePreview = renderCodepointPreview(lines[i], 40);
                const probeIdx = lines[i].indexOf(probe);
                const sliceForDiff = probeIdx >= 0 ? lines[i].slice(probeIdx, probeIdx + trimmed.length) : lines[i];
                const div = firstDivergence(trimmed, sliceForDiff);
                // Translate the intra-slice char offset back into absolute
                // file line+col so the operator can jump straight to the
                // mismatch. lines[] is split on \n, so col is 1-based within
                // the line. The probe sits at probeIdx (0-based) inside the
                // nearest line; the divergence sits div.index codepoints
                // further along. Fall back to `describeFirstDivergence` when
                // the probe-vs-trimmed compare reports no divergence (i.e.
                // probe is a true prefix of the slice) — we still want a
                // global coordinate against the full old_string.
                let divLine = '';
                if (div) {
                    const lineNo = i + 1;
                    const col = (probeIdx >= 0 ? probeIdx : 0) + div.index + 1;
                    divLine = `\n  diverge${idxTag}: at line ${lineNo} col ${col} expected ${renderCharForDiff(div.expected)} but file has ${renderCharForDiff(div.found)}`;
                } else {
                    const globalDiv = describeFirstDivergence(content, oldStr);
                    if (globalDiv && globalDiv.prefixLen < String(oldStr).length) {
                        divLine = `\n  diverge${idxTag}: at line ${globalDiv.line} col ${globalDiv.col} expected ${renderCharForDiff(globalDiv.expected)} but file has ${renderCharForDiff(globalDiv.found)} (common prefix ${globalDiv.prefixLen} chars from line ${globalDiv.startLine} col ${globalDiv.startCol})`;
                    }
                }
                return ` Nearest match${idxTag} at line ${i + 1}: ${JSON.stringify(preview)}.${normHint}`
                    + `\n  sent : ${sentPreview}`
                    + `\n  file : ${filePreview}`
                    + divLine
                    + indentMismatchHint(firstNonEmpty, lines[i])
                    + firstLineFallbackStageHint(content, firstNonEmpty)
                    + editNearestReadHint(options, i + 1)
                    + editFailureSuffix(content, oldStr);
            }
        }
    }
    // Invariant fallback: no probe landed, but the operator still needs a
    // file coordinate. Run the longest-common-prefix scan against the full
    // old_string so the miss is debuggable rather than silent.
    const globalDiv = describeFirstDivergence(content, oldStr);
    const globalLine = globalDiv && globalDiv.prefixLen < String(oldStr).length
        ? `\n  diverge${idxTag}: at line ${globalDiv.line} col ${globalDiv.col} expected ${renderCharForDiff(globalDiv.expected)} but file has ${renderCharForDiff(globalDiv.found)} (common prefix ${globalDiv.prefixLen} chars from line ${globalDiv.startLine} col ${globalDiv.startCol})`
        : '';
    return normHint + globalLine + editFailureSuffix(content, oldStr);
}
