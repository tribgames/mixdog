// Server-less, preview-first symbol rename.
//
// Mixdog has no semantic LSP. This tool reuses the existing code-graph
// find_references API to collect every reference site for a symbol, then —
// BY DEFAULT — returns a PREVIEW only: the {file,line,col,context} sites that
// WOULD change, plus an explicit warning that the match is graph-based
// (approximate, not LSP-semantic) and may include same-named-but-different
// symbols. The destructive rewrite runs ONLY when apply===true, and replaces
// the symbol EXACTLY at the {line,col} spans find_references returned —
// verifying the slice equals the symbol before splicing. It never blanket-
// replaces a line, so same-line string/comment occurrences the reference
// search did NOT sanction are left untouched, `$`-identifiers can't mis-match
// inside larger identifiers, and original (possibly mixed) line endings are
// preserved verbatim.
import { readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve as pathResolve } from 'path';
import { executeCodeGraphTool, markCodeGraphDirtyPaths } from '../code-graph.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';

const APPROX_WARNING =
    'APPROXIMATE: matches come from the code-graph (text/word-boundary based), '
    + 'NOT an LSP-semantic resolver. They may include same-named-but-different '
    + 'symbols (shadowed locals, unrelated properties, etc.). Review every site '
    + 'before applying.';

// A valid JS/TS/Py-style identifier — required so we never attempt a rewrite
// of an arbitrary string that would corrupt source via word-boundary regex.
function _isIdentifier(s) {
    return typeof s === 'string' && /^[A-Za-z_$][\w$]*$/.test(s);
}

// Parse find_references text output. Each hit line is `rel:line:col    context`.
// Diagnostic/footer lines (starting with `(` or `[`) and blanks are skipped.
function _parseReferenceLines(text) {
    const sites = [];
    if (typeof text !== 'string') return sites;
    const re = /^(.+?):(\d+):(\d+)\s{2,}(.*)$/;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line) continue;
        if (line.startsWith('(') || line.startsWith('[') || line.startsWith('#')) continue;
        const m = re.exec(line);
        if (!m) continue;
        sites.push({ file: m[1], line: +m[2], col: +m[3], context: m[4] });
    }
    return sites;
}

function _absFor(file, workDir) {
    return isAbsolute(file) ? file : pathResolve(workDir, file);
}

// Split content into physical lines while preserving each line's own trailing
// terminator (\r\n, \n, or '' for the last line). This lets us rewrite a single
// line's text and re-join with the EXACT original endings — no normalization of
// mixed line endings.
function _splitKeepEol(content) {
    const out = [];
    const re = /\r\n|\n|\r/g;
    let last = 0;
    let m = null;
    while ((m = re.exec(content))) {
        out.push({ text: content.slice(last, m.index), eol: m[0] });
        last = m.index + m[0].length;
    }
    out.push({ text: content.slice(last), eol: '' });
    return out;
}

// Apply the rename ONLY at the exact {line,col} spans find_references returned.
// For each site we verify the slice [col-1 .. col-1+symbol.length] === symbol
// before splicing; if it doesn't match (stale graph, shifted line, or an
// occurrence the search didn't sanction) the site is recorded as skipped and
// nothing on that line is touched. Identity-check + slice splice replaces the
// previous `\b`-regex line rewrite, which mishandled `$`-identifiers and
// clobbered same-line non-reference occurrences.
function _applyRename(sites, symbol, newName, workDir) {
    const byFile = new Map();
    for (const s of sites) {
        const abs = _absFor(s.file, workDir);
        if (!byFile.has(abs)) byFile.set(abs, []);
        byFile.get(abs).push(s);
    }
    const changed = [];
    const skipped = [];
    let replacements = 0;
    for (const [abs, fileSites] of byFile) {
        let content;
        try { content = readFileSync(abs, 'utf8'); }
        catch (err) {
            for (const s of fileSites) skipped.push({ ...s, reason: `read failed: ${err && err.message ? err.message : String(err)}` });
            continue;
        }
        const lines = _splitKeepEol(content);
        // Replace from rightmost column first within a line so earlier splices
        // don't shift the offsets of later ones on the same line.
        const ordered = fileSites.slice().sort((a, b) => (a.line - b.line) || (b.col - a.col));
        let fileTouched = false;
        for (const s of ordered) {
            const idx = s.line - 1;
            if (idx < 0 || idx >= lines.length) { skipped.push({ ...s, reason: 'line out of range' }); continue; }
            const start = s.col - 1;
            const text = lines[idx].text;
            if (start < 0 || start + symbol.length > text.length) { skipped.push({ ...s, reason: 'column out of range' }); continue; }
            const slice = text.slice(start, start + symbol.length);
            if (slice !== symbol) { skipped.push({ ...s, reason: `slice mismatch (got ${JSON.stringify(slice)})` }); continue; }
            lines[idx].text = text.slice(0, start) + newName + text.slice(start + symbol.length);
            replacements += 1;
            fileTouched = true;
        }
        if (fileTouched) {
            writeFileSync(abs, lines.map((l) => l.text + l.eol).join(''), 'utf8');
            changed.push(abs);
        }
    }
    return { changed, replacements, skipped };
}

export async function executeRenameTool(args, workDir, signal = null) {
    try {
        const symbol = (args && typeof args.symbol === 'string') ? args.symbol.trim() : '';
        const newName = (args && typeof args.new_name === 'string') ? args.new_name.trim() : '';
        const file = (args && typeof args.file === 'string' && args.file.trim()) ? args.file.trim() : '';
        const apply = args && args.apply === true;
        if (!symbol) return 'Error: rename requires "symbol"';
        if (!newName) return 'Error: rename requires "new_name"';
        if (!_isIdentifier(symbol)) return `Error: rename "symbol" must be a valid identifier (got ${JSON.stringify(args.symbol)})`;
        if (!_isIdentifier(newName)) return `Error: rename "new_name" must be a valid identifier (got ${JSON.stringify(args.new_name)})`;
        if (symbol === newName) return 'Error: rename "new_name" is identical to "symbol"; nothing to do';

        // Collect reference sites via the code-graph references mode.
        const refArgs = { mode: 'references', symbol };
        if (file) refArgs.file = file;
        const refText = await executeCodeGraphTool('code_graph', refArgs, workDir, signal);
        if (typeof refText === 'string' && refText.startsWith('Error:')) {
            return refText;
        }
        const sites = _parseReferenceLines(refText);

        if (sites.length === 0) {
            return JSON.stringify({
                ok: true,
                mode: apply ? 'apply' : 'preview',
                symbol,
                new_name: newName,
                warning: APPROX_WARNING,
                count: 0,
                sites: [],
                note: 'no reference sites found — nothing to rename',
            }, null, 2);
        }

        // DEFAULT: preview only. Never mutate on the default call. The CORE of
        // the payload is the approximate-match warning plus the change-list of
        // {file,line,col,context} sites that WOULD change; ok/mode/count/hint are
        // secondary metadata.
        if (!apply) {
            return JSON.stringify({
                warning: APPROX_WARNING,
                changes: sites,
                ok: true,
                mode: 'preview',
                symbol,
                new_name: newName,
                count: sites.length,
                hint: 'Re-run with apply:true to perform the rename at these sites.',
            }, null, 2);
        }

        // apply===true: perform the gated rewrite at the exact sanctioned spans.
        const { changed, replacements, skipped } = _applyRename(sites, symbol, newName, workDir);
        if (changed.length) {
            try { invalidateBuiltinResultCache(changed); } catch {}
            try { markCodeGraphDirtyPaths(changed); } catch {}
        }
        const result = {
            ok: true,
            mode: 'apply',
            symbol,
            new_name: newName,
            warning: APPROX_WARNING,
            sites_considered: sites.length,
            replacements,
            files_changed: changed.map((p) => (p.startsWith(workDir) ? p.slice(workDir.length).replace(/^[\\/]/, '') : p)),
        };
        if (skipped.length) {
            result.skipped = skipped;
            result.skipped_warning = `${skipped.length} site(s) were NOT renamed (offset out of range or the slice did not match the symbol). They were left untouched; review them manually.`;
        }
        return JSON.stringify(result, null, 2);
    } catch (err) {
        return JSON.stringify({ ok: false, error: `rename failed: ${err && err.message ? err.message : String(err)}` }, null, 2);
    }
}

export default executeRenameTool;
