export function splitGrepLineNumberOnlyPrefix(line) {
    const text = String(line || '');
    const m = /^(\d+)([:\-])/.exec(text);
    if (!m) return null;
    return {
        markerEnd: m[0].length,
        delimiter: m[2],
        lineNo: Number(m[1]),
    };
}

export function splitGrepLinePrefix(line) {
    const text = String(line || '');
    if (!text) return null;
    const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
    // content/count modes — rg emits, after any optional drive-letter prefix:
    //   match:    path:lineNo:content  (output_mode content default)
    //   context:  path-lineNo-content  (-A / -B / -C context lines)
    // Caller context decides whether line-number-only output is possible. A
    // relative path may itself start with digits + '-' (e.g. `12-x\path.txt`),
    // so this parser must not reject `^\d+[:\-]` by shape alone.
    const delim = text.slice(searchFrom).match(/([:\-])(\d+)\1/);
    if (!delim) return null;
    const pathEnd = searchFrom + delim.index;
    if (pathEnd <= 0) return null;
    return {
        path: text.slice(0, pathEnd),
        pathEnd,
        markerEnd: pathEnd + delim[0].length,
        delimiter: delim[1],
        lineNo: Number(delim[2]),
    };
}

export function splitGrepCountPrefix(line) {
    const text = String(line || '');
    if (!text || /^\d+$/.test(text)) return null;
    const searchFrom = /^[A-Za-z]:/.test(text) ? 2 : 0;
    const idx = text.lastIndexOf(':');
    if (idx <= searchFrom) return null;
    const count = text.slice(idx + 1);
    if (!/^\d+$/.test(count)) return null;
    return { path: text.slice(0, idx), pathEnd: idx, count: Number(count) };
}

export function normalizeGrepLine(line, pathOnly = false, outputMode = 'content', filenameOmitted = false) {
    if (process.platform !== 'win32') return line;
    // files_with_matches mode: the WHOLE line is a path, so every separator is
    // a path separator and a full `\`->`/` normalisation is correct.
    if (pathOnly) return line.replace(/\\/g, '/');
    // Single-file rg omits the filename entirely:
    //   match:   N:content
    //   context: N-content
    // There is no path prefix to normalise; everything after ^\d+[:\-] is
    // source content and must remain byte-exact.
    if (filenameOmitted && splitGrepLineNumberOnlyPrefix(line)) return line;
    const split = splitGrepLinePrefix(line);
    if (split) {
        return line.slice(0, split.pathEnd).replace(/\\/g, '/') + line.slice(split.pathEnd);
    }
    if (outputMode === 'count') {
        const countSplit = splitGrepCountPrefix(line);
        if (countSplit) {
            return line.slice(0, countSplit.pathEnd).replace(/\\/g, '/') + line.slice(countSplit.pathEnd);
        }
    }
    // No confirmed path prefix. Do not fall back to "first colon" slicing:
    // single-file context lines are `N-content`, so their first colon may be a
    // ternary/object literal inside CONTENT. Replacing `\` before that colon
    // corrupts source anchors (`\n` -> `/n`).
    return line;
}

function parseGrepContentLine(line) {
    const text = String(line || '');
    if (!text || text === '--' || text.startsWith('... [')) return null;
    const split = splitGrepLinePrefix(text);
    if (!split || split.delimiter !== ':') return null;
    const content = text.slice(split.markerEnd);
    return { path: split.path, lineNo: split.lineNo, content };
}

export function groupGrepContentByFile(lines) {
    const groupOrder = [];
    const groups = new Map();
    const others = [];
    for (const line of lines) {
        const parsed = parseGrepContentLine(line);
        if (!parsed) {
            others.push(line);
            continue;
        }
        if (!groups.has(parsed.path)) {
            groups.set(parsed.path, []);
            groupOrder.push(parsed.path);
        }
        groups.get(parsed.path).push(parsed);
    }
    if (groupOrder.length === 0) return others.join('\n');
    const out = [];
    for (const path of groupOrder) {
        const hits = groups.get(path);
        out.push(hits.length === 1 ? path : `${path} (${hits.length} hits)`);
        for (const hit of hits) {
            out.push(`  ${hit.lineNo}: ${hit.content}`);
        }
    }
    if (others.length) {
        out.push('');
        out.push(...others);
    }
    return out.join('\n');
}
