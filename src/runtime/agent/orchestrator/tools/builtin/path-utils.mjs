import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { isWSL } from '../../../../shared/wsl.mjs';

// Restore the on-disk casing of a path (win32 only). rg relativizes candidate
// paths against its process cwd with a CASE-SENSITIVE prefix strip before
// matching slash-anchored --glob overrides; a casing mismatch between the
// spawn cwd and the walked root silently defeats every anchored glob.
// realpathSync.native resolves the real casing; non-existent paths (and any
// resolution failure) fall back to the input unchanged.
export async function trueCasePath(p) {
  if (process.platform !== 'win32' || typeof p !== 'string' || !p) return p;
  try {
    return await realpath(p);
  } catch {
    return p;
  }
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
function windowsPathToPosixPath(winPath) {
  if (typeof winPath !== 'string') return winPath;
  const m = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  // Bare `C:` with no separator → drive root.
  const root = winPath.match(/^([a-zA-Z]):$/);
  if (root) return `/mnt/${root[1].toLowerCase()}/`;
  return winPath;
}

// http(s):// URLs are not file paths; the generic path guards would reject
// them with a misleading ADS/trailing-dot message. Returns an error message or null.
export function urlAsPathMessage(p) {
  if (typeof p !== 'string' || !/^\s*https?:\/\//i.test(p)) return null;
  return 'this is a URL; use web_fetch';
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
    } else if (/^\/[a-zA-Z]:[\\/]/.test(out)) {
      // `/C:/x/y` or `/C:\x\y`: a stray leading slash before a drive letter.
      // Left as-is, the guard reads `C:` as a component carrying an NTFS ADS colon.
      out = `${out[1]}:\\${out.slice(4).replace(/\//g, '\\')}`;
    }
  } else if (isWSL()) {
    // Reverse direction: a Windows-style drive path from the host maps to
    // the /mnt/<letter> mount. Native-Linux behavior is untouched (gated
    // on isWSL()); a path already in /mnt/... POSIX form is left as-is.
    if (/^[a-zA-Z]:([\\/]|$)/.test(out)) {
      out = windowsPathToPosixPath(out);
    }
  }
  try {
    out = out.normalize('NFC');
  } catch {}
  return out;
}

export function normalizeSearchPattern(p) {
  if (typeof p !== 'string') return p;
  try {
    return p.normalize('NFC');
  } catch {
    return p;
  }
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

// Automatic context for grep calls that omit output_mode/context. The window
// leans downward: a match needs little room above it (the declaration it sits
// in) but the rest of its block below. Session telemetry over 36.5k grep calls
// showed a symmetric 25-line window paid for lines nobody read — follow-up
// reads landed a median 33 lines above / 83 lines below the rendered block,
// beyond any affordable radius, while callers that set `context` themselves
// chose a median of 3.
// GREP_AUTO_CONTEXT_LINES stays the scalar ceiling: rg fallbacks, the
// expander's maximum window. Scoped-cache keys keep automatic context
// distinct from an explicit -B/-A window of the same size: only the
// automatic request uses the adaptive renderer.
export const GREP_AUTO_CONTEXT_BEFORE = 8;
export const GREP_AUTO_CONTEXT_AFTER = 12;
export const GREP_AUTO_CONTEXT_LINES = GREP_AUTO_CONTEXT_AFTER;

// The aliases grep and glob share: `limit` → `head_limit`, and the root/dir
// spellings of `path`.
function promoteSharedSearchAliases(args) {
  if ((args.head_limit === undefined || args.head_limit === null) && args.limit !== undefined) {
    args.head_limit = args.limit;
    delete args.limit;
  }
  if (args.path === undefined || args.path === null || args.path === '') {
    const alias = firstPresentArg(args, ['root', 'directory', 'dir']);
    if (alias !== undefined) args.path = alias;
  }
}

export function normalizeGrepArgs(args) {
  if (!args || typeof args !== 'object') return args;
  promoteSharedSearchAliases(args);
  if (args.pattern === undefined || args.pattern === null || args.pattern === '') {
    const alias = firstPresentArg(args, ['query', 'regex', 'regexp', 'needle', 'search', 'literal']);
    if (alias !== undefined) args.pattern = alias;
  }
  if (args.glob === undefined || args.glob === null || args.glob === '') {
    const alias = firstPresentArg(args, ['file_pattern', 'filePattern', 'include', 'includes', 'files']);
    if (alias !== undefined) args.glob = alias;
  }
  if (
    (args.output_mode === undefined || args.output_mode === null || args.output_mode === '') &&
    typeof args.mode === 'string'
  ) {
    const mode = args.mode.trim();
    const canonical = {
      content: 'content_with_context',
      files: 'files_with_matches',
      count: 'count',
      content_with_context: 'content_with_context',
      files_with_matches: 'files_with_matches',
    }[mode];
    if (canonical) args.output_mode = canonical;
  }
  return args;
}

export function normalizeGlobArgs(args) {
  if (!args || typeof args !== 'object') return args;
  promoteSharedSearchAliases(args);
  if (args.pattern === undefined || args.pattern === null || args.pattern === '') {
    const alias = firstPresentArg(args, [
      'glob',
      'file_pattern',
      'filePattern',
      'name',
      'include',
      'includes',
      'files',
    ]);
    if (alias !== undefined) args.pattern = alias;
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
  return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
}

export function resolveAgainstCwd(filePath, cwd) {
  return resolve(cwd, filePath);
}

export function cwdRelativePath(fullPath, workDir) {
  try {
    const rel = relative(workDir, fullPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return fullPath;
    return rel;
  } catch {
    return fullPath;
  }
}

// Render an absolute path relative to `cwd` for display. Falls back to the
// original absolute path when `cwd` is missing or does not prefix the input.
// Case-insensitive prefix match so Windows drive-letter casing does not leak
// into tool results. Kept next to the other normalize* helpers.
export function toDisplayPath(absPath, cwd) {
  if (!absPath) return '';
  if (cwd) {
    const a = String(absPath).replace(/\\/g, '/');
    const c = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    if (a.toLowerCase().startsWith(`${c.toLowerCase()}/`)) {
      return a.slice(c.length + 1);
    }
    if (a.toLowerCase() === c.toLowerCase()) return '';
  }
  return absPath;
}

export function extractGlobBaseDirectory(pattern) {
  const wildcardIdx = pattern.search(/[*?[{]/);
  const staticPrefix = wildcardIdx === -1 ? pattern : pattern.slice(0, wildcardIdx);
  const lastSep = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf('\\'));
  if (lastSep === -1) return { baseDir: null, relativePattern: pattern };
  let baseDir = staticPrefix.slice(0, lastSep);
  const remainder = pattern.slice(lastSep + 1);
  const relativePattern = remainder.startsWith('/') ? remainder : `/${remainder}`;
  if (process.platform === 'win32' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = `${baseDir}\\`;
  }
  return { baseDir: baseDir || null, relativePattern };
}

export function hasGlobMagic(value) {
  return typeof value === 'string' && /[*?[{]/.test(value);
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
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed.path ?? parsed.file_path) === 'string'
      ) {
        return [parsed];
      }
    } catch {}
  }
  return value;
}

// A compact `[path, offset, limit?]` range tuple as a region object, or null
// when the value is not one.
function compactReadRangeTuple(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3 || typeof value[0] !== 'string') return null;
  const numeric = value
    .slice(1)
    .every((part) => typeof part === 'number' || (typeof part === 'string' && /^-?\d+(?:\.\d+)?$/.test(part.trim())));
  if (!numeric) return null;
  return {
    path: value[0],
    offset: value[1],
    ...(value.length === 3 ? { limit: value[2] } : {}),
  };
}

const JOINED_PATH_KEYS = { read: ['path', 'file_path'], grep: ['path', 'root'], glob: ['path', 'root'] };
const JOINED_PATH_LIMIT = 10;

// One string that joins several paths with commas/whitespace. A string that
// is itself an existing path is left alone (so `C:\Program Files\x` works);
// otherwise, when EVERY piece exists, it becomes a path array. Anything else
// is left for the normal not-found error (which carries the array hint).
// A split never widens scope: every piece must resolve strictly INSIDE the
// session working directory (the project root). `.`, `..`, the directory
// itself, its ancestors and anything outside it keep the string unsplit and
// return the array hint instead.
// Residual ambiguity (accepted): a missing filename that contains spaces or
// commas, whose pieces all happen to exist as separate in-project paths, is
// read as those pieces rather than reported missing.
// Returns an error message when the split is refused or exceeds the batch
// limit, else null.
export function splitJoinedPathScopes(toolName, args, workDir) {
  const keys = JOINED_PATH_KEYS[toolName];
  if (!keys || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  const exists = (p) => {
    try {
      return existsSync(resolveAgainstCwd(normalizeInputPath(p), workDir));
    } catch {
      return false;
    }
  };
  // Containment is judged on REAL targets: a symlink/junction inside the
  // directory that points outside it is outside.
  const realOrNull = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return null;
    }
  };
  const realRoot = realOrNull(resolve(workDir));
  const strictlyInside = (p) => {
    const piece = normalizeInputPath(p);
    if (piece === '.' || piece === '..' || !realRoot) return false;
    const target = realOrNull(resolveAgainstCwd(piece, workDir));
    if (!target) return false;
    const rel = relative(realRoot, target);
    return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string' || !/[\s,]/.test(value.trim()) || exists(value)) continue;
    const pieces = value.split(/[\s,]+/).filter(Boolean);
    if (pieces.length < 2 || !pieces.every(exists)) continue;
    if (!pieces.every(strictlyInside)) {
      return `Error: ${toolName} arg "${key}" joins several paths in one string, and one is ".", "..", a parent of the working directory or outside it, so it is not split automatically. To pass several paths, send an array (path[]), not a comma- or space-joined string.`;
    }
    if (pieces.length > JOINED_PATH_LIMIT) {
      return `Error: ${toolName} arg "${key}" joins ${pieces.length} paths in one string (${pieces.length} given, max ${JOINED_PATH_LIMIT}); split or pass the parent directory.`;
    }
    args[key] = pieces;
  }
  return null;
}

export function coerceReadFamilyPathArg(path) {
  // A path string names exactly one operand. Filesystem contents must not
  // change its meaning into a batch, repaired JSON, or another filename.
  if (!Array.isArray(path)) return path;
  const coerced = path;
  const directRange = compactReadRangeTuple(coerced);
  if (directRange) return [directRange];
  const list = coerced
    // Provider-facing range tuples are compact; canonicalize them to the
    // legacy region objects consumed by read's batch dispatcher. Existing
    // object callers remain valid and pass through untouched.
    .map((p) => compactReadRangeTuple(p) ?? (typeof p === 'string' ? p.trim() : p))
    .filter((p) => (typeof p === 'string' ? p.length > 0 : p && typeof p === 'object'));
  if (list.length === 0) return [];
  // Collapse to scalar only for a lone string; a lone region object must
  // stay an array so read's object-batch dispatcher handles it.
  return list.length === 1 && typeof list[0] === 'string' ? list[0] : list;
}
