import { existsSync } from 'fs';
import { normalizeInputPath, resolveAgainstCwd } from './path-utils.mjs';
import { parseLineLimitArg } from './read-formatting.mjs';

const READ_LINE_CONTEXT_DEFAULT = 20;
const READ_LINE_CONTEXT_MAX = 200;

export function parseReadLineNumberArg(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

export function parseReadLineContextArg(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return READ_LINE_CONTEXT_DEFAULT;
    return Math.min(READ_LINE_CONTEXT_MAX, Math.max(0, Math.trunc(n)));
}

export function parseReadPathLineSpec(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
    const text = rawPath.trim();
    let m = /^(.+?)#L(\d+)(?:-L?(\d+))?(?:\b.*)?$/i.exec(text);
    if (!m) m = /^(.+):(\d+)(?:-(\d+))?(?::.*)?$/.exec(text);
    if (!m) return null;
    const lineNo = parseReadLineNumberArg(m[2]);
    const endLineRaw = parseReadLineNumberArg(m[3]);
    if (!lineNo || !m[1]) return null;
    // Inverted range (e.g. file#L20-L10) is a caller mistake, not a
    // silent fallback to a context window — surface it as an error
    // flag so the read tool can return a structured error.
    const inverted = endLineRaw !== null && endLineRaw < lineNo;
    const endLine = endLineRaw && endLineRaw >= lineNo ? endLineRaw : null;
    return { path: m[1], lineNo, endLine, inverted, invertedEnd: inverted ? endLineRaw : null };
}

export function resolveExistingPathLineCoordinate(rawPath, workDir) {
    const spec = parseReadPathLineSpec(rawPath);
    if (!spec) return null;
    const normalizedRawPath = normalizeInputPath(rawPath);
    const normalizedSpecPath = normalizeInputPath(spec.path);
    const rawFull = resolveAgainstCwd(normalizedRawPath, workDir);
    const specFull = resolveAgainstCwd(normalizedSpecPath, workDir);
    if (existsSync(rawFull) || !existsSync(specFull)) return null;
    return { ...spec, path: normalizedSpecPath };
}

export function normalizePathAndStripLineCoordinate(rawPath, workDir) {
    const resolved = resolveExistingPathLineCoordinate(rawPath, workDir);
    return resolved ? resolved.path : normalizeInputPath(rawPath);
}

export function normaliseReadLineWindowArgs(inputArgs, workDir) {
    const args = { ...inputArgs };
    let lineNo = parseReadLineNumberArg(args.line);
    let pathLineRange = null;
    if (typeof args.path === 'string' && args.path) {
        const spec = resolveExistingPathLineCoordinate(args.path, workDir);
        if (spec) {
            if (spec.inverted) {
                args._invertedRangeError = `Error: inverted range in path "${inputArgs.path}" — end (${spec.invertedEnd}) precedes start (${spec.lineNo}); use file:${spec.invertedEnd}-${spec.lineNo} or remove the range`;
                return args;
            }
            args.path = spec.path;
            if (!lineNo) lineNo = spec.lineNo;
            if (spec.endLine) pathLineRange = { startLine: spec.lineNo, endLine: spec.endLine };
        }
    }
    const isFullMode = !args.mode || args.mode === 'full';
    // line= and offset= are ALTERNATIVE window anchors. Prefer an explicit line
    // anchor and drop stale paging fields instead of failing the tool call: LLM
    // callers commonly carry optional offset/limit defaults from a previous
    // shape. When context is explicit, limit is part of the stale paging family
    // too; otherwise line+limit remains a supported "start at line, cap rows"
    // shorthand below.
    if (isFullMode && lineNo && args.context !== undefined && args.context !== null) {
        delete args.offset;
        delete args.limit;
    } else if (isFullMode && lineNo && args.offset !== undefined && args.offset !== null) {
        delete args.offset;
    }
    if (isFullMode && lineNo) {
        if (pathLineRange && args.context === undefined && (args.limit === undefined || args.limit === null)) {
            args.offset = Math.max(0, pathLineRange.startLine - 1);
            args.limit = Math.max(1, pathLineRange.endLine - pathLineRange.startLine + 1);
        } else {
            const contextExplicit = args.context !== undefined && args.context !== null;
            const limitExplicit = args.limit !== undefined && args.limit !== null;
            const context = parseReadLineContextArg(args.context);
            if (limitExplicit && !contextExplicit) {
                // Explicit limit, no explicit context: anchor the window AT the
                // requested line so it is always included. (Was: offset centered
                // by the default context, which a small limit then truncated to
                // exclude the very line the caller asked for.)
                args.offset = Math.max(0, lineNo - 1);
                args.limit = parseLineLimitArg(args.limit, (context * 2) + 1);
            } else {
                const limit = limitExplicit
                    ? parseLineLimitArg(args.limit, (context * 2) + 1)
                    : (context * 2) + 1;
                args.offset = Math.max(0, lineNo - context - 1);
                args.limit = limit;
            }
        }
        delete args.line;
        delete args.context;
    }
    return args;
}
