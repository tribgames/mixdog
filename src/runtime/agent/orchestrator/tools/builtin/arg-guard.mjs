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

import { coerceShapeFlex, hasGlobMagic } from './path-utils.mjs';

const MAX_INT = 100000;
// Explicit grep context should be large enough to frame a function/block without
// letting one match explode into a huge tool result. `content_with_context` still
// defaults to 25 lines; this is only the upper bound for caller-supplied -A/-B/-C.
export const GREP_CONTEXT_MAX = 200;

// ripgrep-flavored aliases: models trained on `rg` emit short flags (-A/-B/-C),
// long flags (--after-context / --before-context / --context), or snake/camel
// spellings. All fold onto the canonical -A/-B/-C so a caller can write grep
// the way they would write ripgrep on the shell.
const GREP_CONTEXT_KEY_GROUPS = [
    ['-A', ['-A', 'A', 'after', 'after_context', 'afterContext', '--after-context', 'after-context', 'afterLines', 'after_lines']],
    ['-B', ['-B', 'B', 'before', 'before_context', 'beforeContext', '--before-context', 'before-context', 'beforeLines', 'before_lines']],
    ['-C', ['-C', 'C', 'context', 'context_lines', 'contextLines', '--context', 'contextN', 'around', 'surrounding']],
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
    for (const [canonical, keys] of GREP_CONTEXT_KEY_GROUPS) {
        const found = firstNonZeroGrepContextArg(args, keys) || firstGrepContextArg(args, keys);
        if (!found) continue;
        const n = Number(found.value);
        const shaped = Number.isFinite(n) && n > GREP_CONTEXT_MAX ? GREP_CONTEXT_MAX : found.value;
        clearGrepContextKeys(args, keys);
        args[canonical] = shaped;
    }
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

function hasUnsupportedRipgrepRegex(value) {
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

// Mutates a[field] in place when it is a lossless integer string, then
// validates the (possibly coerced) value against [min, max].
function checkIntInRange(a, field, min, max) {
    let value = a[field];
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') {
        const coerced = coerceIntegerString(value);
        if (coerced !== null) {
            value = coerced;
            a[field] = coerced;
        }
    }
    if (!isFiniteInt(value)) {
        return `Error: builtin arg "${field}" must be a finite integer (got ${describeType(value)})`;
    }
    if (value < min) {
        return `Error: builtin arg "${field}" must be >= ${min} (got ${value})`;
    }
    if (value > max) {
        return `Error: builtin arg "${field}" must be <= ${max} (got ${value})`;
    }
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

// ---- per-tool guards ----

function guardGrep(a) {
    // pattern aliases
    const patternKeys = ['pattern', 'query', 'regex', 'needle'];
    // glob (file filter) aliases
    const globKeys = ['glob', 'file_pattern', 'include', 'files'];

    // Lossless cleanup of trailing artifacts before validation (item 5b).
    for (const k of patternKeys) {
        if (hasOwn(a, k)) {
            a[k] = Array.isArray(a[k])
                ? a[k].map(stripTrailingPatternArtifacts)
                : stripTrailingPatternArtifacts(a[k]);
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
        if (hasOwn(a, k) && hasUnsupportedRipgrepRegex(a[k])) {
            return `Error: grep arg "${k}" uses regex syntax ripgrep does not support here (lookaround/backrefs). Use plain pattern arrays or simpler regex.`;
        }
    }
    for (const k of globKeys) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: grep arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
    }
    // path/root (optional, string or string[])
    for (const k of ['path', 'root']) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: grep arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
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
        const err = checkIntInRange(a, k, 0, GREP_CONTEXT_MAX);
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
    if (!isFiniteInt(obj.line) || obj.line < 1) {
        return `Error: read arg "${labelPrefix}line" must be a finite integer >= 1 (got ${describeType(obj.line)})`;
    }
    let ctx = 0;
    if (hasContext) {
        if (!isFiniteInt(obj.context) || obj.context < 0) {
            return `Error: read arg "${labelPrefix}context" must be a non-negative finite integer (got ${describeType(obj.context)})`;
        }
        ctx = obj.context;
    }
    obj.offset = Math.max(0, obj.line - 1 - ctx);
    obj.limit = 2 * ctx + 1;
    delete obj.line;
    delete obj.context;
    return null;
}

function guardRead(a) {
    // path / file_path alias OR path may itself be array
    const hasPath = hasOwn(a, 'path') || hasOwn(a, 'file_path');
    if (!hasPath) {
        return 'Error: read requires "path" (or alias file_path).';
    }
    // Some providers/models send a batched path array as a JSON string despite
    // the schema. The executor already accepts that shape via coerceShapeFlex(),
    // but validation runs first; apply the same lossless shape coercion here so
    // valid batched reads do not waste a retry turn.
    if (hasOwn(a, 'path')) {
        a.path = coerceShapeFlex(a.path);
    }
    // path can be string | string[] | object[]; file_path is string
    if (hasOwn(a, 'path')) {
        const p = a.path;
        const ok = typeof p === 'string' || (Array.isArray(p) && p.length > 0);
        if (!ok) {
            return `Error: read arg "path" must be string, string[], or object[] (got ${describeType(p)})`;
        }
        if (Array.isArray(p)) {
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

function guardDiagnostics(a) {
    if (hasOwn(a, 'path') && a.path !== undefined && a.path !== null && !isNonEmptyString(a.path)) {
        return `Error: diagnostics arg "path" must be a non-empty string (got ${describeType(a.path)})`;
    }
    return null;
}

function guardShell(a) {
    if (!hasOwn(a, 'command')) {
        return 'Error: shell requires "command"';
    }
    if (typeof a.command !== 'string') {
        return `Error: shell arg "command" must be a string (got ${describeType(a.command)})`;
    }
    if (a.command.length === 0) {
        return 'Error: shell arg "command" must be a non-empty string';
    }
    if (process.platform === 'win32' && !hasOwn(a, 'shell') && hasWindowsDrivePath(a.command)) {
        // A Windows drive path (C:\...) is unambiguous evidence the caller
        // wants the Windows shell; default it losslessly instead of forcing
        // a retry turn just to add shell:'powershell'.
        a.shell = 'powershell';
    }
    for (const k of ['cwd', 'workdir']) {
        if (hasOwn(a, k) && (a[k] === undefined || a[k] === null || a[k] === '')) {
            delete a[k];
            continue;
        }
        if (hasOwn(a, k) && !isNonEmptyString(a[k])) {
            return `Error: shell arg "${k}" must be a non-empty string (got ${describeType(a[k])})`;
        }
    }
    if (hasOwn(a, 'cwd') && hasOwn(a, 'workdir') && a.cwd !== a.workdir) {
        return 'Error: shell args "cwd" and "workdir" conflict; use one working directory.';
    }
    if (hasOwn(a, 'shell') && a.shell !== undefined && a.shell !== null && a.shell !== 'bash' && a.shell !== 'powershell') {
        return `Error: shell arg "shell" must be bash or powershell (got ${JSON.stringify(a.shell)})`;
    }
    return null;
}

function guardTask(a) {
    const action = typeof a.action === 'string' ? a.action.trim().toLowerCase() : (hasOwn(a, 'action') ? a.action : '');
    if (hasOwn(a, 'action') && !['list', 'status', 'read', 'wait', 'cancel'].includes(action)) {
        return `Error: task arg "action" must be one of list|status|read|wait|cancel (got ${JSON.stringify(a.action)})`;
    }
    if (action === 'list') return null;
    if (!hasOwn(a, 'task_id')) {
        return 'Error: task requires "task_id"';
    }
    if (typeof a.task_id !== 'string' || a.task_id.trim().length === 0) {
        return `Error: task arg "task_id" must be a non-empty string (got ${describeType(a.task_id)})`;
    }
    return null;
}

function guardList(a) {
    if (hasOwn(a, 'path') && !isStringOrStringArray(a.path)) {
        return `Error: list arg "path" must be string or string[] (got ${describeType(a.path)})`;
    }
    if (hasOwn(a, 'pattern') && !isStringOrStringArray(a.pattern)) {
        return `Error: list arg "pattern" must be string or string[] (got ${describeType(a.pattern)})`;
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        if (!isFiniteInt(a.head_limit)) {
            return `Error: list arg "head_limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        // 0 is the valid "no cap" sentinel; a negative value is nonsensical
        // and downstream produces a degenerate window (clamps to 0 → empty).
        if (a.head_limit < 0) {
            return `Error: list arg "head_limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
        }
    }
    return null;
}

function guardFind(a) {
    // query accepts string or string[] (query[] fans out per-lookup downstream).
    const queryOk = hasOwn(a, 'query') && (
        (typeof a.query === 'string' && a.query.trim().length > 0)
        || (Array.isArray(a.query) && a.query.length > 0 && a.query.every((q) => typeof q === 'string' && q.trim().length > 0))
    );
    if (!queryOk) {
        return `Error: find requires non-empty string (or string[]) "query" (got ${describeType(a.query)})`;
    }
    if (hasOwn(a, 'path') && !isString(a.path)) {
        return `Error: find arg "path" must be a string (got ${describeType(a.path)})`;
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        if (!isFiniteInt(a.head_limit)) {
            return `Error: find arg "head_limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        if (a.head_limit < 0) {
            return `Error: find arg "head_limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
        }
    }
    return null;
}

function guardGlob(a) {
    // path alias root; pattern aliases glob/name/file_pattern
    const globPatternKeys = ['pattern', 'glob', 'name', 'file_pattern'];
    const hasAnyPattern = globPatternKeys.some((k) => isNonEmptyPresent(a, k));
    // Skip the default when `path` itself carries glob magic (*?[{) — that
    // shape means "path IS the pattern" and is handled by executeGlobTool's
    // own path-magic fallback (splitting path into baseDir + pattern).
    // Injecting pattern:'*' here would override that fallback and silently
    // change "src/**/*.mjs" into "match everything under src/**/*.mjs".
    const pathHasGlobMagic = Array.isArray(a.path)
        ? a.path.some((p) => hasGlobMagic(p))
        : hasGlobMagic(a.path);
    if (!hasAnyPattern && isNonEmptyPresent(a, 'path') && !pathHasGlobMagic) {
        // Missing pattern with a real path is an unambiguous "match
        // everything under this path" request; default it instead of
        // erroring out via globMissingPatternMessage() downstream.
        a.pattern = '*';
    }
    for (const k of ['path', 'root']) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: glob arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
    }
    for (const k of globPatternKeys) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: glob arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
    }
    if (hasOwn(a, 'head_limit') && a.head_limit !== undefined && a.head_limit !== null) {
        if (!isFiniteInt(a.head_limit)) {
            return `Error: glob arg "head_limit" must be a finite integer (got ${describeType(a.head_limit)})`;
        }
        // 0 is the valid "no cap" sentinel; a negative value is nonsensical
        // and downstream produces a degenerate window (clamps to 0 → empty).
        if (a.head_limit < 0) {
            return `Error: glob arg "head_limit" must be >= 0 (0 means no cap); got ${a.head_limit}`;
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
    return null;
}

const GUARDS = {
    grep: guardGrep,
    read: guardRead,
    diagnostics: guardDiagnostics,
    shell: guardShell,
    task: guardTask,
    list: guardList,
    find: guardFind,
    glob: guardGlob,
    code_graph: guardCodeGraph,
};

export function validateBuiltinArgs(toolName, args) {
    const guard = GUARDS[toolName];
    if (!guard) return null;
    if (args === null || args === undefined) {
        return `Error: ${toolName} requires arguments object (got ${describeType(args)})`;
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
        return `Error: ${toolName} arguments must be an object (got ${describeType(args)})`;
    }
    if (toolName === 'grep') applyGrepContextLeadPolicy(args);
    try {
        return guard(args) || null;
    } catch (err) {
        return `Error: ${toolName} argument validation failed: ${err && err.message ? err.message : String(err)}`;
    }
}

export default validateBuiltinArgs;
