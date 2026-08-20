// Native adapters for well-known tool names from OTHER agent CLIs whose
// argument shapes differ from any mixdog builtin (StrReplace/Write/bash
// variants). Executed directly against the filesystem via atomicWrite / the
// existing shell runner — NOT by synthesizing an apply_patch V4A string
// (that approach was tried and abandoned: building a correct V4A envelope
// from arbitrary old_string/new_string/contents blew up in edge-case
// complexity for no benefit over a direct fs edit).
//
// Contract: tryExecuteExternalToolAdapter(name, args, workDir, options)
// returns a result STRING when the call was handled (success or a concrete
// tool-level error), or `null` when the args shape didn't match what the
// adapter expects — the caller (builtin.mjs default: case) falls back to
// the existing EXTERNAL_TOOL_REDIRECTS guidance message in that case.
import { readFileSync, mkdirSync, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { assertPathsReachable } from './fs-reachability.mjs';
import { normalizeInputPath, resolveAgainstCwd, normalizeOutputPath } from './path-utils.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component, isBlockedDevicePath, isSpecialFileStat } from './device-paths.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import { executeBashTool } from './bash-tool.mjs';
import { runServerEdit } from '../patch/native-server.mjs';
import { nearestPatchLineMatch } from '../patch/matcher.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';

const STR_REPLACE_NAMES = new Set(['edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace']);
const WRITE_NAMES = new Set(['write', 'create_file', 'createfile']);
// 'bash'/'Bash' explicitly request the posix/git-bash shell kind; the
// run/runcommand/terminal/run_terminal_cmd family leaves `shell` unset so
// executeBashTool's own default-shell resolution applies (mirrors how the
// native `shell` tool behaves when the caller omits `shell`).
const BASH_SHELL_KIND_NAMES = new Set(['bash']);
const BASH_DEFAULT_NAMES = new Set(['run', 'runcommand', 'terminal', 'run_terminal_cmd']);

/**
 * True when `name` is a foreign-CLI tool this module can adapt natively.
 * Used by the session loop's dispatch so these names route INTO
 * executeBuiltinTool (whose default: case invokes the adapter) instead of
 * short-circuiting to the unknown-tool redirect message.
 */
export function isExternalAdapterTool(name) {
    if (typeof name !== 'string' || !name) return false;
    const key = name.toLowerCase();
    return STR_REPLACE_NAMES.has(key) || WRITE_NAMES.has(key)
        || BASH_SHELL_KIND_NAMES.has(key) || BASH_DEFAULT_NAMES.has(key);
}

// Same write-target guards the read/list surfaces enforce (UNC → NTLM hash
// leak, device namespace → raw device access / hang, trailing-dot / ADS →
// device-guard bypass). Writes are strictly more dangerous than reads, so
// every adapter write path must run these on both the normalized input and
// the fully resolved path. Returns an Error string or null.
function guardWritePath(p) {
    if (isUncPath(p))
        return `Error: cannot write UNC / SMB path (network credential leak risk): ${normalizeOutputPath(p)}`;
    if (isWindowsDevicePath(p))
        return `Error: cannot write Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(p)}`;
    if (hasUnsafeWin32Component(p))
        return `Error: cannot write Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(p)}`;
    if (isBlockedDevicePath(p))
        return `Error: cannot write device file (would block or corrupt a device): ${normalizeOutputPath(p)}`;
    return null;
}

// Realpath to the nearest existing ancestor (create-mode leaves don't exist
// yet). Returns { probe, real } or null when nothing on the path exists /
// realpath itself fails.
function realpathNearestExisting(fullPath) {
    let probe = fullPath;
    while (probe && !existsSync(probe)) {
        const parent = dirname(probe);
        if (!parent || parent === probe) return null;
        probe = parent;
    }
    if (!probe || !existsSync(probe)) return null;
    try { return { probe, real: realpathSync(probe) }; } catch { return null; }
}

// Realpath-based guard: a symlink/junction in the target (or its nearest
// existing ancestor, for create-mode paths) can point at a UNC share or a
// device namespace that the lexical checks above never see. Mirrors the
// realpath verification apply_patch runs on every header. Returns an Error
// string or null; never throws.
function guardRealTarget(fullPath) {
    const nearest = realpathNearestExisting(fullPath);
    if (nearest && nearest.real !== nearest.probe) {
        const guardErr = guardWritePath(nearest.real);
        if (guardErr) return `${guardErr} (symlink target of ${normalizeOutputPath(nearest.probe)})`;
    }
    try {
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
            const realTarget = realpathSync(fullPath);
            const linkGuardErr = guardWritePath(realTarget);
            if (linkGuardErr) return `${linkGuardErr} (symlink target of ${normalizeOutputPath(fullPath)})`;
        }
        // statSync FOLLOWS a leaf symlink, so a link pointing at a custom
        // FIFO/socket/char/block inode trips here too (lstat alone only saw
        // the link inode itself).
        const st = statSync(fullPath);
        if (isSpecialFileStat(st))
            return `Error: cannot write special file (FIFO / character / block device / socket): ${normalizeOutputPath(fullPath)}`;
    } catch { /* ENOENT (create mode) — nothing to check */ }
    return null;
}

async function resolveTargetPath(args, workDir) {
    const raw = args?.path ?? args?.file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const norm = normalizeInputPath(raw);
    const guardErr = guardWritePath(norm);
    if (guardErr) return { error: guardErr };
    const full = resolveAgainstCwd(norm, workDir);
    const fullGuardErr = guardWritePath(full);
    if (fullGuardErr) return { error: fullGuardErr };
    // Reachability preflight BEFORE any sync fs (existsSync/realpathSync/
    // lstatSync in the guards below): a dead mount would wedge the event loop
    // on the first sync stat, defeating every downstream timeout. Same
    // deadline-raced probe the read path runs (_readReachPreflight).
    try { await assertPathsReachable([full]); }
    catch (e) { return { error: `Error: ${e?.message || e}` }; }
    const realGuardErr = guardRealTarget(full);
    if (realGuardErr) return { error: realGuardErr };
    return { full };
}

function invalidateAfterWrite(fullPath) {
    try { invalidateBuiltinResultCache([fullPath]); } catch { /* best-effort */ }
    try { markCodeGraphDirtyPaths([fullPath]); } catch { /* best-effort */ }
}

function editScope(options) {
    return options?.readStateScope || options?.sessionId || null;
}

function recordEditSnapshot(fullPath, options, contentHash = null) {
    try {
        recordReadSnapshot(fullPath, statSync(fullPath), editScope(options), {
            source: 'edit',
            isPartialView: false,
            replaceExisting: true,
            ...(contentHash ? { contentHash } : {}),
        });
    } catch { /* best-effort */ }
}

// UI diff parity with apply_patch: register the before/after pair on the
// shared per-call side channel so tool cards render edit results with the
// same diff markup. Lazy import breaks the orchestrator→builtin→adapters
// module cycle; failures never affect the edit result.
async function recordEditUiDiff(options, workDir, fullPath, before, after) {
    const callId = options?.toolCallId;
    const sessionId = options?.sessionId || options?.readStateScope;
    if (!callId || !sessionId) return;
    try {
        const { registerEditToolUiDiff } = await import('../patch/orchestrator.mjs');
        registerEditToolUiDiff({ callId, sessionId, basePath: workDir, fullPath, before, after });
    } catch { /* best-effort display channel */ }
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let idx = -1;
    while ((idx = haystack.indexOf(needle, idx + 1)) !== -1) count += 1;
    return count;
}

function formatEditFailureExcerpt(content, oldStr, errorText) {
    const source = String(content ?? '').replace(/\r\n/g, '\n');
    const lines = source.split('\n');
    if (lines.length === 0) return '';
    let center = -1;
    const nearest = /nearest match on line (\d+)/i.exec(String(errorText || ''));
    if (nearest) center = Math.max(0, Number(nearest[1]) - 1);
    if (center < 0 && oldStr) {
        const at = source.indexOf(oldStr);
        if (at >= 0) center = source.slice(0, at).split('\n').length - 1;
    }
    if (center < 0) {
        // Longest tokens from ANY line of old_string, not just the first one:
        // an edit whose opening line is `}` or blank still carries a
        // distinctive token further down.
        const tokens = String(oldStr || '')
            .split(/\s+/)
            .filter((token) => token.length >= 4)
            .sort((a, b) => b.length - a.length)
            .slice(0, 5);
        for (const token of tokens) {
            const hit = lines.findIndex((line) => line.includes(token));
            if (hit >= 0) { center = hit; break; }
        }
    }
    if (center < 0) {
        // Fuzzy scorer shared with apply_patch: whitespace, rename and
        // reflow drift still land on the right region.
        const wanted = String(oldStr || '').split('\n').find((line) => line.trim());
        const best = nearestPatchLineMatch(lines, wanted, 0);
        if (best) center = best.index;
    }
    if (center < 0) {
        // A bare "old_string not found" with no excerpt was the one edit
        // failure that reliably produced retry storms. State what IS known so
        // the retry changes target instead of repeating itself.
        return `\ncurrent file has ${lines.length} line(s) and contains nothing resembling old_string`
            + ' — verify the path and re-read before retrying.';
    }
    const start = Math.max(0, center - 3);
    const end = Math.min(lines.length, start + 10);
    const rows = [];
    let chars = 0;
    for (let i = start; i < end; i++) {
        const raw = lines[i];
        const shown = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
        const row = `${String(i + 1).padStart(5, ' ')}| ${shown}`;
        chars += row.length + 1;
        if (chars > 3000) {
            rows.push('     | …');
            break;
        }
        rows.push(row);
    }
    return rows.length > 0
        ? `\ncurrent file excerpt lines ${start + 1}-${start + rows.length} (use exact current text for retry):\n${rows.join('\n')}`
        : '';
}

// 1:1 length-preserving typographic normalization (dashes, curly quotes,
// unusual spaces → ASCII). Length preservation is what lets a normalized
// indexOf hit be mapped back onto the file's actual bytes.
const TYPO_DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const TYPO_SINGLE_RE = /[\u2018\u2019\u201A\u201B]/g;
const TYPO_DOUBLE_RE = /[\u201C\u201D\u201E\u201F]/g;
const TYPO_SPACE_RE = /[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g;
function normalizeTypographicChars(s) {
    return String(s)
        .replace(TYPO_DASH_RE, '-')
        .replace(TYPO_SINGLE_RE, "'")
        .replace(TYPO_DOUBLE_RE, '"')
        .replace(TYPO_SPACE_RE, ' ');
}

function isOpeningQuoteContext(prev) {
    return prev === undefined || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r'
        || prev === '(' || prev === '[' || prev === '{' || prev === '\u2014' || prev === '\u2013';
}

// Mirror the matched span's curly-quote style onto replacement text: plain
// quotes become open/close curly quotes by position; an apostrophe between
// two letters stays a closing single quote (contraction).
function applyFileQuoteStyle(actualSpan, replacement) {
    const hasDouble = /[\u201C\u201D]/.test(actualSpan);
    const hasSingle = /[\u2018\u2019]/.test(actualSpan);
    if (!hasDouble && !hasSingle) return replacement;
    const chars = [...replacement];
    const out = [];
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '"' && hasDouble) {
            out.push(isOpeningQuoteContext(chars[i - 1]) ? '\u201C' : '\u201D');
        } else if (c === "'" && hasSingle) {
            const prevIsLetter = i > 0 && /\p{L}/u.test(chars[i - 1]);
            const nextIsLetter = i + 1 < chars.length && /\p{L}/u.test(chars[i + 1]);
            if (prevIsLetter && nextIsLetter) out.push('\u2019');
            else out.push(isOpeningQuoteContext(chars[i - 1]) ? '\u2018' : '\u2019');
        } else {
            out.push(c);
        }
    }
    return out.join('');
}

async function adaptStrReplace(args, workDir, options) {
    let oldStr = args?.old_string;
    let newStr = args?.new_string;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
    if (oldStr === newStr) return 'Error: old_string and new_string are exactly the same';
    const replaceAll = args?.replace_all === true
        || String(args?.replace_all || '').toLowerCase() === 'true';
    const target = await resolveTargetPath(args, workDir);
    if (!target) return null;
    if (target.error) return target.error;
    const fullPath = target.full;
    if (oldStr.length === 0 && !existsSync(fullPath)) {
        try { mkdirSync(dirname(fullPath), { recursive: true }); } catch { /* surfaced by atomicWrite */ }
        try {
            await atomicWrite(fullPath, newStr, {
                sessionId: editScope(options),
                signal: options?.signal,
                expectedTargetSnapshot: { exists: false },
            });
        } catch (err) {
            if (err?.code === 'ESTALE_TARGET') {
                return `Error: ${fullPath} was created concurrently; read it before editing`;
            }
            throw err;
        }
        invalidateAfterWrite(fullPath);
        recordEditSnapshot(fullPath, options);
        await recordEditUiDiff(options, workDir, fullPath, null, newStr);
        return `Created ${fullPath} (${Buffer.byteLength(newStr, 'utf8')} bytes)`;
    }
    let content;
    let statBefore = null;
    try {
        try { statBefore = statSync(fullPath); } catch { /* readFileSync below surfaces the real error */ }
        content = readFileSync(fullPath, 'utf8');
    } catch (err) {
        return `Error: cannot read ${fullPath} (${err?.message || err})`;
    }
    if (oldStr.length === 0) {
        if (content.length > 0) return `Error: cannot create ${fullPath}: file already exists and is not empty`;
        try {
            await atomicWrite(fullPath, newStr, {
                sessionId: editScope(options),
                signal: options?.signal,
                expectedTargetSnapshot: {
                    exists: true,
                    size: statBefore.size,
                    mtimeMs: statBefore.mtimeMs,
                    ctimeMs: statBefore.ctimeMs,
                    ino: statBefore.ino,
                },
            });
        } catch (err) {
            if (err?.code === 'ESTALE_TARGET') {
                return `Error: ${fullPath} changed on disk during the edit; read it again`;
            }
            throw err;
        }
        invalidateAfterWrite(fullPath);
        recordEditSnapshot(fullPath, options);
        await recordEditUiDiff(options, workDir, fullPath, content, newStr);
        return `Updated ${fullPath} (filled empty file)`;
    }
    // Dialect normalization (skipped for same-anchor batch members whose
    // occurrence accounting is bound to the original old_string):
    if (!options?.editOccurrence) {
        // Replacement-text trailing-whitespace hygiene; markdown keeps
        // trailing double-space hard line breaks.
        if (!/\.(md|mdx)$/i.test(fullPath)) {
            newStr = newStr.replace(/[ \t]+(?=\r?\n|$)/g, '');
        }
        // Typographic rematch: old_string missed byte-exact but matches after
        // 1:1 normalization of dashes/curly quotes/odd spaces. Rebase
        // old_string onto the file's actual bytes and mirror the file's curly
        // quote style into the replacement; replace_all requires every span to
        // be byte-identical so no occurrence is silently skipped.
        if (oldStr.length > 0 && !content.includes(oldStr)) {
            const normContent = normalizeTypographicChars(content);
            const normOld = normalizeTypographicChars(oldStr);
            const spans = [];
            for (let at = normContent.indexOf(normOld); at !== -1 && spans.length < 64; at = normContent.indexOf(normOld, at + 1)) {
                spans.push(content.slice(at, at + oldStr.length));
            }
            if (spans.length > 0 && spans[0] !== oldStr && (!replaceAll || spans.every((span) => span === spans[0]))) {
                newStr = applyFileQuoteStyle(spans[0], newStr);
                oldStr = spans[0];
            }
        }
        // Deleting a block absorbs its trailing newline so the deletion does
        // not leave an empty line behind.
        if (newStr === '' && oldStr.length > 0 && !oldStr.endsWith('\n')) {
            if (content.includes(`${oldStr}\r\n`)) oldStr += '\r\n';
            else if (content.includes(`${oldStr}\n`)) oldStr += '\n';
        }
        if (oldStr === newStr) return 'Error: old_string and new_string are exactly the same';
    }
    // Batch sequential occupation (tool-batch `_editSeqGroups`): this call is
    // the next member of a same-anchor edit batch and exactly `expected`
    // occurrences of old_string must remain. Deterministically consume the
    // FIRST remaining occurrence (document order == call order, the contract
    // apply_patch hunks already have). Exact byte matching only; any count
    // drift falls through to the native engine's strict ambiguity reject.
    const _occupation = options?.editOccurrence;
    if (_occupation && !replaceAll && Number.isInteger(_occupation.expected) && _occupation.expected >= 2) {
        const positions = [];
        for (let at = content.indexOf(oldStr); at !== -1; at = content.indexOf(oldStr, at + oldStr.length)) {
            positions.push(at);
        }
        if (positions.length === _occupation.expected) {
            const at = positions[0];
            const next = `${content.slice(0, at)}${newStr}${content.slice(at + oldStr.length)}`;
            try {
                await atomicWrite(fullPath, next, {
                    sessionId: editScope(options),
                    signal: options?.signal,
                    expectedTargetSnapshot: statBefore ? {
                        exists: true,
                        size: statBefore.size,
                        mtimeMs: statBefore.mtimeMs,
                        ctimeMs: statBefore.ctimeMs,
                        ino: statBefore.ino,
                    } : { exists: false },
                });
            } catch (err) {
                if (err?.code === 'ESTALE_TARGET') {
                    return `Error: ${fullPath} changed on disk during the edit; read it again`;
                }
                throw err;
            }
            invalidateAfterWrite(fullPath);
            recordEditSnapshot(fullPath, options);
            await recordEditUiDiff(options, workDir, fullPath, content, next);
            return `Updated ${fullPath} (1 replacement)`;
        }
    }
    let result;
    try {
        result = await runServerEdit({
            fullPath,
            oldBuf: Buffer.from(oldStr, 'utf8'),
            newBuf: Buffer.from(newStr, 'utf8'),
            replaceAll,
            signal: options?.signal || null,
        });
    } catch (err) {
        const message = err?.message || String(err);
        if (/old_string (?:not found|found \d+ times)/i.test(message)) {
            let latest = content;
            try { latest = readFileSync(fullPath, 'utf8'); } catch { /* retain pre-dispatch content */ }
            return `Error: edit failed (${message})${formatEditFailureExcerpt(latest, oldStr, message)}`;
        }
        throw err;
    }
    invalidateAfterWrite(fullPath);
    recordEditSnapshot(fullPath, options, result.contentHash);
    {
        let after = null;
        try { after = readFileSync(fullPath, 'utf8'); } catch { /* diff omitted */ }
        if (typeof after === 'string') await recordEditUiDiff(options, workDir, fullPath, content, after);
    }
    return `Updated ${fullPath} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'})`;
}

async function adaptWrite(args, workDir, options) {
    const contents = args?.contents ?? args?.content ?? args?.file_text;
    if (typeof contents !== 'string') return null;
    const target = await resolveTargetPath(args, workDir);
    if (!target) return null;
    if (target.error) return target.error;
    const fullPath = target.full;
    const existed = existsSync(fullPath);
    try { mkdirSync(dirname(fullPath), { recursive: true }); } catch { /* best-effort: parent may already exist */ }
    await atomicWrite(fullPath, contents, { sessionId: options?.readStateScope || options?.sessionId });
    invalidateAfterWrite(fullPath);
    return `${existed ? 'Updated' : 'Created'} ${fullPath} (${Buffer.byteLength(contents, 'utf8')} bytes)`;
}

async function adaptBash(key, args, workDir, options) {
    if (typeof args?.command !== 'string' || args.command.length === 0) return null;
    const shellArgs = { ...args };
    if (BASH_SHELL_KIND_NAMES.has(key) && shellArgs.shell === undefined) shellArgs.shell = 'bash';
    return executeBashTool(shellArgs, workDir, options);
}

export async function tryExecuteExternalToolAdapter(name, args, workDir, options) {
    if (typeof name !== 'string' || !name) return null;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    const key = name.toLowerCase();
    try {
        if (STR_REPLACE_NAMES.has(key)) return await adaptStrReplace(args, workDir, options);
        if (WRITE_NAMES.has(key)) return await adaptWrite(args, workDir, options);
        if (BASH_SHELL_KIND_NAMES.has(key) || BASH_DEFAULT_NAMES.has(key)) return await adaptBash(key, args, workDir, options);
    } catch (err) {
        return `Error: ${name} failed (${err?.message || String(err)})`;
    }
    return null;
}
