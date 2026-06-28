import { readdir } from 'fs/promises';
import { join } from 'path';

// Glob-to-RegExp compiler for name filters used by find_files and the
// list-tool family. Supported syntax:
//   *        — matches any run of non-separator chars within one segment
//   **       — matches across `/` boundaries (any depth)
//   ?        — matches one non-separator char
//   {a,b,c}  — brace alternation (no nesting)
// Regex metacharacters in literal positions are escaped per-char. The
// per-character loop replaces an older .replace-based pipeline whose
// substitution-string form silently corrupted patterns containing `$`
// sequences (see B35, v0.6.216); the loop avoids substitution entirely.
// DoS caps for brace expansion + compiled regex. A crafted pattern
// such as `{a,b}` repeated 25 times would Cartesian-multiply to ~33M
// variants and produce a multi-megabyte regex; both the recursive
// expansion and the `new RegExp` call would burn CPU/memory before
// any caller-side check. These ceilings are well above realistic user
// globs. Limits are surfaced as Error strings so the tool layer can
// convert them to a tool error instead of crashing the worker.
const MAX_BRACE_VARIANTS = 256;
const MAX_PATTERN_LENGTH = 1024;
const MAX_REGEX_BODY_LENGTH = 16384;
function expandBraces(pattern) {
    const m = pattern.match(/\{([^{}]*)\}/);
    if (!m) return [pattern];
    const before = pattern.slice(0, m.index);
    const after = pattern.slice(m.index + m[0].length);
    const parts = m[1].split(',');
    const out = [];
    for (const p of parts) {
        for (const rest of expandBraces(after)) {
            if (out.length >= MAX_BRACE_VARIANTS) {
                throw new Error(`glob brace expansion exceeds ${MAX_BRACE_VARIANTS} variants`);
            }
            out.push(before + p + rest);
        }
    }
    return out;
}
const REGEX_META = /[.+^${}()|[\]\\]/;
function compileVariant(variant) {
    let body = '';
    for (let i = 0; i < variant.length; i++) {
        const ch = variant[i];
        if (ch === '*') {
            // `**/` (at any position, including leading) means "zero-or-more
            // directory segments" so `src/**/foo` matches both `src/foo` and
            // `src/a/b/foo`. The older compile emitted `.*/` which forced at
            // least one path char between, breaking the zero-dir case.
            if (variant[i + 1] === '*' && variant[i + 2] === '/') {
                body += '(?:.*/)?';
                i += 2;
            } else if (variant[i + 1] === '*') {
                body += '.*';
                i++;
            } else {
                body += '[^/]*';
            }
        } else if (ch === '?') {
            body += '[^/]';
        } else if (ch === '[') {
            // Glob bracket class: [abc], [!abc], [a-z]. Parse forward to the
            // closing `]`; only when a well-formed class is found do we emit
            // a regex character class. Malformed/unclosed `[` falls back to
            // a literal escape so REGEX_META semantics still hold.
            let j = i + 1;
            let negate = false;
            if (variant[j] === '!' || variant[j] === '^') { negate = true; j++; }
            // POSIX-style: a `]` as the first class char is a literal.
            const innerStart = j;
            if (variant[j] === ']') j++;
            while (j < variant.length && variant[j] !== ']') j++;
            if (j < variant.length && j > innerStart) {
                // Escape backslashes inside the class; hyphens and other
                // chars are passed through so `[a-z]` ranges still work.
                const inner = variant.slice(innerStart, j).replace(/\\/g, '\\\\');
                body += '[' + (negate ? '^' : '') + inner + ']';
                i = j;
            } else {
                body += '\\[';
            }
        } else if (REGEX_META.test(ch)) {
            body += '\\' + ch;
        } else {
            body += ch;
        }
    }
    return body;
}
export function compileSimpleGlob(pattern) {
    if (!pattern) return null;
    // On Windows, treat backslashes as path separators — candidate paths are
    // forward-slash normalized, so a literal-escaped `\` (REGEX_META) in e.g.
    // `**\*.mjs` would never match a `/`-joined path. Mirrors the win32 `\`->`/`
    // canonicalization the grep tool already applies.
    if (process.platform === 'win32') pattern = pattern.replace(/\\/g, '/');
    if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(`glob pattern length ${pattern.length} exceeds limit ${MAX_PATTERN_LENGTH}`);
    }
    const variants = expandBraces(pattern).map(compileVariant);
    const DOLLAR = '\x24';
    const body = variants.length === 1 ? variants[0] : `(?:${variants.join('|')})`;
    if (body.length > MAX_REGEX_BODY_LENGTH) {
        throw new Error(`glob regex body length ${body.length} exceeds limit ${MAX_REGEX_BODY_LENGTH}`);
    }
    return new RegExp('^' + body + DOLLAR, 'i');
}

// Directory names that are dependency / build / cache artifacts. Skipped
// by default in list / tree / find_files traversal so the response shape
// reflects user code, not transitive tooling output. Pass
// `include_noise:true` on the tool call to traverse them.
// Policy note: exclusion is basename-only at every depth — a directory
// literally named e.g. `dist` is skipped regardless of where in the tree
// it appears. Context-aware exclusion (e.g. only skip `dist` adjacent to
// a package.json) is intentionally not implemented; the basename rule is
// simpler and matches the noise patterns developers actually create.
export const NOISE_DIR_NAMES = new Set([
    'node_modules', '.git',
    '.next', '.nuxt', '.svelte-kit',
    '.cache', '.parcel-cache', '.turbo',
    'venv', '.venv', '__pycache__', '.pytest_cache',
    '.gradle',
]);

export const MAX_WALK_ENTRIES = 200_000;

// Unified directory walk used by list / tree / find_files. The visitor
// callback owns the "should I record this entry?" decision; returning
// literal false aborts the whole walk.
// `onWarn(dir, err)` (optional) is invoked for any readdir failure so
// callers can surface skipped paths instead of silently dropping them.
export async function walkDir(root, { hidden = false, maxDepth = Infinity, visit, sort, excludeDirNames, onWarn, maxEntries = MAX_WALK_ENTRIES, signal } = {}) {
    // Windows filesystems are case-insensitive — match exclusion names the
    // same way so e.g. Node_Modules is pruned like node_modules.
    const _exclCI = process.platform === 'win32' && excludeDirNames && excludeDirNames.size > 0
        ? new Set([...excludeDirNames].map((n) => n.toLowerCase()))
        : null;
    let truncated = false;
    const cap = maxEntries;
    let entriesVisited = 0;
    const _walk = async (dir, depth) => {
        if (signal?.aborted) {
            truncated = true;
            return false;
        }
        if (entriesVisited >= cap) {
            truncated = true;
            return false;
        }
        if (depth > maxDepth) return true;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); }
        catch (err) {
            if (typeof onWarn === 'function') {
                try { onWarn(dir, err); } catch { /* warning sink must not abort */ }
            }
            return true;
        }
        if (!hidden) entries = entries.filter(e => !e.name.startsWith('.'));
        if (excludeDirNames && excludeDirNames.size > 0) {
            entries = entries.filter(e => !(e.isDirectory() && (_exclCI
                ? _exclCI.has(e.name.toLowerCase())
                : excludeDirNames.has(e.name))));
        }
        if (sort) entries.sort(sort);
        const total = entries.length;
        for (let i = 0; i < total; i++) {
            if (signal?.aborted) {
                truncated = true;
                return false;
            }
            if (entriesVisited >= cap) {
                truncated = true;
                return false;
            }
            entriesVisited += 1;
            const ent = entries[i];
            const entPath = join(dir, ent.name);
            const ctx = { depth, index: i, total, isLast: i === total - 1 };
            const cont = visit(ent, entPath, ctx);
            if (cont === false) return false;
            if (ent.isDirectory()) {
                if ((await _walk(entPath, depth + 1)) === false) return false;
            }
        }
        return true;
    };
    await _walk(root, 1);
    return { truncated, entriesVisited };
}
