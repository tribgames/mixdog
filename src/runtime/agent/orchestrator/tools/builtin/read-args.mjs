import { existsSync } from 'fs';
import { normalizeInputPath, resolveAgainstCwd } from './path-utils.mjs';

export function parseReadLineNumberArg(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseReadPathLineSpec(rawPath) {
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

function resolveExistingPathLineCoordinate(rawPath, workDir) {
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
    let pathLineRange = null;
    if (typeof args.path === 'string' && args.path) {
        const spec = resolveExistingPathLineCoordinate(args.path, workDir);
        if (spec) {
            if (spec.inverted) {
                args._invertedRangeError = `Error: inverted range in path "${inputArgs.path}" — end (${spec.invertedEnd}) precedes start (${spec.lineNo}); use file:${spec.invertedEnd}-${spec.lineNo} or remove the range`;
                return args;
            }
            args.path = spec.path;
            if (spec.endLine) pathLineRange = { startLine: spec.lineNo, endLine: spec.endLine };
            else pathLineRange = { startLine: spec.lineNo, endLine: spec.lineNo };
        }
    }
    const isFullMode = !args.mode || args.mode === 'full';
    // Public Read args are offset/limit only. Keep a narrow private
    // compatibility path for file#Lx/file:line strings by converting them into
    // offset/limit; do not interpret line/context fields here.
    if (isFullMode && pathLineRange && args.offset === undefined) {
        args.offset = Math.max(0, pathLineRange.startLine - 1);
        if (args.limit === undefined) {
            args.limit = Math.max(1, pathLineRange.endLine - pathLineRange.startLine + 1);
        }
    }
    delete args.line;
    delete args.context;
    return args;
}
