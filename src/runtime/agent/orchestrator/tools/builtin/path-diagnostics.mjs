import { readdirSync, statSync } from 'fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'path';
import { homedir } from 'os';
import { resolvePluginData, mixdogRoot } from '../../../../shared/plugin-paths.mjs';

// Suggest a sibling file the caller may have meant when the requested
// path is missing: same stem with a different extension, or a same-name
// sibling differing only in case. Pure best-effort; any fs error returns
// null so the caller falls back to the bare "not found" message.
export function findSimilarFile(fullPath) {
    try {
        const dir = dirname(fullPath);
        const base = basename(fullPath);
        const stem = basename(fullPath, extname(fullPath));
        const entries = readdirSync(dir);
        const sameStem = entries.find((e) => e !== base && basename(e, extname(e)) === stem);
        if (sameStem) return join(dir, sameStem);
        const caseMatch = entries.find((e) => e !== base && e.toLowerCase() === base.toLowerCase());
        if (caseMatch) return join(dir, caseMatch);
        return null;
    } catch { return null; }
}

// Sibling listing for ENOENT diagnostics. Pure information extension —
// callers always receive the directory's existing entries (capped) inline
// in the error hint, removing the recovery cost of a follow-up list/glob
// call. Measurement showed ENOENT recovery consistently runs read→glob/
// list→read (4-call); siblings inline collapses that to read→read.
export function listSiblings(dir, limit = 12) {
    try {
        return readdirSync(dir).filter((n) => !n.startsWith('.')).slice(0, limit);
    } catch { return []; }
}

// Locate a missing file's basename ELSEWHERE under the search root. The most
// common ENOENT cause is a right-name / wrong-directory path (e.g. asking for
// `webhook.mjs` when the file lives at `src/channels/lib/webhook.mjs`).
// findSimilarFile only inspects the same directory, so a wrong-directory miss
// gets no hint and the caller reconstructs the real path with a grep/glob
// storm. This walks the root (BFS — shallow hits first), skipping noise dirs
// and hard-capped on directories scanned, and returns up to `limit` real
// locations so the error can name them directly. Pure best-effort; any error
// returns [].
const BASENAME_SCAN_SKIP_DIRS = new Set([
    'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
    'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor',
    'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);
export function findFileByBasename(searchRoot, fullPath, { limit = 3, maxDirs = 6000 } = {}) {
    try {
        if (typeof searchRoot !== 'string' || !searchRoot) return [];
        const target = basename(fullPath).toLowerCase();
        if (!target) return [];
        const matches = [];
        const queue = [searchRoot];
        let scanned = 0;
        while (queue.length && matches.length < limit && scanned < maxDirs) {
            const dir = queue.shift();
            scanned++;
            let entries;
            try { entries = readdirSync(dir, { withFileTypes: true }); }
            catch { continue; }
            for (const ent of entries) {
                const name = ent.name;
                if (ent.isDirectory()) {
                    if (name.startsWith('.') || BASENAME_SCAN_SKIP_DIRS.has(name)) continue;
                    queue.push(join(dir, name));
                } else if (ent.isFile() && name.toLowerCase() === target) {
                    const hit = join(dir, name);
                    if (hit !== fullPath) {
                        // Return search-root-relative so the hint stays leak-safe
                        // (no home / cache absolute) and is directly read-usable.
                        matches.push(relative(searchRoot, hit));
                        if (matches.length >= limit) break;
                    }
                }
            }
        }
        return matches;
    } catch { return []; }
}

// Recover a hallucinated absolute-path PREFIX: models frequently request
// paths like /Users/foo/Local/Project/ink/src/tui/input-editing.mjs where the
// TAIL (src/tui/input-editing.mjs) is the real repo-relative path but the
// leading segments are an invented (or wrong-machine) prefix. findFileByBasename
// only matches the final basename and walks the whole tree (skipping vendor/
// noise dirs for performance); this instead peels leading segments off the
// requested path one at a time and stats the remaining tail directly against
// searchRoot — no directory walk, no skip-dir filtering, so it finds files
// under vendor/ or any other normally-skipped directory. Min tail length is 2
// segments so a bare basename (which would match almost anything) never
// counts as a hit. Capped iterations; pure best-effort, never throws.
export function findBySuffixStrip(searchRoot, fullPath, { maxIterations = 12 } = {}) {
    try {
        if (typeof searchRoot !== 'string' || !searchRoot) return null;
        if (typeof fullPath !== 'string' || !fullPath) return null;
        // Containment guard: drop `.`/`..` and drive/UNC-ish segments outright.
        // Tails are joined under searchRoot; a `..` segment could stat (and
        // hint) outside the repo, so no relative-traversal token may survive.
        const segments = fullPath.replace(/\\/g, '/').split('/')
            .filter((s) => s && s !== '.' && s !== '..' && !/^[A-Za-z]:$/.test(s));
        // Peel 0..N leading segments; each peel costs one stat. maxIterations
        // bounds the number of stats (strict <), and tails shorter than 2
        // segments never count as a hit.
        const iterations = Math.min(Math.max(segments.length - 1, 0), Math.max(maxIterations, 0));
        for (let i = 0; i < iterations; i++) {
            const tail = segments.slice(i);
            if (tail.length < 2) break;
            const candidate = join(searchRoot, ...tail);
            const rel = relative(searchRoot, candidate);
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
            try {
                const st = statSync(candidate);
                if (st.isFile() || st.isDirectory()) {
                    return rel.replace(/\\/g, '/');
                }
            } catch { /* miss this tail length, keep peeling */ }
        }
        return null;
    } catch { return null; }
}

// Same as findFileByBasename but for directories sharing the missing path's
// final segment name (e.g. guessed `src/shared` → the real `lib/shared`).
export function findDirectoryByBasename(searchRoot, fullPath, { limit = 3, maxDirs = 6000 } = {}) {
    try {
        if (typeof searchRoot !== 'string' || !searchRoot) return [];
        const target = basename(fullPath).toLowerCase();
        if (!target) return [];
        const matches = [];
        const queue = [searchRoot];
        let scanned = 0;
        while (queue.length && matches.length < limit && scanned < maxDirs) {
            const dir = queue.shift();
            scanned++;
            let entries;
            try { entries = readdirSync(dir, { withFileTypes: true }); }
            catch { continue; }
            for (const ent of entries) {
                const name = ent.name;
                if (ent.isDirectory()) {
                    if (name.toLowerCase() === target) {
                        const hit = join(dir, name);
                        const rel = relative(searchRoot, hit);
                        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                            matches.push(rel.replace(/\\/g, '/'));
                            if (matches.length >= limit) break;
                        }
                    }
                    if (name.startsWith('.') || BASENAME_SCAN_SKIP_DIRS.has(name)) continue;
                    queue.push(join(dir, name));
                }
            }
        }
        return matches;
    } catch { return []; }
}

// Node's native fs errors embed the failing path wrapped in single quotes
// using OS-native separators ('C:\\Users\\foo\\bar.mjs' on Windows). Without
// this pass, read error bodies surface backslash paths that
// break the forward-slash convention the rest of the tool output keeps.
// Accepts an optional workDir to produce cwd-relative paths. This pass also
// closes the R14 tool-result info-leak boundary: home dir / Mixdog root /
// Mixdog data / runtime dir absolutes are rewritten into stable tokens so
// model-facing error bodies never carry environment-specific filesystem
// segments. Full detail is retained in local logs upstream of this call.
//
// Replacement priority for any absolute path encountered:
//   1. cwd-relative      (workDir set and path is inside workDir)
//   2. <runtime>/...     (MIXDOG_RUNTIME_ROOT prefix)
//   3. <mixdog-data>/... (Mixdog data dir)
//   4. <mixdog-root>/...
//   5. ~/...             (OS home directory prefix)
//   6. forward-slash normalised absolute (Windows backslash → slash, no leak)
//
// Two surface forms are scrubbed:
//   * quoted drive-letter / POSIX absolute paths inside the message body
//   * bare `file:///C:/...` or `file:///abs/...` stack-frame URIs (no quotes)
// More-specific prefixes are checked first so plugin-data wins over the
// containing home directory.
export function normalizeErrorMessage(msg, workDir) {
    if (typeof msg !== 'string') return msg;
    const home = homedir().replace(/\\/g, '/');
    const pluginRoot = mixdogRoot().replace(/\\/g, '/');
    const pluginData = resolvePluginData().replace(/\\/g, '/');
    const runtimeDir = (process.env.MIXDOG_RUNTIME_ROOT || '').replace(/\\/g, '/');
    const cwd = typeof workDir === 'string' && workDir ? workDir.replace(/\\/g, '/') : '';

    const redact = (raw) => {
        const fwd = raw.replace(/\\/g, '/');
        if (cwd) {
            try {
                const rel = relative(cwd, fwd);
                if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
                    return rel.replace(/\\/g, '/');
                }
            } catch { /* fall through */ }
        }
        if (runtimeDir && (fwd === runtimeDir || fwd.startsWith(runtimeDir + '/'))) {
            return `<runtime>${fwd.slice(runtimeDir.length)}`;
        }
        if (pluginData && (fwd === pluginData || fwd.startsWith(pluginData + '/'))) {
            return `<mixdog-data>${fwd.slice(pluginData.length)}`;
        }
        if (pluginRoot && (fwd === pluginRoot || fwd.startsWith(pluginRoot + '/'))) {
            return `<mixdog-root>${fwd.slice(pluginRoot.length)}`;
        }
        if (home && (fwd === home || fwd.startsWith(home + '/'))) {
            return `~${fwd.slice(home.length)}`;
        }
        return fwd;
    };

    // 1. Strip bare `file:///...` stack-frame URIs first so the inner path
    //    survives the quoted-path pass that follows (URIs aren't quoted).
    let out = msg.replace(
        /file:\/\/\/([A-Za-z]:\/[^\s'"<>)\]]+|\/[^\s'"<>)\]]+)/g,
        (_m, p) => redact(p),
    );

    // 2. Redact quoted drive-letter (Windows) and POSIX absolute paths.
    out = out.replace(
        /(['"])([A-Za-z]:[\\\/][^'"]+|\/[^'"]+)\1/g,
        (_m, q, p) => `${q}${redact(p)}${q}`,
    );

    return out;
}
