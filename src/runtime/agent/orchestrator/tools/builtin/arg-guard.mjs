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

const MAX_INT = 100000;
export const GREP_CONTEXT_MAX = 12;

const GREP_CONTEXT_KEY_GROUPS = [
    ['-A', ['-A', 'A', 'after', 'after_context', 'afterContext']],
    ['-B', ['-B', 'B', 'before', 'before_context', 'beforeContext']],
    ['-C', ['-C', 'C', 'context', 'context_lines', 'contextLines']],
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

function hasMeaningfulWriteSingle(a) {
    return (isNonEmptyString(a?.path) || isNonEmptyString(a?.file_path))
        && hasOwn(a, 'content')
        && typeof a.content === 'string';
}

function isInertWriteEntry(w) {
    return w && typeof w === 'object'
        && !isNonEmptyString(w.path)
        && !isNonEmptyString(w.file_path)
        && (!hasOwn(w, 'content') || w.content === '');
}

function hasMeaningfulEditSingle(a) {
    return hasOwn(a, 'old_string')
        && hasOwn(a, 'new_string')
        && isNonEmptyString(a.old_string)
        && typeof a.new_string === 'string';
}

function isInertEditEntry(e) {
    return e && typeof e === 'object'
        && !isNonEmptyString(e.path)
        && !isNonEmptyString(e.file_path)
        && (!hasOwn(e, 'old_string') || e.old_string === '')
        && (!hasOwn(e, 'new_string') || e.new_string === '')
        && (!hasOwn(e, 'replace_all') || e.replace_all === false || e.replace_all === null || e.replace_all === undefined);
}

function isStringOrStringArray(v) {
    if (typeof v === 'string') return true;
    if (!Array.isArray(v) || v.length === 0) return false;
    for (const x of v) {
        if (typeof x !== 'string') return false;
    }
    return true;
}

function hasBackslashPipe(value) {
    if (typeof value === 'string') return false;
    return false;
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

function checkIntInRange(field, value, min, max) {
    if (value === undefined || value === null) return null;
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

// ---- per-tool guards ----

function guardGrep(a) {
    // pattern aliases
    const patternKeys = ['pattern', 'query', 'regex', 'needle'];
    // glob (file filter) aliases
    const globKeys = ['glob', 'file_pattern', 'include', 'files'];

    const hasPattern = patternKeys.some((k) => hasOwn(a, k));
    const hasGlob = globKeys.some((k) => hasOwn(a, k));
    if (!hasPattern && !hasGlob) {
        return 'Error: grep requires pattern (or alias query/regex/needle) or glob.';
    }
    for (const k of patternKeys) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: grep arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
        if (hasOwn(a, k) && hasBackslashPipe(a[k])) {
            return `Error: grep arg "${k}" contains \\|. Use pattern:["a","b"] for OR terms, or unescaped | for regex alternation.`;
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
    // numeric clamps (grep context 0..12, mirrors read line-context tightening)
    for (const k of ['head_limit', 'offset']) {
        const err = checkIntInRange(k, a[k], 0, MAX_INT);
        if (err) return err;
    }
    for (const k of ['-A', '-B', '-C', 'context']) {
        const err = checkIntInRange(k, a[k], 0, GREP_CONTEXT_MAX);
        if (err) return err;
    }
    // output_mode / mode enum
    const modeKeys = ['output_mode', 'mode'];
    const allowed = new Set(['files_with_matches', 'content', 'count']);
    for (const k of modeKeys) {
        if (hasOwn(a, k)) {
            if (!isString(a[k]) || !allowed.has(a[k])) {
                return `Error: grep arg "${k}" must be one of files_with_matches|content|count (got ${JSON.stringify(a[k])})`;
            }
        }
    }
    return null;
}

function guardRead(a) {
    // path / file_path alias OR path may itself be array
    const hasPath = hasOwn(a, 'path') || hasOwn(a, 'file_path');
    if (!hasPath) {
        return 'Error: read requires "path" (or alias file_path).';
    }
    // path can be string | string[] | object[]; file_path is string
    if (hasOwn(a, 'path')) {
        const p = a.path;
        const ok = typeof p === 'string' || (Array.isArray(p) && p.length > 0);
        if (!ok) {
            return `Error: read arg "path" must be string, string[], or object[] (got ${describeType(p)})`;
        }
    }
    if (hasOwn(a, 'file_path') && !isNonEmptyString(a.file_path)) {
        return `Error: read arg "file_path" must be a non-empty string (got ${describeType(a.file_path)})`;
    }
    if (hasOwn(a, 'line') && (hasOwn(a, 'offset') || hasOwn(a, 'limit'))) {
        return 'Error: read window args conflict — use exactly one window family: line+context OR offset+limit OR symbol.';
    }
    // offset >=0
    {
        const err = checkIntInRange('offset', a.offset, 0, MAX_INT);
        if (err) return err;
    }
    // limit: >=1 = explicit cap; 0 = unlimited sentinel (read-formatting maps 0 to
    // Infinity; read-batch coalescing forwards limit:0 for an unbounded union
    // window). Allow 0 through rather than erroring — deleting/rejecting it would
    // break that unbounded-batch contract. A placeholder limit:0 from a symbol
    // read is stripped on the symbol path. Negatives still error.
    {
        const err = checkIntInRange('limit', a.limit, 0, MAX_INT);
        if (err) return err;
    }
    // context 0..200
    {
        const err = checkIntInRange('context', a.context, 0, 200);
        if (err) return err;
    }
    // n 0..10000 — accept 0 rather than erroring: the read-mode handlers coerce
    // n<1 to their default (head/tail 20, summary 200), and when a window
    // (offset/limit/line) is also present the glance mode is dropped entirely, so
    // n is moot. Rejecting 0 only forced a wasted retry turn (the whole point of
    // these reads is to land in one shot). Negatives remain a real error.
    if (hasOwn(a, 'n') && a.n !== undefined && a.n !== null) {
        const err = checkIntInRange('n', a.n, 0, 10000);
        if (err) return err;
    }
    return null;
}

function guardEdit(a) {
    const op = hasOwn(a, 'operation') ? a.operation : 'replace';
    if (op !== undefined && op !== null) {
        if (!isString(op) || (op !== 'replace' && op !== 'notebook' && op !== 'rename')) {
            return `Error: edit arg "operation" must be one of replace|notebook|rename (got ${JSON.stringify(op)})`;
        }
    }
    if (op === 'notebook') {
        return guardNotebookEdit(a);
    }
    if (op === 'rename') {
        return guardRename(a);
    }
    if (Array.isArray(a.edits)) {
        a.edits = a.edits.filter((e) => !isInertEditEntry(e));
    }
    let hasSingle = hasMeaningfulEditSingle(a);
    const hasBatch = Array.isArray(a.edits) && a.edits.length > 0;
    if (hasSingle && hasBatch) {
        return 'Error: edit requires either single old_string/new_string OR edits[], not both';
    }
    if (!hasSingle && !hasBatch) {
        if (hasOwn(a, 'edits') && !hasBatch) {
            return 'Error: edit arg "edits" must be a non-empty array';
        }
        return 'Error: edit requires either (old_string + new_string) OR a non-empty edits[]';
    }
    if (hasSingle) {
        if (typeof a.old_string !== 'string') {
            return `Error: edit arg "old_string" must be a string (got ${describeType(a.old_string)})`;
        }
        if (a.old_string.length === 0) {
            return 'Error: edit arg "old_string" must be non-empty';
        }
        if (typeof a.new_string !== 'string') {
            return `Error: edit arg "new_string" must be a string (got ${describeType(a.new_string)})`;
        }
    }
    if (hasBatch) {
        for (let i = 0; i < a.edits.length; i++) {
            const e = a.edits[i];
            if (!e || typeof e !== 'object') {
                return `Error: edit edits[${i}] must be an object with old_string + new_string`;
            }
            if (typeof e.old_string !== 'string') {
                return `Error: edit edits[${i}].old_string must be a string (got ${describeType(e.old_string)})`;
            }
            if (e.old_string.length === 0) {
                return `Error: edit edits[${i}].old_string must be non-empty`;
            }
            if (typeof e.new_string !== 'string') {
                return `Error: edit edits[${i}].new_string must be a string (got ${describeType(e.new_string)})`;
            }
        }
    }
    return null;
}

function guardWrite(a) {
    if (Array.isArray(a.writes)) {
        a.writes = a.writes.filter((w) => !isInertWriteEntry(w));
    }
    const hasSingle = hasMeaningfulWriteSingle(a);
    const hasBatch = Array.isArray(a.writes) && a.writes.length > 0;
    if (hasSingle && hasBatch) {
        return 'Error: write requires either (path + content) OR writes[], not both';
    }
    if (!hasSingle && !hasBatch) {
        if (hasOwn(a, 'writes') && !hasBatch) {
            return 'Error: write arg "writes" must be a non-empty array';
        }
        return 'Error: write requires either (path + content) OR a non-empty writes[]';
    }
    if (hasSingle) {
        const p = hasOwn(a, 'path') ? a.path : a.file_path;
        if (typeof p !== 'string' || !p) {
            return `Error: write arg "path" must be a non-empty string (got ${describeType(p)})`;
        }
        if (typeof a.content !== 'string') {
            return `Error: write arg "content" must be a string (got ${describeType(a.content)})`;
        }
    }
    if (hasBatch) {
        for (let i = 0; i < a.writes.length; i++) {
            const w = a.writes[i];
            if (!w || typeof w !== 'object') {
                return `Error: write writes[${i}] must be an object with path + content`;
            }
            const p = hasOwn(w, 'path') ? w.path : w.file_path;
            if (typeof p !== 'string' || !p) {
                return `Error: write writes[${i}].path must be a non-empty string (got ${describeType(p)})`;
            }
            if (typeof w.content !== 'string') {
                return `Error: write writes[${i}].content must be a string (got ${describeType(w.content)})`;
            }
        }
    }
    return null;
}

function guardNotebookEdit(a) {
    const hasPath = hasOwn(a, 'notebook_path') || hasOwn(a, 'path') || hasOwn(a, 'file_path');
    if (!hasPath) {
        return 'Error: notebook_edit requires "notebook_path" (or alias path/file_path).';
    }
    for (const k of ['notebook_path', 'path', 'file_path']) {
        if (hasOwn(a, k) && !isNonEmptyString(a[k])) {
            return `Error: notebook_edit arg "${k}" must be a non-empty string (got ${describeType(a[k])})`;
        }
    }
    const editMode = hasOwn(a, 'edit_mode') ? a.edit_mode : 'replace';
    if (editMode !== undefined && editMode !== null) {
        const allowedModes = new Set(['replace', 'insert', 'delete']);
        if (!isString(editMode) || !allowedModes.has(editMode)) {
            return `Error: notebook_edit arg "edit_mode" must be one of replace|insert|delete (got ${JSON.stringify(editMode)})`;
        }
    }
    if (hasOwn(a, 'cell_type') && a.cell_type !== undefined && a.cell_type !== null) {
        if (!isString(a.cell_type) || (a.cell_type !== 'code' && a.cell_type !== 'markdown')) {
            return `Error: notebook_edit arg "cell_type" must be code or markdown (got ${JSON.stringify(a.cell_type)})`;
        }
    }
    if (hasOwn(a, 'cell_id') && a.cell_id !== undefined && a.cell_id !== null && !isString(a.cell_id)) {
        return `Error: notebook_edit arg "cell_id" must be a string (got ${describeType(a.cell_id)})`;
    }
    // new_source is required except for delete; the executor enforces the
    // mode-specific requirement, but reject a non-string up front when present.
    if (hasOwn(a, 'new_source') && a.new_source !== undefined && a.new_source !== null && typeof a.new_source !== 'string') {
        return `Error: notebook_edit arg "new_source" must be a string (got ${describeType(a.new_source)})`;
    }
    return null;
}

function guardDiagnostics(a) {
    if (hasOwn(a, 'path') && a.path !== undefined && a.path !== null && !isNonEmptyString(a.path)) {
        return `Error: diagnostics arg "path" must be a non-empty string (got ${describeType(a.path)})`;
    }
    return null;
}

function guardRename(a) {
    if (!hasOwn(a, 'symbol') || !isNonEmptyString(a.symbol)) {
        return `Error: rename requires "symbol" (non-empty string) (got ${describeType(a.symbol)})`;
    }
    if (!hasOwn(a, 'new_name') || !isNonEmptyString(a.new_name)) {
        return `Error: rename requires "new_name" (non-empty string) (got ${describeType(a.new_name)})`;
    }
    if (hasOwn(a, 'file') && a.file !== undefined && a.file !== null && !isNonEmptyString(a.file)) {
        return `Error: rename arg "file" must be a non-empty string (got ${describeType(a.file)})`;
    }
    if (hasOwn(a, 'apply') && a.apply !== undefined && a.apply !== null && typeof a.apply !== 'boolean') {
        return `Error: rename arg "apply" must be a boolean (got ${describeType(a.apply)})`;
    }
    return null;
}

function guardBash(a) {
    if (!hasOwn(a, 'command')) {
        return 'Error: bash requires "command"';
    }
    if (typeof a.command !== 'string') {
        return `Error: bash arg "command" must be a string (got ${describeType(a.command)})`;
    }
    if (a.command.length === 0) {
        return 'Error: bash arg "command" must be a non-empty string';
    }
    if (process.platform === 'win32' && !hasOwn(a, 'shell') && hasWindowsDrivePath(a.command)) {
        return "Error: bash command contains a Windows drive path; set shell:'powershell' or convert paths for shell:'bash'.";
    }
    for (const k of ['cwd', 'workdir']) {
        if (hasOwn(a, k) && (a[k] === undefined || a[k] === null || a[k] === '')) {
            delete a[k];
            continue;
        }
        if (hasOwn(a, k) && !isNonEmptyString(a[k])) {
            return `Error: bash arg "${k}" must be a non-empty string (got ${describeType(a[k])})`;
        }
    }
    if (hasOwn(a, 'cwd') && hasOwn(a, 'workdir') && a.cwd !== a.workdir) {
        return 'Error: bash args "cwd" and "workdir" conflict; use one working directory.';
    }
    if (hasOwn(a, 'shell') && a.shell !== undefined && a.shell !== null && a.shell !== 'bash' && a.shell !== 'powershell') {
        return `Error: bash arg "shell" must be bash or powershell (got ${JSON.stringify(a.shell)})`;
    }
    return null;
}

function guardJobWait(a) {
    if (!hasOwn(a, 'job_id')) {
        return 'Error: job_wait requires "job_id"';
    }
    if (typeof a.job_id !== 'string') {
        return `Error: job_wait arg "job_id" must be a string (got ${describeType(a.job_id)})`;
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

function guardGlob(a) {
    // path alias root; pattern aliases glob/name/file_pattern
    for (const k of ['path', 'root']) {
        if (hasOwn(a, k) && !isStringOrStringArray(a[k])) {
            return `Error: glob arg "${k}" must be string or string[] (got ${describeType(a[k])})`;
        }
    }
    for (const k of ['pattern', 'glob', 'name', 'file_pattern']) {
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
    'symbols', 'find_symbol', 'search', 'references', 'callers', 'callees', 'prewarm',
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
    edit: guardEdit,
    write: guardWrite,
    diagnostics: guardDiagnostics,
    bash: guardBash,
    job_wait: guardJobWait,
    list: guardList,
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
