// Frozen pre-optimization reference for differential tests and local probes.
// This is deliberately not imported by product code.
export function legacyTokenFloors(s) {
    let floor = 0;
    for (const match of s.matchAll(/[\x21-\x7e]{16,}/g)) {
        floor += match[0].length * (match[0].length >= 64 ? 0.65 : 0.5);
    }
    const words = s.match(/\b(?=[A-Za-z0-9]{8,}\b)(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g) || [];
    if (words.length >= 3) {
        const chars = words.reduce((sum, word) => sum + word.length, 0);
        floor = Math.max(floor, chars * 0.5 + (s.length - chars) * 0.25);
    }
    const lines = s.split(/\r?\n/).filter(line => line.trim());
    const nonWhitespace = s.match(/\S/g)?.length || 0;
    const structural = s.match(/[\[\]{}":,=<>|\\]/g)?.length || 0;
    const jsonLines = lines.filter(line => /^\s*[\[{].*[\]}],?\s*$/.test(line)).length;
    if (lines.length >= 3 && nonWhitespace > 0
        && (jsonLines >= Math.ceil(lines.length / 2) || structural / nonWhitespace >= 0.12)) {
        floor = Math.max(floor, nonWhitespace * 0.5 + (s.length - nonWhitespace) * 0.25);
    }
    return floor;
}

const text = item => typeof item.text === 'string' ? item.text : item.text == null ? '' : String(item.text);
const ownsId = item => item.id !== undefined && item.id !== null;
const signature = item => [item.kind, item.status, item.label, item.tone, item.verb,
    item.count, item.completedCount, item.detail].map(value => String(value ?? '')).join('\u0001');

export function legacyAlignment(previous, incoming) {
    let best = null;
    for (let offset = 0; offset < previous.length; offset++) {
        const span = Math.min(previous.length - offset, incoming.length);
        let overlap = 0, idMatches = 0, strongMatches = 0;
        for (; overlap < span; overlap++) {
            const a = previous[offset + overlap], b = incoming[overlap];
            const at = text(a), bt = text(b);
            const compatible = a.kind === b.kind && (a.kind === 'tool'
                ? String(a.name ?? '') === String(b.name ?? '')
                : a.kind === 'user' || a.kind === 'assistant'
                    ? at === bt || (at.length > 0 && bt.length > 0 && (at.startsWith(bt) || bt.startsWith(at)))
                    : true);
            if (a !== b && !compatible) break;
            if (ownsId(a) && ownsId(b) && String(a.id) === String(b.id)) idMatches++;
            if (a === b || (a.kind === b.kind && at === bt
                && String(a.name ?? '') === String(b.name ?? '') && signature(a) === signature(b))) strongMatches++;
        }
        if (!overlap || overlap !== span) continue;
        const candidate = { offset, overlap, idMatches, strongMatches, endsAtBaselineTail: offset + overlap === previous.length };
        const rank = item => [item.overlap, item.idMatches, item.strongMatches,
            Number(item.endsAtBaselineTail), incoming.length < previous.length ? item.offset : -item.offset];
        const a = rank(candidate), b = best && rank(best);
        const different = b ? a.findIndex((value, index) => value !== b[index]) : -1;
        if (!best || (different >= 0 && a[different] > b[different])) best = candidate;
    }
    return best;
}
