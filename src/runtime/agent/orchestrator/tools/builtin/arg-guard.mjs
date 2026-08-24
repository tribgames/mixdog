// Lightweight argument shape validator for builtin tools.
//
// Goal: catch obvious schema violations (wrong types, missing required
// fields, out-of-range numeric clamps) BEFORE the underlying executor
// touches them and crashes the MCP child. Returns null on success, or
// a clean human-readable error string on failure (never throws).
//
// Validation operates on the alias family, not the canonical key, so
// callers may pass either spelling (e.g. `glob` alias for grep, or
// `file_path` alias for read.path).

import { coerceReadFamilyPathArg, coerceShapeFlex, hasGlobMagic } from './path-utils.mjs';

const MAX_INT = 100000;
// Explicit grep context should be large enough to frame a function/block without
// letting one match explode into a huge tool result. `content_with_context` still
// defaults to 25 lines; this is only the upper bound for caller-supplied -A/-B/-C.
export const GREP_CONTEXT_MAX = 200;

// Tighter cap for CONTEXT-MODE grep (content_with_context or explicit -A/-B/-C):
// head_limit counts MATCH BLOCKS in that mode, so ~40 blocks is already a large
// read. Context width itself (-A/-B/-C) is deliberately NOT special-cased —
// explicit requests are honored up to the generic GREP_CONTEXT_MAX; total
// output stays bounded by the block clamp, the stream line cap, and the
// tool-output byte cap.
const GREP_CTX_HEAD_LIMIT_MAX = 40;

// Unbounded (no offset/limit) plain full reads default to this window instead of
// pulling the whole file; the read tool's ranged-read footer then hands the
// caller the next offset to page with. At 1000 a single default read returned
// 51KB of an unread log; halving it capped the largest read at 20KB and the
// callers paged on instead of re-reading (tool-budget bench, 20260821).
// MIXDOG_READ_DEFAULT_LIMIT overrides for A/B runs.
const READ_GUARD_DEFAULT_LIMIT = (() => {
    const parsed = parseInt(process.env.MIXDOG_READ_DEFAULT_LIMIT ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();

// Best-effort clamp notice channel: stash a one-line note on the args so a
// surfacing consumer can echo it. Underscore-prefixed; ignored by executors.
function pushClampNotice(a, msg) {
    if (!a || typeof a !== 'object') return;
    if (!Array.isArray(a._clampNotices)) a._clampNotices = [];
    a._clampNotices.push(msg);
}

// ripgrep-flavored aliases: models trained on `rg` emit short flags (-A/-B/-C),
// long flags (--after-context / --before-context / --context), or snake/camel
// spellings. All fold onto the canonical -A/-B/context so a caller can write grep
// the way they would write ripgrep on the shell.
const GREP_CONTEXT_KEY_GROUPS = [
    ['-A', ['-A', 'A', 'after', 'after_context', 'afterContext', '--after-context', 'after-context', 'afterLines', 'after_lines']],
    ['-B', ['-B', 'B', 'before', 'before_context', 'beforeContext', '--before-context', 'before-context', 'beforeLines', 'before_lines']],
    ['context', ['context', '-C', 'C', 'context_lines', 'contextLines', '--context', 'contextN', 'around', 'surrounding']],
];

function grepContextKeyPresent(a, k) {
    return a && Object.prototype.hasOwnProperty.call(a, k)
        && a[k] !== undefined && a[k] !== null && a[k] !== '';
}

function firstGrepContextArg(args, keys) {
    for (const k of keys) {
        if (grepContextKeyPresent(args, k)) return { key: k, value: args[k] };
    }
    return null;
}

function firstNonZeroGrepContextArg(args, keys) {
    for (const k of keys) {
        if (grepContextKeyPresent(args, k) && !isGrepContextZero(args[k])) return { key: k, value: args[k] };
    }
    return null;
}

function isGrepContextZero(value) {
    const n = Number(value);
    return Number.isFinite(n) && n === 0;
}

function clearGrepContextKeys(args, keys) {
    for (const k of keys) delete args[k];
}

/** Lead-facing grep context: canonicalize aliases and clamp explicit values (overrides still apply). */
export function applyGrepContextLeadPolicy(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    // Idempotent guard: the outer builtin guard (validateBuiltinArgs) and the
    // executor (executeGrepTool) both call this on the SAME args object. The
    // first pass folds aliases onto -A/-B/context and clamps; a second pass would
    // recompute the same folding for no effect. Skip once applied.
    if (args._grepContextPolicyApplied) return;
    for (const [canonical, keys] of GREP_CONTEXT_KEY_GROUPS) {
        const found = firstNonZeroGrepContextArg(args, keys) || firstGrepContextArg(args, keys);
        if (!found) continue;
        const n = Number(found.value);
        const shaped = Number.isFinite(n) && n > GREP_CONTEXT_MAX ? GREP_CONTEXT_MAX : found.value;
        clearGrepContextKeys(args, keys);
        args[canonical] = shaped;
    }
    // Non-enumerable so it never leaks into arg spreads, cache keys, or output.
    try {
        Object.defineProperty(args, '_grepContextPolicyApplied', {
            value: true, enumerable: false, configurable: true, writable: true,
        });
    } catch { args._grepContextPolicyApplied = true; }
}

function isString(v) {
    return typeof v === 'string';
}

function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

function isStringOrStringArray(v) {
    if (typeof v === 'string') return true;
    if (!Array.isArray(v) || v.length === 0) return false;
    for (const x of v) {
        if (typeof x !== 'string') return false;
    }
    return true;
}

export function hasUnsupportedRipgrepRegex(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.some((item) => {
        if (typeof item !== 'string') return false;
        return /\(\?(?:[=!]|<[=!])/.test(item) || /\\[1-9]/.test(item);
    });
}

function hasMultipleAbsoluteWindowsPaths(value) {
    if (typeof value !== 'string') return false;
    const matches = value.match(/[A-Za-z]:[\\/]/g);
    return Array.isArray(matches) && matches.length > 1;
}

function hasWindowsDrivePath(value) {
    return typeof value === 'string' && /[A-Za-z]:[\\/]/.test(value);
}

function isFiniteInt(v) {
    return typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
}

// Lossless numeric-string coercion for integer-shaped args. Models
// occasionally emit JSON-schema-violating numeric strings ("850",
// "850.0") for fields the schema types as number (offset/limit/n/
// head_limit/-A/-B/-C/context/line). Both are unambiguous integer
// values, so coerce them to a real number before validating rather
// than rejecting and forcing a retry turn. Non-integer or non-numeric
// strings ("3.5", "soon") are left untouched and fall through to the
// existing rejection below.
function coerceIntegerString(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
}

function comparableEchoPath(value) {
    const normalized = String(value ?? '').trim().replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Grok sometimes appends a rendered `path` annotation to an otherwise valid
// integer field. Strip only the two observed delimiters and only when the
// echoed suffix exactly matches this read call's scalar path.
function absorbReadEchoedPathInteger(a, field) {
    const value = a?.[field];
    if (typeof value !== 'string') return;
    const match = /^(\d+)(?:\s+├──path──|\s*usepath\?)(.+)$/s.exec(value.trim());
    if (!match) return;
    const target = typeof a.file_path === 'string'
        ? a.file_path
        : (typeof a.path === 'string' ? a.path : '');
    if (!target || comparableEchoPath(match[2]) !== comparableEchoPath(target)) return;
    a[field] = Number(match[1]);
}

// Range-shaped strings ("1,40", "1-40", "1:40") are a common model mistake
// when trying to pass a line range through a single-integer field. They are
// not coerced (ambiguous which bound is intended); instead the rejection
// tells the model exactly what to do instead.
const RANGE_SHAPED_INT_STRING = /^\d+\s*[,\-:]\s*\d+$/;

// Coerce a window arg that may arrive as a real array or a JSON-stringified
// array ("[0, 0]") into a real array; returns null when it is neither.
function coerceWindowArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        let c = coerceShapeFlex(v);
        // Double-encoded window strings ('"[0, 0]"') unwrap to the inner
        // string '[0, 0]' on the first flex pass — re-run once to reach the
        // array. Lossless: only applies when the outer layer was a JSON
        // string wrapper.
        if (typeof c === 'string' && c !== v) c = coerceShapeFlex(c);
        if (Array.isArray(c)) return c;
    }
    return null;
}

// Absorb: offset/limit arriving as parallel arrays (or JSON-stringified
// arrays) alongside a path[] batch — zip each window onto its file as a
// {path,offset,limit} region object, mirroring the lossless path JSON-string
// recovery. A length-1 window array applies to every file. Per-entry integer
// coercion/validation then runs on the resulting region objects. Length
// mismatches zip positionally (absorb, don't hard-error); a single path with
// multiple windows expands into regions of that path.
function maybeZipPathWindowArrays(a) {
    // A single-string path also zips when the windows are ARRAYS (e.g.
    // path:'x.mjs', offset:'[0, 100]') — coerceReadFamilyPathArg unwraps
    // one-element path[] to a string before this runs, so without this the
    // window string would survive to the integer guard and hard-error.
    if (typeof a.path === 'string' && a.path
        && (coerceWindowArray(a.offset) || coerceWindowArray(a.limit))) {
        a.path = [a.path];
    }
    if (!Array.isArray(a.path) || a.path.length < 1) return;
    if (!a.path.every((e) => typeof e === 'string')) return;
    const offs = coerceWindowArray(a.offset);
    const lims = coerceWindowArray(a.limit);
    if (!offs && !lims) return;
    const n = a.path.length;
    const pick = (arr, i) => (arr ? (arr.length === 1 ? arr[0] : arr[i]) : undefined);
    // Single path + multiple windows -> regions of the SAME path (the model
    // asked for several spans of one file).
    const k = Math.max(offs?.length || 0, lims?.length || 0);
    if (n === 1 && k > 1) {
        const p = a.path[0];
        a.path = Array.from({ length: k }, (_, i) => {
            const r = { path: p };
            const o = pick(offs, i); if (o !== undefined && o !== null) r.offset = o;
            const l = pick(lims, i); if (l !== undefined && l !== null) r.limit = l;
            return r;
        });
        delete a.offset;
        delete a.limit;
        return;
    }
    // Positional zip. Length mismatches absorb instead of hard-erroring
    // (seen live: 3 paths + offset "[350, 1]"): missing entries mean
    // full-file read for that path; extra window entries are dropped.
    a.path = a.path.map((p, i) => {
        const r = { path: p };
        const o = pick(offs, i); if (o !== undefined && o !== null) r.offset = o;
        const l = pick(lims, i); if (l !== undefined && l !== null) r.limit = l;
        return r;
    });
    delete a.offset;
    delete a.limit;
}

// Cursor/Codex spelling: offset:-N means last N lines. Rewrite to mode:tail
// before the >=0 check; a leftover offset/limit would also drop tail later.
function absorbNegativeReadOffset(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !isPresent(obj, 'offset')) return;
    let value = obj.offset;
    if (typeof value === 'string') {
        const coerced = coerceIntegerString(value);
        if (coerced !== null) {
            value = coerced;
            obj.offset = coerced;
        }
    }
    if (!isFiniteInt(value) || value >= 0) return;
    const n = Math.min(MAX_INT, Math.abs(value));
    if (!isPresent(obj, 'mode')) obj.mode = 'tail';
    if (!isPresent(obj, 'n')) obj.n = n;
    delete obj.offset;
    delete obj.limit;
}

// Mutates a[field] in place when it is a lossless integer string, then
// validates the (possibly coerced) value against [min, max].
function checkIntInRange(a, field, min, max, opts = {}) {
    let value = a[field];
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') {
        const coerced = coerceIntegerString(value);
        if (coerced !== null) {
            value = coerced;
            a[field] = coerced;
        }
    }
    if (typeof value === 'string' && RANGE_SHAPED_INT_STRING.test(value.trim())) {
        return `Error: "${field}" takes one integer, not a range "${value}" — use offset+limit (e.g. offset:0, limit:40)`;
    }
    // Soft-cap fields only: floor a fractional number (e.g. -B: 2.5) instead
    // of erroring — intent is unambiguous for a context-line count.
    if (opts.clamp && typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
        value = Math.floor(value);
        a[field] = value;
    }
    if (!isFiniteInt(value)) {
        return `Error: "${field}" must be an integer (got ${describeType(value)}) — e.g. ${field}:40`;
    }
    // Soft-cap fields (grep -A/-B/-C/context): silently clamp out-of-range
    // instead of erroring — a model-guessed "300" for a 200-line cap is not
    // a shape violation worth a retry turn, just clamp to the boundary.
    if (opts.clamp) {
        if (value < min) { a[field] = min; return null; }
        if (value > max) { a[field] = max; return null; }
        a[field] = value;
        return null;
    }
    if (value < min) {
        return `Error: builtin arg "${field}" must be >= ${min} (got ${value})`;
    }
    // Over-max is clamped to the cap instead of erroring: an over-large
    // integer is an unambiguous "as much as allowed" request, not a shape
    // violation worth a retry turn (mirrors the soft-cap clamp above).
    // Under-min still errors — a negative where >=0 is required is a real
    // mistake, not a saturating intent.
    if (value > max) {
        a[field] = max;
        return null;
    }
    a[field] = value;
    return null;
}

function describeType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function hasOwn(o, k) {
    return o && Object.prototype.hasOwnProperty.call(o, k);
}

function isPresent(o, k) {
    return hasOwn(o, k) && o[k] !== undefined && o[k] !== null;
}

function isNonEmptyPresent(o, k) {
    return isPresent(o, k) && o[k] !== '';
}

// Strip trailing literal artifacts from a grep pattern: a literal two-char
// "\n" (backslash + n) that ripgrep rejects outside multiline mode ("the
// literal \"\\n\" is not allowed"), possibly preceded by concatenation
// debris like `">` that rides along with it (e.g. a stray closing-tag
// fragment glued on by string interpolation). `">` is ONLY stripped when
// it is directly followed by one of those newline artifacts — a bare
// trailing `">` with no newline riding along (e.g. a legit HTML/JSX
// attribute pattern like `class="active">`) is a real search target and
// must survive untouched. A \n in the middle of a pattern is also left
// untouched; only the tail is ever trimmed.
function stripTrailingPatternArtifacts(v) {
    if (typeof v !== 'string') return v;
    let out = v;
    let changed = true;
    while (changed) {
        changed = false;
        if (out.endsWith('">\n')) { out = out.slice(0, -3); changed = true; continue; }
        if (out.endsWith('">\\n')) { out = out.slice(0, -4); changed = true; continue; }
        if (out.endsWith('\n')) { out = out.slice(0, -1); changed = true; continue; }
        if (out.endsWith('\\n')) { out = out.slice(0, -2); changed = true; continue; }
    }
    return out;
}

function coercePatternStringValues(v) {
    const coerce = (value) => (
        (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
            ? String(value)
            : value
    );
    return Array.isArray(v) ? v.map(coerce) : coerce(v);
}

// ---- per-tool guards ----

function guardGrep(a) {
    // pattern aliases
    const patternKeys = ['pattern', 'query', 'regex', 'needle'];
    // glob (file filter) aliases
    const globKeys = ['glob', 'file_pattern', 'include', 'files'];

    // Lossless cleanup of trailing artifacts before validation (item 5b).
    for (const k of patternKeys) {
        if (hasOwn(a, k)) {
            const value = coercePatternStringValues(a[k]);
            a[k] = Array.isArray(value)
                ? value.map(stripTrailingPatternArtifacts)
                : stripTrailingPatternArtifacts(value);
        }
    }

    const hasPattern = patternKeys.some((k) => hasOwn(a, k));
    const hasGlob = globKeys.some((k) => hasOwn(a, k));
    if (!hasPattern && !hasGlob) {
        return 'Error: grep requires pattern (or alias query/regex/needle) or glob.';
    }
    for (const k of patternKeys) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: grep arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
    }
    // Lookaround/backreference patterns are no longer hard-rejected here:
    // executeGrepTool (search-tool.mjs) detects them at runtime and routes to
    // rg's PCRE2 engine (-P/--pcre2) when the installed rg build supports it,
    // falling back to this same error text only when PCRE2 is unavailable.
    for (const k of globKeys) {
        if (hasOwn(a, k)) a[k] = coercePatternStringValues(a[k]);
        if (hasOwn(a, k) && !isString(a[k])) {
            return `Error: grep arg "${k}" must be string (got ${describeType(a[k])})`;
        }
    }
    // path/root (optional scalar string)
    for (const k of ['path', 'root']) {
        if (hasOwn(a, k) && !isString(a[k])) {
            return `Error: grep arg "${k}" must be string (got ${describeType(a[k])})`;
        }
        if (hasOwn(a, k) && hasMultipleAbsoluteWindowsPaths(a[k])) {
            return `Error: grep arg "${k}" contains multiple absolute paths in one string. Use one common parent path plus glob, or separate grep calls.`;
        }
    }
    for (const k of ['head_limit', 'offset']) {
        const err = checkIntInRange(a, k, 0, MAX_INT);
        if (err) return err;
    }
    for (const k of ['-A', '-B', '-C', 'context']) {
        if (hasOwn(a, k) && a[k] === '') {
            delete a[k];
            continue;
        }
        const err = checkIntInRange(a, k, 0, GREP_CONTEXT_MAX, { clamp: true });
        if (err) return err;
    }
    // output_mode / mode enum
    const modeKeys = ['output_mode', 'mode'];
    const allowed = new Set(['files_with_matches', 'content', 'content_with_context', 'count']);
    for (const k of modeKeys) {
        if (hasOwn(a, k)) {
            // Some callers concatenate a second field's value onto the enum
            // string with a literal newline (e.g. "content_with_context\ntrue").
            // If the first line/token is a valid enum value, truncate to it
            // losslessly rather than rejecting a shape that unambiguously
            // names a real mode (item 5a).
            if (typeof a[k] === 'string' && a[k].includes('\n')) {
                const firstLine = a[k].split('\n')[0].trim();
                const firstToken = firstLine.split(/\s+/)[0];
                if (allowed.has(firstToken)) a[k] = firstToken;
            }
            if (!isString(a[k]) || !allowed.has(a[k])) {
                return `Error: grep arg "${k}" must be one of content_with_context|content|files_with_matches|count (got ${JSON.stringify(a[k])})`;
            }
        }
    }
    // Context-mode tightening: clamp head_limit (which counts MATCH BLOCKS)
    // harder than the generic caps above, and note the clamp for surfacing.
    // Only applies where the executor actually honors context flags — i.e.
    // content_with_context, or content mode with explicit -A/-B/-C. In
    // files_with_matches/count the context flags are ignored, so head_limit
    // there means output lines/paths, not blocks — never clamp it.
    const grepMode = a.output_mode || a.mode;
    const hasExplicitCtx = ['-A', '-B', '-C', 'context'].some((k) => grepContextKeyPresent(a, k));
    const isCountOrFiles = grepMode === 'files_with_matches' || grepMode === 'count';
    if (!isCountOrFiles && (grepMode == null || grepMode === 'content_with_context' || hasExplicitCtx)) {
        const hl = Number(a.head_limit);
        if (grepContextKeyPresent(a, 'head_limit') && Number.isFinite(hl) && hl > GREP_CTX_HEAD_LIMIT_MAX) {
            a.head_limit = GREP_CTX_HEAD_LIMIT_MAX;
            pushClampNotice(a, `notice: grep limit clamped to ${GREP_CTX_HEAD_LIMIT_MAX} match blocks (context mode)`);
        }
    }
    return null;
}

// Convert a {line, context} pair into {offset, limit}, matching the
// read-args.mjs private file#Lx compatibility normalizer's semantics
// (offset = startLine - 1, limit = endLine - startLine + 1, clamped at 0)
// generalized to a symmetric window: startLine = line - context,
// endLine = line + context. offset/limit are treated as authoritative —
// if either is already present, line/context are dropped unused rather
// than overriding an explicit window. Mutates obj in place. Returns an
// error string or null.
function applyLineContextWindow(obj, labelPrefix) {
    for (const k of ['line', 'context', 'offset', 'limit']) {
        if (isPresent(obj, k) && typeof obj[k] === 'string') {
            const coerced = coerceIntegerString(obj[k]);
            if (coerced !== null) obj[k] = coerced;
        }
    }
    const hasLine = isPresent(obj, 'line');
    const hasContext = isPresent(obj, 'context');
    if (!hasLine && !hasContext) return null;
    if (isPresent(obj, 'offset') || isPresent(obj, 'limit')) {
        delete obj.line;
        delete obj.context;
        return null;
    }
    if (!hasLine) {
        return `Error: read arg "${labelPrefix}context" requires "${labelPrefix}line" to compute a window`;
    }
    if (typeof obj.line === 'string' && RANGE_SHAPED_INT_STRING.test(obj.line.trim())) {
        return `Error: "${labelPrefix}line" takes one integer, not a range "${obj.line}" — use offset+limit (e.g. offset:0, limit:40)`;
    }
    if (!isFiniteInt(obj.line) || obj.line < 1) {
        return `Error: "${labelPrefix}line" must be an integer >= 1 (got ${describeType(obj.line)}) — e.g. line:40`;
    }
    let ctx = 0;
    if (hasContext) {
        if (typeof obj.context === 'string' && RANGE_SHAPED_INT_STRING.test(obj.context.trim())) {
            return `Error: "${labelPrefix}context" takes one integer, not a range "${obj.context}" — e.g. context:5`;
        }
        if (!isFiniteInt(obj.context) || obj.context < 0) {
            return `Error: "${labelPrefix}context" must be an integer >= 0 (got ${describeType(obj.context)}) — e.g. context:5`;
        }
        ctx = obj.context;
    }
    obj.offset = Math.max(0, obj.line - 1 - ctx);
    obj.limit = 2 * ctx + 1;
    delete obj.line;
    delete obj.context;
    return null;
}

// Item 3: an unbounded plain full read (no offset/limit/line/context/mode/n/
// full, and a bare path with no #Lx / :line coordinate) pulls the whole file.
// Inject a default window so large files come back capped with a next-offset
// footer instead. Small files still return in full (limit exceeds line count);
// explicit windows, modes, and line-spec paths are left untouched.
function maybeCapUnboundedRead(a) {
    // Effective path may arrive via the file_path alias; cap those the same way.
    let pathStrs = null;
    if (typeof a.path === 'string' && a.path.trim() !== '') {
        pathStrs = [a.path];
    } else if (typeof a.file_path === 'string' && a.file_path.trim() !== '') {
        pathStrs = [a.file_path];
    } else if (Array.isArray(a.path) && a.path.length > 0
        && a.path.every((e) => typeof e === 'string' && e.trim() !== '')) {
        // string[] batch: read-tool expands top-level limit uniformly onto
        // every entry, so bare-path batches take the same default window.
        // Region-object arrays never reach here (they carry their own
        // windows and are rejected above when mixed with top-level limit).
        pathStrs = a.path;
    }
    if (pathStrs === null) return;
    if (a.full === true) return;
    for (const k of ['offset', 'limit', 'line', 'context', 'n', 'mode', 'pages']) {
        if (isPresent(a, k)) return;
    }
    // Any #Lx / :line coordinate opts the whole call out: the injected limit
    // would override that entry's own line-spec window during per-entry
    // normalization.
    for (const p of pathStrs) {
        if (p.includes('#')) return;
        if (/:\d+(?:-\d+)?\s*$/.test(p)) return;
    }
    a.limit = READ_GUARD_DEFAULT_LIMIT;
    // Marker for the read tool's glob fan-out: this limit is the injected
    // default, not a caller choice, so a multi-file survey may tighten it.
    // Non-enumerable so it never leaks into arg spreads, cache keys, or output.
    try {
        Object.defineProperty(a, '_readLimitDefaulted', {
            value: true, enumerable: false, configurable: true, writable: true,
        });
    } catch { /* best-effort */ }
}

function guardRead(a) {
    // path / file_path alias OR path may itself be array
    const hasPath = hasOwn(a, 'path') || hasOwn(a, 'file_path');
    if (!hasPath) {
        return 'Error: read requires "path" (or alias file_path).';
    }
    // Some providers/models send a batched path array as a JSON string despite
    // the schema (or path:"[]" meaning cwd). The executor coerces via
    // coerceReadFamilyPathArg(); mirror that here so validation does not reject
    // shapes the executor would absorb.
    if (hasOwn(a, 'path')) {
        a.path = coerceReadFamilyPathArg(a.path);
    }
    absorbReadEchoedPathInteger(a, 'offset');
    absorbReadEchoedPathInteger(a, 'limit');
    // Absorb: parallel/JSON-stringified offset+limit arrays paired with a
    // path[] batch — zip them into per-file region objects before validation.
    maybeZipPathWindowArrays(a);
    absorbNegativeReadOffset(a);
    if (Array.isArray(a.path)) {
        for (const entry of a.path) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                absorbNegativeReadOffset(entry);
            }
        }
    }
    // path can be string | string[] | object[]; file_path is string
    if (hasOwn(a, 'path')) {
        const p = a.path;
        const ok = typeof p === 'string' || (Array.isArray(p) && p.length > 0);
        if (!ok) {
            return `Error: read arg "path" must be string, string[], or object[] (got ${describeType(p)})`;
        }
        if (Array.isArray(p)) {
            // Absorb: a region array ({path,offset,limit}[]) carries its window
            // per-entry; a top-level offset/limit becomes the default for any
            // region missing its own window, then the top-level keys are dropped
            // so they don't double-apply in the plain-read checks below.
            const hasRegionObj = p.some((e) => e && typeof e === 'object' && !Array.isArray(e));
            if (hasRegionObj && (isPresent(a, 'offset') || isPresent(a, 'limit'))) {
                for (const e of p) {
                    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
                    if (isPresent(a, 'offset') && !isPresent(e, 'offset')) e.offset = a.offset;
                    if (isPresent(a, 'limit') && !isPresent(e, 'limit')) e.limit = a.limit;
                }
                delete a.offset;
                delete a.limit;
            }
            for (let i = 0; i < p.length; i++) {
                const entry = p[i];
                if (typeof entry === 'string') continue;
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                    return `Error: read arg "path[${i}]" must be string or {path,offset,limit} object (got ${describeType(entry)})`;
                }
                const err = applyLineContextWindow(entry, `path[${i}].`);
                if (err) return err;
                for (const ek of ['offset', 'limit']) {
                    const eErr = checkIntInRange(entry, ek, 0, MAX_INT);
                    if (eErr) return eErr.replace(`"${ek}"`, `"path[${i}].${ek}"`);
                }
            }
        }
    }
    if (hasOwn(a, 'file_path') && !isNonEmptyString(a.file_path)) {
        return `Error: read arg "file_path" must be a non-empty string (got ${describeType(a.file_path)})`;
    }
    // Item 3: cap unbounded full reads to a paging window (after array/region
    // handling so batched region reads are never touched).
    maybeCapUnboundedRead(a);
    // Read's public surface is offset/limit, but a top-level line/context pair
    // is a deterministic, lossless spelling of the same window (matching
    // read-args.mjs's internal file:line normalizer semantics); convert it
    // instead of rejecting. offset/limit, if already present, win outright.
    {
        const err = applyLineContextWindow(a, '');
        if (err) return err;
    }
    // offset >=0
    {
        const err = checkIntInRange(a, 'offset', 0, MAX_INT);
        if (err) return err;
    }
    // limit: >=1 = explicit cap; 0 = unlimited sentinel (read-formatting maps 0 to
    // Infinity; read-batch coalescing forwards limit:0 for an unbounded union
    // window). Allow 0 through rather than erroring — deleting/rejecting it would
    // break that unbounded-batch contract. A placeholder limit:0 from a symbol
    // read is stripped on the symbol path. Negatives still error.
    {
        const err = checkIntInRange(a, 'limit', 0, MAX_INT);
        if (err) return err;
    }
    // n 0..10000 — accept 0 rather than erroring: the read-mode handlers coerce
    // n<1 to their default (head/tail 20, summary 200), and when a window
    // (offset/limit/line) is also present the glance mode is dropped entirely, so
    // n is moot. Rejecting 0 only forced a wasted retry turn (the whole point of
    // these reads is to land in one shot). Negatives remain a real error.
    if (hasOwn(a, 'n') && a.n !== undefined && a.n !== null) {
        const err = checkIntInRange(a, 'n', 0, 10000);
        if (err) return err;
    }
    return null;
}

function guardShell(a) {
    const allowed = new Set(['command', 'timeout_ms']);
    const unsupported = Object.keys(a).find((key) => !allowed.has(key));
    if (unsupported) {
        return `Error: shell arg "${unsupported}" is unsupported; use only command and timeout_ms`;
    }
    if (!hasOwn(a, 'command')) {
        return 'Error: shell requires "command"';
    }
    if (typeof a.command !== 'string') {
        return `Error: shell arg "command" must be a string (got ${describeType(a.command)})`;
    }
    if (a.command.length === 0) {
        return 'Error: shell arg "command" must be a non-empty string';
    }
    if (hasOwn(a, 'timeout_ms') && (typeof a.timeout_ms !== 'number' || !Number.isFinite(a.timeout_ms) || a.timeout_ms < 0)) {
        return `Error: shell arg "timeout_ms" must be a non-negative number (got ${describeType(a.timeout_ms)})`;
    }
    return null;
}

function guardTask(a) {
    const action = typeof a.action === 'string'
        ? a.action.trim().toLowerCase()
        : (hasOwn(a, 'action') ? a.action : '');
    if (!hasOwn(a, 'action')) {
        return 'Error: task requires explicit "action"';
    }
    if (!['list', 'read', 'wait', 'cancel'].includes(action)) {
        return `Error: task arg "action" must be one of list|read|wait|cancel (got ${JSON.stringify(a.action)})`;
    }
    const allowed = new Set(['action', 'task_id', 'timeout_ms']);
    const unsupported = Object.keys(a).find((key) => !allowed.has(key));
    if (unsupported) {
        return `Error: task arg "${unsupported}" is unsupported; use only action, task_id, and timeout_ms`;
    }
    if (action === 'list') {
        return hasOwn(a, 'timeout_ms')
            ? 'Error: task arg "timeout_ms" is only valid for action=wait'
            : null;
    }
    if (!hasOwn(a, 'task_id')) {
        return 'Error: task requires "task_id"';
    }
    if (typeof a.task_id !== 'string' || a.task_id.trim().length === 0) {
        return `Error: task arg "task_id" must be a non-empty string (got ${describeType(a.task_id)})`;
    }
    if (hasOwn(a, 'timeout_ms')) {
        if (action !== 'wait') return 'Error: task arg "timeout_ms" is only valid for action=wait';
        // Out-of-range values are clamped by the wait path, so only a wrong type fails here.
        if (!Number.isInteger(a.timeout_ms) || a.timeout_ms < 0) {
            return `Error: task arg "timeout_ms" must be a non-negative integer (got ${describeType(a.timeout_ms)})`;
        }
    }
    return null;
}

function guardList(a) {
    if (hasOwn(a, 'path') && !isString(a.path)) {
        return `Error: list arg "path" must be string (got ${describeType(a.path)})`;
    }
    if (hasOwn(a, 'path') && a.path.trim().length === 0) {
        return 'Error: list arg "path" must be a non-empty string';
    }
    for (const k of ['hidden', 'meta']) {
        if (hasOwn(a, k) && typeof a[k] !== 'boolean') {
            return `Error: list arg "${k}" must be a boolean (got ${describeType(a[k])})`;
        }
    }
    if (hasOwn(a, 'pattern') && !isStringOrStringArray(a.pattern)) {
        return `Error: list arg "pattern" must be string or string[] (got ${describeType(a.pattern)})`;
    }
    if (hasOwn(a, 'offset') && a.offset !== undefined && a.offset !== null) {
        const coerced = coerceIntegerString(a.offset);
        if (coerced !== null) a.offset = coerced;
        if (!isFiniteInt(a.offset) || a.offset < 0) {
            return `Error: list arg "offset" must be a non-negative integer (got ${describeType(a.offset)})`;
        }
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        const coerced = coerceIntegerString(a.head_limit);
        if (coerced !== null) a.head_limit = coerced;
        if (!isFiniteInt(a.head_limit)) {
            return `Error: list arg "limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        // 0 is the valid "no cap" sentinel; a negative value is nonsensical
        // and downstream produces a degenerate window (clamps to 0 → empty).
        if (a.head_limit < 0) {
            return `Error: list arg "limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
        }
    }
    return null;
}

function guardFind(a) {
    const queryOk = hasOwn(a, 'query') && typeof a.query === 'string' && a.query.trim().length > 0;
    if (!queryOk) {
        return `Error: find requires non-empty string "query" (got ${describeType(a.query)})`;
    }
    if (hasOwn(a, 'path') && !isString(a.path)) {
        return `Error: find arg "path" must be a string (got ${describeType(a.path)})`;
    }
    if (hasOwn(a, 'path') && a.path.trim().length === 0) {
        return 'Error: find arg "path" must be a non-empty string';
    }
    if (hasOwn(a, 'include_noise') && typeof a.include_noise !== 'boolean') {
        return `Error: find arg "include_noise" must be a boolean (got ${describeType(a.include_noise)})`;
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        const coerced = coerceIntegerString(a.head_limit);
        if (coerced !== null) a.head_limit = coerced;
        if (!isFiniteInt(a.head_limit)) {
            return `Error: find arg "limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        if (a.head_limit < 0) {
            return `Error: find arg "limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
        }
    }
    return null;
}

function guardGlob(a) {
    // path alias root; pattern aliases glob/name/file_pattern
    const globPatternKeys = ['pattern', 'glob', 'name', 'file_pattern'];
    for (const k of ['path', 'root']) {
        if (hasOwn(a, k) && !isString(a[k])) {
            return `Error: glob arg "${k}" must be string (got ${describeType(a[k])})`;
        }
        if (hasOwn(a, k) && a[k].trim().length === 0) {
            return `Error: glob arg "${k}" must be a non-empty string`;
        }
    }
    for (const k of globPatternKeys) {
        if (hasOwn(a, k)) a[k] = coercePatternStringValues(a[k]);
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: glob arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
        if (hasOwn(a, k) && typeof a[k] === 'string' && a[k].trim().length === 0) {
            return `Error: glob arg "${k}" must be a non-empty string`;
        }
    }
    const hasAnyPattern = globPatternKeys.some((k) => isNonEmptyPresent(a, k));
    // Skip the default when `path` itself carries glob magic (*?[{) — that
    // shape means "path IS the pattern" and is handled by executeGlobTool's
    // own path-magic fallback (splitting path into baseDir + pattern).
    // Injecting pattern:'*' here would override that fallback and silently
    // change "src/**/*.mjs" into "match everything under src/**/*.mjs".
    const pathHasGlobMagic = hasGlobMagic(a.path);
    if (!hasAnyPattern && isNonEmptyPresent(a, 'path') && !pathHasGlobMagic) {
        // Missing pattern with a real path is an unambiguous "match
        // everything under this path" request; default it instead of
        // erroring out via globMissingPatternMessage() downstream.
        a.pattern = '*';
    }
    if (hasOwn(a, 'sort')) {
        if (!isString(a.sort)) {
            return `Error: glob arg "sort" must be one of natural|mtime (got ${describeType(a.sort)})`;
        }
        a.sort = a.sort.trim();
        if (!['natural', 'mtime'].includes(a.sort)) {
            return `Error: glob arg "sort" must be one of natural|mtime (got ${JSON.stringify(a.sort)})`;
        }
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        const coerced = coerceIntegerString(a.head_limit);
        if (coerced !== null) a.head_limit = coerced;
        if (!isFiniteInt(a.head_limit)) {
            return `Error: glob arg "limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        // 0 is the valid "no cap" sentinel; a negative value is nonsensical
        // and downstream produces a degenerate window (clamps to 0 → empty).
        if (a.head_limit < 0) {
            return `Error: glob arg "limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
        }
    }
    return null;
}

// Valid code_graph modes — mirrors the enum in code-graph-tool-defs.mjs.
// Covers the work the removed standalone find_* tools used to do:
// find_symbol, references, callers, imports, dependents.
const CODE_GRAPH_MODES = new Set([
    'overview', 'imports', 'dependents', 'related', 'impact',
    'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees', 'prewarm',
]);

function guardCodeGraph(a) {
    if (!hasOwn(a, 'mode') || a.mode === undefined || a.mode === null) {
        return 'Error: code_graph requires "mode"';
    }
    if (!isString(a.mode)) {
        return `Error: code_graph arg "mode" must be a string (got ${describeType(a.mode)})`;
    }
    const mode = a.mode.trim();
    if (!CODE_GRAPH_MODES.has(mode)) {
        return `Error: code_graph arg "mode" must be one of ${[...CODE_GRAPH_MODES].join('|')} (got ${JSON.stringify(a.mode)})`;
    }
    // Absorb: file/files arriving as a JSON-stringified array
    // (file:"[\"a.mjs\",\"b.mjs\"]") — parse to a real array so the graph
    // lookup batches per file instead of treating the JSON text as one path.
    for (const k of ['file', 'files']) {
        if (hasOwn(a, k) && typeof a[k] === 'string') {
            const c = coerceShapeFlex(a[k]);
            if (Array.isArray(c)) a[k] = c;
        }
    }
    if (Array.isArray(a.file)) {
        a.files = Array.isArray(a.files) ? [...a.file, ...a.files] : a.file;
        delete a.file;
    }
    if (['overview', 'imports', 'dependents', 'related', 'impact'].includes(mode)) {
        delete a.symbol;
        delete a.symbols;
    }
    return null;
}

const GUARDS = {
    grep: guardGrep,
    read: guardRead,
    shell: guardShell,
    task: guardTask,
    list: guardList,
    find: guardFind,
    glob: guardGlob,
    code_graph: guardCodeGraph,
};

// A bridge/provider can materialize an optional schema field as an explicit
// `undefined`. JSON cannot carry undefined, so it means "not sent" — drop the
// key instead of failing the call on a field the caller never set.
function dropUndefinedArgs(args) {
    for (const key of Object.keys(args)) {
        // `null` gets the same treatment: it is the only way JSON can express
        // "this optional field was not set", and failing the whole call on it
        // was measured as a recurring, fully recoverable tool error.
        if (args[key] === undefined || args[key] === null) delete args[key];
    }
}

// Models/providers can materialize an omitted optional base path as "" or
// whitespace. These tools already define an absent path as the current
// Project, so canonicalize that unambiguous shape instead of failing the call.
// Leave non-string values intact for the per-tool guards to reject.
function normalizeOptionalEmptyPathArgs(toolName, args) {
    const keys = toolName === 'glob' || toolName === 'grep'
        ? ['path', 'root']
        : toolName === 'find' || toolName === 'list'
            ? ['path']
            : [];
    for (const key of keys) {
        if (typeof args[key] === 'string' && args[key].trim().length === 0) {
            delete args[key];
        }
    }
}

// `task` uses one compact schema for four action-specific shapes. Providers
// sometimes fill optional fields that belong to a different action; once the
// explicit action is known, discard those irrelevant defaults before the
// strict per-action guard runs.
function normalizeTaskActionArgs(toolName, args) {
    if (toolName !== 'task') return;
    const action = typeof args.action === 'string'
        ? args.action.trim().toLowerCase()
        : '';
    if (['list', 'read', 'cancel'].includes(action)) {
        delete args.timeout_ms;
    }
    if (action === 'list'
        && typeof args.task_id === 'string'
        && args.task_id.trim().length === 0) {
        delete args.task_id;
    }
}

// Provider-facing built-ins use short keys/enum values to reduce repeated
// tool-call output. Canonicalize them before validation so executors, traces,
// saved calls, and legacy long-form callers keep one stable internal contract.
function normalizeCompactSurfaceArgs(toolName, args) {
    if (['grep', 'glob', 'find', 'list'].includes(toolName)
        && !hasOwn(args, 'head_limit')
        && hasOwn(args, 'limit')) {
        args.head_limit = args.limit;
        delete args.limit;
    }
    if (toolName === 'grep'
        && !hasOwn(args, 'output_mode')
        && typeof args.mode === 'string') {
        const mode = args.mode.trim();
        const canonical = {
            content: 'content_with_context',
            files: 'files_with_matches',
            count: 'count',
        }[mode];
        if (canonical) {
            args.output_mode = canonical;
            delete args.mode;
        }
    }
}

// string | string[] arguments arrive nested ([["a","b"]] from a batching
// wrapper), padded with null/empty entries, or empty. The intent is
// unambiguous, so flatten one level, drop the blanks, and remove a key that
// ends up empty (the tool then uses its default scope) instead of rejecting
// the call.
const STRING_LIST_ARG_KEYS = [
    'path', 'paths', 'root', 'file', 'files',
    'pattern', 'patterns', 'query', 'regex', 'needle',
    'glob', 'file_pattern', 'include', 'type', 'symbols',
];
function normalizeStringListArgs(args, toolName) {
    for (const key of STRING_LIST_ARG_KEYS) {
        if (!hasOwn(args, key) || !Array.isArray(args[key])) continue;
        // read.path may contain compact [path,offset,limit] tuples. Flattening
        // here would destroy their boundaries before guardRead canonicalizes
        // them through coerceReadFamilyPathArg().
        if (toolName === 'read' && key === 'path' && args[key].some(Array.isArray)) continue;
        const source = args[key];
        // Flatten ONE nesting level and drop blank entries; every other entry
        // type is left untouched so the per-tool guards still see (and coerce
        // or reject) it — `read`'s {path,offset,limit}[] regions must survive
        // this pass verbatim.
        const flat = [];
        for (const entry of source.flat(1)) {
            if (entry === null || entry === undefined) continue;
            if (typeof entry === 'string' && entry.trim().length === 0) continue;
            flat.push(entry);
        }
        if (flat.length === source.length && flat.every((entry, idx) => entry === source[idx])) continue;
        if (flat.length === 0) delete args[key];
        else args[key] = flat;
    }
}

export function validateBuiltinArgs(toolName, args) {
    const guard = GUARDS[toolName];
    if (!guard) return null;
    if (args === null || args === undefined) {
        return `Error: ${toolName} requires arguments object (got ${describeType(args)})`;
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
        return `Error: ${toolName} arguments must be an object (got ${describeType(args)})`;
    }
    dropUndefinedArgs(args);
    normalizeOptionalEmptyPathArgs(toolName, args);
    normalizeTaskActionArgs(toolName, args);
    normalizeCompactSurfaceArgs(toolName, args);
    normalizeStringListArgs(args, toolName);
    if (toolName === 'grep') applyGrepContextLeadPolicy(args);
    try {
        return guard(args) || null;
    } catch (err) {
        return `Error: ${toolName} argument validation failed: ${err && err.message ? err.message : String(err)}`;
    }
}

export default validateBuiltinArgs;
