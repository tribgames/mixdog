// Self-contained unified diff so the plugin does not need to take on an
// external `diff` npm dep. LCS dynamic-programming table is O(n*m) memory
// and time for normal tool-sized inputs; very large inputs fall back to a
// compact "files differ" summary.
export function computeUnifiedDiff(a, b, ctx, fromLabel, toLabel) {
    const n = a.length;
    const m = b.length;
    if (n > 10000 || m > 10000 || n * m > 4_000_000) {
        if (n === m) {
            let same = true;
            for (let k = 0; k < n; k++) {
                if (a[k] !== b[k]) { same = false; break; }
            }
            if (same) return '';
        }
        return `--- ${fromLabel}\n+++ ${toLabel}\n(files too large for inline diff — ${n} vs ${m} lines)`;
    }

    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const aI = a[i];
        const rowI = dp[i];
        const rowI1 = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            if (aI === b[j]) rowI[j] = rowI1[j + 1] + 1;
            else rowI[j] = rowI1[j] >= rowI[j + 1] ? rowI1[j] : rowI[j + 1];
        }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i]]); i++; }
        else { ops.push(['+', b[j]]); j++; }
    }
    while (i < n) ops.push(['-', a[i++]]);
    while (j < m) ops.push(['+', b[j++]]);

    if (!ops.some((op) => op[0] !== '=')) return '';

    const hunks = [];
    let aLine = 1;
    let bLine = 1;
    let current = null;
    let eqRun = 0;
    const openHunk = (aStart, bStart) => ({ aStart, bStart, aCount: 0, bCount: 0, lines: [] });

    for (let k = 0; k < ops.length; k++) {
        const [op, line] = ops[k];
        if (op === '=') {
            if (current) {
                let nextChangeWithin = false;
                for (let la = 1; la <= ctx && k + la < ops.length; la++) {
                    if (ops[k + la][0] !== '=') { nextChangeWithin = true; break; }
                }
                if (nextChangeWithin || eqRun < ctx) {
                    current.lines.push([' ', line]);
                    current.aCount++;
                    current.bCount++;
                    eqRun++;
                } else {
                    hunks.push(current);
                    current = null;
                    eqRun = 0;
                }
            }
            aLine++;
            bLine++;
        } else {
            if (!current) {
                const leading = [];
                let leadA = 0;
                let leadB = 0;
                for (let back = k - 1; back >= 0 && leading.length < ctx; back--) {
                    if (ops[back][0] !== '=') break;
                    leading.unshift([' ', ops[back][1]]);
                    leadA++;
                    leadB++;
                }
                current = openHunk(aLine - leadA, bLine - leadB);
                current.lines.push(...leading);
                current.aCount += leadA;
                current.bCount += leadB;
            }
            if (op === '-') {
                current.lines.push(['-', line]);
                current.aCount++;
                aLine++;
            } else {
                current.lines.push(['+', line]);
                current.bCount++;
                bLine++;
            }
            eqRun = 0;
        }
    }
    if (current) hunks.push(current);

    const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
    for (const h of hunks) {
        const aHdr = h.aCount === 0 ? `${h.aStart - 1},0` : (h.aCount === 1 ? `${h.aStart}` : `${h.aStart},${h.aCount}`);
        const bHdr = h.bCount === 0 ? `${h.bStart - 1},0` : (h.bCount === 1 ? `${h.bStart}` : `${h.bStart},${h.bCount}`);
        out.push(`@@ -${aHdr} +${bHdr} @@`);
        for (const [sign, line] of h.lines) out.push(`${sign}${line}`);
    }
    return out.join('\n');
}
