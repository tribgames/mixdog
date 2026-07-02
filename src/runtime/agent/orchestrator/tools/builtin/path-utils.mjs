import { homedir } from 'os';
import { isAbsolute, relative, resolve } from 'path';
import { realpathSync } from 'node:fs';
import { isWSL } from '../../../../shared/wsl.mjs';

// Restore the on-disk casing of a path (win32 only). rg relativizes candidate
// paths against its process cwd with a CASE-SENSITIVE prefix strip before
// matching slash-anchored --glob overrides; a casing mismatch between the
// spawn cwd and the walked root silently defeats every anchored glob.
// realpathSync.native resolves the real casing; non-existent paths (and any
// resolution failure) fall back to the input unchanged.
export function trueCasePath(p) {
    if (process.platform !== 'win32' || typeof p !== 'string' || !p) return p;
    try { return realpathSync.native(p); } catch { return p; }
}

export function posixPathToWindowsPath(posixPath) {
    if (process.platform !== 'win32') return posixPath;
    if (typeof posixPath !== 'string') return posixPath;
    const cyg = posixPath.match(/^\/cygdrive\/([a-zA-Z])\//);
    if (cyg) return `${cyg[1]}:\\${posixPath.slice(11).replace(/\//g, '\\')}`;
    // WSL drive mount: /mnt/c/... → C:\... (Windows drives surface under
    // /mnt/<letter> inside WSL). Mirrors the /cygdrive/ mapping.
    const wsl = posixPath.match(/^\/mnt\/([a-zA-Z])\//);
    if (wsl) return `${wsl[1]}:\\${posixPath.slice(7).replace(/\//g, '\\')}`;
    const m = posixPath.match(/^\/([a-zA-Z])\//);
    if (m) return `${m[1]}:\\${posixPath.slice(3).replace(/\//g, '\\')}`;
    if (posixPath.startsWith('//')) return posixPath.replace(/\//g, '\\');
    return posixPath;
}

// Reverse of posixPathToWindowsPath, for WSL: a Windows-HOST drive path that
// arrives from the host (e.g. `C:\Users\x` or `C:/Users/x`) is unreachable as
// a literal under WSL — the drive surfaces at `/mnt/<letter>/...`. Map
// `<drive>:` → `/mnt/<lowercase-drive>` and flip backslashes to slashes. Only
// drive-letter paths are touched; anything else is returned unchanged.
export function windowsPathToPosixPath(winPath) {
    if (typeof winPath !== 'string') return winPath;
    const m = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
    // Bare `C:` with no separator → drive root.
    const root = winPath.match(/^([a-zA-Z]):$/);
    if (root) return `/mnt/${root[1].toLowerCase()}/`;
    return winPath;
}

export function normalizeInputPath(p) {
    if (typeof p !== 'string') return p;
    // Trim leading/trailing whitespace — LLMs intermittently emit paths with
    // stray spaces inside tool_args, which would otherwise hit ENOENT, force
    // a self-correction turn, and silently invalidate the cache prefix on
    // subsequent iterations (measured as single-iter cold cache misses).
    // Also strip embedded ASCII control chars (\x00-\x1F, \x7F) — interpolation
    // bugs sometimes inject \t/\f/\r/\n mid-path; trim() only touches the ends.
    // Literal SP (0x20) is preserved so paths like "Program Files" still work.
    let out = p.trim().replace(/[\x00-\x1F\x7F]/g, '');
    if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
        out = homedir() + out.slice(1);
    }
    if (process.platform === 'win32') {
        const looksPosixDrive = /^\/[a-zA-Z]\//.test(out);
        const looksCygdrive = /^\/cygdrive\/[a-zA-Z]\//.test(out);
        const looksWsl = /^\/mnt\/[a-zA-Z]\//.test(out);
        const looksUnc = out.startsWith('//');
        if (looksPosixDrive || looksCygdrive || looksWsl || looksUnc) {
            out = posixPathToWindowsPath(out);
        }
    } else if (isWSL()) {
        // Reverse direction: a Windows-style drive path from the host maps to
        // the /mnt/<letter> mount. Native-Linux behavior is untouched (gated
        // on isWSL()); a path already in /mnt/... POSIX form is left as-is.
        if (/^[a-zA-Z]:([\\/]|$)/.test(out)) {
            out = windowsPathToPosixPath(out);
        }
    }
    try { out = out.normalize('NFC'); } catch {}
    return out;
}

export function normalizeSearchPattern(p) {
    if (typeof p !== 'string') return p;
    try { return p.normalize('NFC'); } catch { return p; }
}

// Glob filters fed to ripgrep (`--glob`) use forward slashes as the path
// separator on every platform. A Windows-trained agent naturally writes
// `**\*.ts`, which ripgrep treats as an escape sequence rather than a path
// separator, so the pattern silently matches nothing. Canonicalize `\`→`/`
// so backslash globs match. Gated to win32 only — on POSIX a backslash in a
// glob is a legitimate escape character and must be preserved.
export function canonicalizeGlobSlashes(p) {
    if (typeof p !== 'string') return p;
    if (process.platform !== 'win32') return p;
    return p.replace(/\\/g, '/');
}

function firstPresentArg(args, names) {
    for (const name of names) {
        if (!args || args[name] === undefined || args[name] === null || args[name] === '') continue;
        return args[name];
    }
    return undefined;
}

export function normalizeGrepArgs(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.pattern === undefined || args.pattern === null || args.pattern === '') {
        const alias = firstPresentArg(args, ['query', 'regex', 'regexp', 'needle', 'search', 'literal']);
        if (alias !== undefined) args.pattern = alias;
    }
    if (args.glob === undefined || args.glob === null || args.glob === '') {
        const alias = firstPresentArg(args, ['file_pattern', 'filePattern', 'include', 'includes', 'files']);
        if (alias !== undefined) args.glob = alias;
    }
    if (args.path === undefined || args.path === null || args.path === '') {
        const alias = firstPresentArg(args, ['root', 'directory', 'dir']);
        if (alias !== undefined) args.path = alias;
    }
    if ((args.output_mode === undefined || args.output_mode === null || args.output_mode === '') && typeof args.mode === 'string') {
        const mode = args.mode.trim();
        if (['files_with_matches', 'content', 'count'].includes(mode)) args.output_mode = mode;
    }
    return args;
}

export function normalizeGlobArgs(args) {
    if (!args || typeof args !== 'object') return args;
    if (args.pattern === undefined || args.pattern === null || args.pattern === '') {
        const alias = firstPresentArg(args, ['glob', 'file_pattern', 'filePattern', 'name', 'include', 'includes', 'files']);
        if (alias !== undefined) args.pattern = alias;
    }
    if (args.path === undefined || args.path === null || args.path === '') {
        const alias = firstPresentArg(args, ['root', 'directory', 'dir']);
        if (alias !== undefined) args.path = alias;
    }
    // Internal-only passthrough: `_extraIgnoreDirs` is an array of basenames
    // appended as `!**/<name>/**` ignore globs by executeGlobTool for the
    // duration of one invocation. Not exposed in tools.json. Sanitize to a
    // string[] of non-empty basenames so executeGlobTool can trust it.
    if (args._extraIgnoreDirs !== undefined) {
        const raw = Array.isArray(args._extraIgnoreDirs) ? args._extraIgnoreDirs : [];
        const sanitized = raw
            .filter((n) => typeof n === 'string')
            .map((n) => n.trim())
            .filter((n) => n.length > 0 && !/[\\/]/.test(n));
        args._extraIgnoreDirs = sanitized;
    }
    return args;
}

export function normalizeOutputPath(p) {
    if (typeof p !== 'string') return p;
    if (process.platform !== 'win32') return p;
    return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
}

export function resolveAgainstCwd(filePath, cwd) {
    return resolve(cwd, filePath);
}

export function cwdRelativePath(fullPath, workDir) {
    try {
        const rel = relative(workDir, fullPath);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return fullPath;
        return rel;
    } catch { return fullPath; }
}

export function extractGlobBaseDirectory(pattern) {
    const wildcardIdx = pattern.search(/[\*\?\[\{]/);
    const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
    const lastSep = Math.max(
        staticPrefix.lastIndexOf('/'),
        staticPrefix.lastIndexOf('\\'),
    );
    if (lastSep === -1) return { baseDir: null, relativePattern: pattern };
    let baseDir = staticPrefix.slice(0, lastSep);
    const remainder = pattern.slice(lastSep + 1);
    const relativePattern = remainder.startsWith('/') ? remainder : '/' + remainder;
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(baseDir)) {
        baseDir = baseDir + '\\';
    }
    return { baseDir: baseDir || null, relativePattern };
}

export function hasGlobMagic(value) {
    return typeof value === 'string' && /[\*\?\[\{]/.test(value);
}

export function countSplitLines(text) {
    if (!text) return 0;
    let lines = 1;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
}

export function countDisplayLines(text) {
    if (!text) return 0;
    let lines = text.endsWith('\n') ? 0 : 1;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) lines += 1;
    }
    return lines;
}

export function coerceShapeFlex(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
        } catch {}
    }
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') return parsed;
        } catch {}
    }
    // A single {path,offset,limit}-shaped object JSON string (e.g. a model
    // emitting `path: "{\"path\":\"x\",\"offset\":10}"` instead of a real
    // object) is a lossless single-entry batch. Wrap it in an array so the
    // downstream object-array batch path (read-tool.mjs) picks it up instead
    // of falling through to the plain-string path guard, which would
    // misdetect the raw JSON text as a literal (and often invalid) filename.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && typeof (parsed.path ?? parsed.file_path) === 'string') {
                return [parsed];
            }
        } catch {}
    }
    return value;
}
