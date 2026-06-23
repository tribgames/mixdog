import { statSync } from 'fs';
import { assertPathReachable, assertPathsReachable } from './fs-reachability.mjs';
import { isAbsolute, resolve } from 'path';
import {
    cwdRelativePath,
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';

// Hard-block patterns live exclusively in ../shell-policy.mjs (BLOCKED_PATTERNS /
// isBlockedCommand). This lighter detector only classifies cache invalidation
// scope for commands that already passed policy.
const SHELL_MUTATION_PATTERN = /(?:^|[;&|\n]\s*)(?:touch|mkdir|mktemp|rm|rmdir|mv|cp|install|ln|chmod|chown|truncate|dd|sed\s+-i|perl\s+-pi|npm\s+(?:install|i|ci|uninstall)|pnpm\s+(?:install|i|add|remove|update|up)|yarn\s+(?:install|add|remove|up)|bun\s+(?:install|add|remove|update|up)|pip(?:3)?\s+install|python(?:3)?\s+-m\s+pip\s+install|git\s+(?:checkout|switch|restore|clean|apply|am|cherry-pick|merge|rebase|stash|pull|reset)|cargo\s+(?:build|install|clean)|go\s+(?:build|install|generate)|make|cmake)\b/i;
// `source` / `.` removed from read-only set: sourced scripts can mutate
// files, cwd, env, and persistent-shell state arbitrarily. Without static
// analysis of the target script, treating these as read-only would skip
// cache invalidation that the sourced script's mutations require. Classify
// as unknown/global mutation by falling through to the default branch.
const SHELL_READ_ONLY_SEGMENT_RE = /^(?:cd|pwd|echo|printf|env|printenv|set|unset|export|alias|unalias|type|which|whereis|ls|dir|cat|head|tail|wc|grep|rg|find|git\s+(?:status|diff|show|log|rev-parse|branch|remote|ls-files)|stat|readlink|realpath|basename|dirname|sort|uniq|cut|sed\s+-n|awk|ps|whoami|uname|date|true|false|test|\[)\b/i;
const SHELL_GLOBAL_MUTATORS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'python', 'python3', 'git', 'cargo', 'go', 'make', 'cmake', 'dd']);

function shellSplitSegments(command) {
    const parts = [];
    let current = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            current += ch;
            escape = true;
            continue;
        }
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '\n' || ch === ';') {
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
            if (current.trim()) parts.push(current.trim());
            current = '';
            i++;
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function shellTokenize(segment) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escape = false;
    const push = () => {
        if (current !== '') tokens.push(current);
        current = '';
    };
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            push();
            continue;
        }
        if (ch === '>') {
            push();
            if (segment[i + 1] === '>') {
                tokens.push('>>');
                i++;
            } else {
                tokens.push('>');
            }
            continue;
        }
        current += ch;
    }
    if (quote) return null;
    push();
    return tokens;
}

function stripShellAssignments(tokens) {
    const out = [...tokens];
    while (out.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
    return out;
}

function resolveShellPathToken(token, cwd) {
    const value = String(token || '').trim();
    if (!value) return null;
    if (value === '>' || value === '>>') return null;
    if (value.startsWith('-')) return null;
    if (/[`$*?[\]{}]/.test(value)) return null;
    return resolveAgainstCwd(normalizeInputPath(value), cwd);
}

function isShellOutputRedirectToken(tok) {
    const lower = String(tok || '').toLowerCase();
    return lower === '>' || lower === '>>'
        || /^(?:\d+>>?|\d+>|&>>?|&>)$/.test(lower);
}

function isShellInputRedirectToken(tok) {
    const lower = String(tok || '').toLowerCase();
    return lower === '<' || lower === '<<'
        || /^(?:\d*<<?)$/.test(lower);
}

function extractShellPathArgs(tokens, cwd, { minIndex = 1 } = {}) {
    const out = [];
    for (let i = minIndex; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok === '--') continue;
        if (/^\d+$/.test(tok) && (isShellOutputRedirectToken(tokens[i + 1]) || isShellInputRedirectToken(tokens[i + 1]))) {
            continue;
        }
        if (isShellOutputRedirectToken(tok)) {
            i++;
            continue;
        }
        if (isShellInputRedirectToken(tok)) {
            const redirected = resolveShellPathToken(tokens[i + 1], cwd);
            if (redirected) out.push(redirected);
            i++;
            continue;
        }
        const outputInline = /^(?:\d+>>?|\d+>|&>>?|&>)(.+)?$/i.exec(tok);
        if (outputInline) continue;
        const inputInline = /^(?:\d*<<?)(.+)$/i.exec(tok);
        if (inputInline) {
            const redirected = resolveShellPathToken(inputInline[1], cwd);
            if (redirected) out.push(redirected);
            continue;
        }
        const resolved = resolveShellPathToken(tok, cwd);
        if (resolved) out.push(resolved);
    }
    return out;
}

const LARGE_SHELL_FILE_PROBE_BYTES = 50 * 1024;
const LARGE_FILE_READ_CMDS = new Set(['cat', 'less', 'more', 'view', 'bat']);

function isExplicitAbsoluteShellPath(value) {
    return isAbsolute(value)
        || /^[A-Za-z]:[\\/]/.test(value)
        || value.startsWith('\\\\');
}

// Truly dynamic shell tokens: parameter expansion (`$VAR`/`${VAR}`),
// command substitution (`$(...)`), and backtick substitution. These
// are resolved at runtime and cannot be statically inspected for
// path/size, so the probe skips them (like glob metachars below)
// rather than blocking -> an unresolvable path can't be statSync'd.
function hasShellVariableExpansion(value) {
    return /[`$]/.test(String(value || ''));
}

// Literal shell glob metacharacters (`*`, `?`, `[`, `]`, `{`, `}`)
// with no `$`/backtick. A token like `docs/styles-*.css` is fully
// deterministic from the command text — the downstream tool (`rg`,
// `grep`, ...) expands it safely. We can't statSync a glob, so the
// large-file probe simply skips it instead of treating it as a
// dangerous dynamic-path token.
function hasShellGlobMeta(value) {
    return /[*?[\]{}]/.test(String(value || ''));
}

function hasDynamicShellBits(value) {
    return hasShellVariableExpansion(value) || hasShellGlobMeta(value);
}

function shellSplitPipelineSegments(segment) {
    const parts = [];
    let current = '';
    let quote = null;
    let escape = false;
    for (let i = 0; i < segment.length; i++) {
        const ch = segment[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            current += ch;
            escape = true;
            continue;
        }
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '|') {
            if (current.trim()) parts.push(current.trim());
            current = '';
            if (segment[i + 1] === '&') i++;
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function stripShellProbeWrappers(tokens) {
    const out = stripShellAssignments(tokens || []);
    let idx = 0;
    while (idx < out.length) {
        const tok = String(out[idx] || '').toLowerCase();
        if (!tok) { idx++; continue; }
        if (tok === 'sudo' || tok === 'nohup' || tok === 'exec') {
            out.splice(idx, 1);
            continue;
        }
        if (tok === 'command') {
            out.splice(idx, 1);
            while (idx < out.length && String(out[idx] || '').startsWith('-')) out.splice(idx, 1);
            continue;
        }
        if (tok === 'env') {
            out.splice(idx, 1);
            while (idx < out.length) {
                const cur = String(out[idx] || '');
                const lower = cur.toLowerCase();
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cur) || lower === '-i') {
                    out.splice(idx, 1);
                    continue;
                }
                if (lower === '-u' && idx + 1 < out.length) {
                    out.splice(idx, 2);
                    continue;
                }
                break;
            }
            continue;
        }
        break;
    }
    return out;
}

function shellOptionConsumesValue(cmd, tok) {
    const lower = String(tok || '').toLowerCase();
    if (cmd === 'grep' || cmd === 'rg') {
        if (['-e', '-f', '-g', '--glob', '-A', '-B', '-C', '--context', '-t', '--type', '--type-add', '-m', '--max-count'].includes(lower)) return true;
        if (/^-[AABCegfmt]$/.test(lower)) return true;
    }
    if (cmd === 'sed') {
        if (['-e', '-f'].includes(lower)) return true;
    }
    if (cmd === 'awk') {
        if (['-f', '-F', '-v'].includes(lower)) return true;
    }
    return false;
}

function isHeadTailBounded(tokens) {
    for (let i = 1; i < tokens.length; i++) {
        const tok = String(tokens[i] || '').toLowerCase();
        if (tok === '-n' || tok === '-c') return true;
        if (/^-(?:n|c)\d+$/.test(tok)) return true;
        if (/^-\d+$/.test(tok)) return true;
    }
    return false;
}

function isGrepBounded(tokens) {
    for (let i = 1; i < tokens.length; i++) {
        const tok = String(tokens[i] || '').toLowerCase();
        if (tok === '-m' || tok === '--max-count') return true;
        if (/^-m\d+$/.test(tok)) return true;
        if (/^--max-count=/.test(tok)) return true;
        if (tok === '--count' || tok === '--quiet' || tok === '--silent' || tok === '--files-with-matches' || tok === '--files-without-match') return true;
        if (/^-[a-z]*[clq][a-z]*$/.test(tok)) return true;
    }
    return false;
}

function isSedBounded(tokens) {
    const hasN = tokens.some((tok) => String(tok || '').toLowerCase() === '-n');
    if (!hasN) return false;
    const scriptIdx = tokens.findIndex((tok, idx) => idx > 0 && !String(tok || '').startsWith('-'));
    if (scriptIdx === -1) return false;
    const script = String(tokens[scriptIdx] || '');
    return /\b\d+(?:,\d+)?p\b/.test(script) || /^\d+(?:,\d+)?p$/.test(script);
}

function isAwkBounded(tokens) {
    const scriptIdx = tokens.findIndex((tok, idx) => idx > 0 && !String(tok || '').startsWith('-'));
    if (scriptIdx === -1) return false;
    const script = String(tokens[scriptIdx] || '');
    return /\bNR\s*(?:==|<=|<|>=|>)\s*\d+/.test(script) || /NR\s*>=\s*\d+\s*&&\s*NR\s*<=\s*\d+/.test(script);
}

function classifyShellProbeToken(token, cwd, { cwdKnown = true } = {}) {
    const value = String(token || '').trim();
    if (!value || value === '--') return { kind: 'skip' };
    // Real dynamic expansion (`$VAR`, `${VAR}`, `$(...)`, backticks)
    // cannot be statically resolved. Like the glob metacharacters
    // below, an unresolvable path can't be statSync'd for the
    // large-file probe, so skip it (let the shell run) rather than
    // hard-block -> the block fired even on tiny `$VAR` targets.
    if (hasShellVariableExpansion(value)) return { kind: 'skip' };
    // Literal glob metacharacters with no expansion are deterministic
    // from the command text. We cannot statSync a glob pattern, so
    // skip it for the large-file probe heuristic rather than flag it
    // as a dynamic/dangerous path token.
    if (hasShellGlobMeta(value)) return { kind: 'skip' };
    const normalized = normalizeInputPath(value);
    if (!cwdKnown && !isExplicitAbsoluteShellPath(normalized)) {
        return { kind: 'relative-unknown', raw: value };
    }
    return { kind: 'path', path: resolveAgainstCwd(normalized, cwd), raw: value };
}

function extractShellProbeTargets(tokens, cwd, { minIndex = 1, cwdKnown = true } = {}) {
    const out = { paths: [], dynamicToken: null, skippedRelativeUnknown: false };
    for (let i = minIndex; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok === '--') continue;
        if (/^\d+$/.test(tok) && (isShellOutputRedirectToken(tokens[i + 1]) || isShellInputRedirectToken(tokens[i + 1]))) {
            continue;
        }
        if (isShellOutputRedirectToken(tok)) {
            i++;
            continue;
        }
        if (isShellInputRedirectToken(tok)) {
            const info = classifyShellProbeToken(tokens[i + 1], cwd, { cwdKnown });
            if (info.kind === 'path') out.paths.push(info.path);
            else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
            else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
            i++;
            continue;
        }
        const outputInline = /^(?:\d+>>?|\d+>|&>>?|&>)(.+)?$/i.exec(tok);
        if (outputInline) continue;
        const inputInline = /^(?:\d*<<?)(.+)$/i.exec(tok);
        if (inputInline) {
            const info = classifyShellProbeToken(inputInline[1], cwd, { cwdKnown });
            if (info.kind === 'path') out.paths.push(info.path);
            else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
            else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
            continue;
        }
        const info = classifyShellProbeToken(tok, cwd, { cwdKnown });
        if (info.kind === 'path') out.paths.push(info.path);
        else if (info.kind === 'dynamic' && !out.dynamicToken) out.dynamicToken = info.raw;
        else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
    }
    return out;
}

function extractShellProbePaths(tokens, cwd, { cwdKnown = true } = {}) {
    const cmd = String(tokens?.[0] || '').toLowerCase();
    if (!cmd) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd: '' };
    if (LARGE_FILE_READ_CMDS.has(cmd)) {
        return { ...extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
    }
    if (cmd === 'head' || cmd === 'tail') {
        if (isHeadTailBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        return { ...extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
    }
    if (cmd === 'grep' || cmd === 'rg') {
        if (isGrepBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        let sawPattern = false;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (!sawPattern) {
                if (tok === '--') { i++; continue; }
                if (tok.startsWith('-')) {
                    i += shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                    continue;
                }
                sawPattern = true;
                i++;
                continue;
            }
            break;
        }
        return { ...extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    if (cmd === 'sed') {
        if (isSedBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (tok === '--') { i++; break; }
            if (tok.startsWith('-')) {
                i += shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                continue;
            }
            // First non-option token is the script/program. Remaining
            // path-like args are candidate target files.
            i++;
            break;
        }
        return { ...extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    if (cmd === 'awk') {
        if (isAwkBounded(tokens)) return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
        let i = 1;
        while (i < tokens.length) {
            const tok = tokens[i];
            if (!tok) { i++; continue; }
            if (tok === '--') { i++; break; }
            if (tok.startsWith('-')) {
                i += shellOptionConsumesValue(cmd, tok) ? 2 : 1;
                continue;
            }
            i++;
            break;
        }
        return { ...extractShellProbeTargets(tokens, cwd, { minIndex: i, cwdKnown }), cmd };
    }
    return { paths: [], dynamicToken: null, skippedRelativeUnknown: false, cmd };
}

function buildLargeShellFileProbeMessage(fullPath, sizeBytes, cmd, cwd) {
    const kb = Math.round(sizeBytes / 1024);
    const display = normalizeOutputPath(cwdRelativePath(fullPath, cwd));
    return `large-file shell probe blocked: \`${cmd}\` is targeting \`${display}\` (${kb} KB).`;
}

export async function preflightShellLargeFileProbe(command, cwd) {
    const text = String(command || '').trim();
    let localCwd = resolve(cwd || process.cwd());
    let cwdKnown = true;
    if (!text) return null;
    for (const segment of shellSplitSegments(text)) {
        for (const stage of shellSplitPipelineSegments(segment)) {
            const parsed = shellTokenize(stage);
            if (!parsed) return null;
            const tokens = stripShellProbeWrappers(parsed);
            if (tokens.length === 0) continue;
            const joined = tokens.join(' ');
            if (/^cd\b/i.test(joined)) {
                const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
                if (hasDynamicShellBits(target)) {
                    cwdKnown = false;
                } else {
                    const resolved = resolveShellPathToken(target, localCwd);
                    if (resolved) {
                        localCwd = resolved;
                        cwdKnown = true;
                    } else {
                        cwdKnown = false;
                    }
                }
                continue;
            }
            const probe = extractShellProbePaths(tokens, localCwd, { cwdKnown });
            if (probe.dynamicToken) {
                return {
                    cmd: probe.cmd,
                    path: null,
                    sizeBytes: null,
                    message: `shell probe requires an explicit path: \`${probe.cmd}\` is using dynamic path token \`${probe.dynamicToken}\`.`,
                };
            }
            if (probe.skippedRelativeUnknown && probe.paths.length === 0) {
                continue;
            }
            for (const candidate of probe.paths) {
                try {
                    await assertPathReachable(candidate);
                } catch (err) {
                    if (err?.code === 'EFSUNREACHABLE') continue;
                    throw err;
                }
                try {
                    const st = statSync(candidate);
                    if (!st.isFile()) continue;
                    if (st.size < LARGE_SHELL_FILE_PROBE_BYTES) continue;
                    return {
                        cmd: probe.cmd,
                        path: candidate,
                        sizeBytes: st.size,
                        message: buildLargeShellFileProbeMessage(candidate, st.size, probe.cmd, localCwd),
                    };
                } catch {
                    // Ignore nonexistent / inaccessible candidates; shell can
                    // surface those normally if the command proceeds.
                }
            }
        }
    }
    return null;
}

export async function analyzeShellCommandEffects(command, cwd) {
    const text = String(command || '').trim();
    let localCwd = resolve(cwd || process.cwd());
    if (!text) return { mutationMode: 'none', paths: [], finalCwd: localCwd };
    const hasRedirect = /(?:^|[^0-9&<>])>>?(?!\&)/.test(text) || /\btee\b/.test(text);
    if (!SHELL_MUTATION_PATTERN.test(text) && !hasRedirect) {
        const readOnly = shellSplitSegments(text).every((segment) => {
            const tokens = stripShellProbeWrappers(shellTokenize(segment) || []);
            if (tokens.length === 0) return true;
            const joined = tokens.join(' ');
            if (/^cd\b/i.test(joined)) {
                const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
                const resolved = resolveShellPathToken(target, localCwd);
                if (resolved) localCwd = resolved;
                return true;
            }
            return SHELL_READ_ONLY_SEGMENT_RE.test(joined);
        });
        return { mutationMode: readOnly ? 'none' : 'global', paths: [], finalCwd: localCwd };
    }
    const paths = new Set();
    let global = false;
    for (const segment of shellSplitSegments(text)) {
        const parsed = shellTokenize(segment);
        if (!parsed) return { mutationMode: 'global', paths: [], finalCwd: localCwd };
        const tokens = stripShellProbeWrappers(parsed);
        if (tokens.length === 0) continue;
        const cmd = tokens[0].toLowerCase();
        const joined = tokens.join(' ');
        if (cmd === 'cd') {
            const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
            const resolved = resolveShellPathToken(target, localCwd);
            if (resolved) localCwd = resolved;
            else global = true;
            continue;
        }
        const segmentMutates = tokens.includes('tee') || tokens.includes('>') || tokens.includes('>>');
        if (!segmentMutates && SHELL_READ_ONLY_SEGMENT_RE.test(joined)) continue;
        if (segmentMutates) {
            const segPaths = [];
            const teeIdx = tokens.indexOf('tee');
            if (teeIdx !== -1) {
                segPaths.push(...extractShellPathArgs(tokens, localCwd, { minIndex: teeIdx + 1 }));
            }
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i] === '>' || tokens[i] === '>>') {
                    const r = resolveShellPathToken(tokens[i + 1], localCwd);
                    if (r) segPaths.push(r);
                }
            }
            if (segPaths.length === 0) { global = true; continue; }
            for (const p of segPaths) paths.add(p);
            continue;
        }
        if (SHELL_GLOBAL_MUTATORS.has(cmd)) {
            if (cmd === 'git') {
                const sub = String(tokens[1] || '').toLowerCase();
                if (['status', 'diff', 'show', 'log', 'rev-parse', 'branch', 'remote', 'ls-files'].includes(sub)) continue;
            }
            if (cmd === 'python' || cmd === 'python3') {
                if (!(tokens[1] === '-m' && tokens[2] === 'pip' && /^install$/i.test(tokens[3] || ''))) continue;
            }
            global = true;
            continue;
        }
        let segmentPaths = [];
        if (['touch', 'mkdir', 'mktemp', 'rm', 'rmdir', 'chmod', 'chown', 'truncate'].includes(cmd)) {
            segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (['mv', 'cp', 'install', 'ln'].includes(cmd)) {
            segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (cmd === 'sed' && tokens.includes('-i')) {
            segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: tokens.lastIndexOf('-i') + 1 });
        } else if (cmd === 'perl' && tokens.some((t) => /^-p/i.test(t) || /^-i/i.test(t))) {
            segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        } else if (cmd === 'tee') {
            segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
        }
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === '>' || tokens[i] === '>>') {
                const redirected = resolveShellPathToken(tokens[i + 1], localCwd);
                if (redirected) segmentPaths.push(redirected);
            }
        }
        if (segmentPaths.length === 0) {
            global = true;
            continue;
        }
        for (const p of segmentPaths) paths.add(p);
    }
    if (global) return { mutationMode: 'global', paths: [], finalCwd: localCwd };
    if (paths.size > 0) {
        const pathList = [...paths];
        await assertPathsReachable(pathList);
        return { mutationMode: 'paths', paths: pathList, finalCwd: localCwd };
    }
    return { mutationMode: 'none', paths: [], finalCwd: localCwd };
}

export function foregroundLongCommandHint(command, timeoutMs, args = {}) {
    if (args.run_in_background === true) return '';
    const cmd = String(command || '').trim();
    if (!cmd) return '';
    const longTimeout = Number(timeoutMs) >= 120_000;
    const watchLike = /^\s*gh\s+run\s+watch(?:\s|$)/i.test(cmd)
        || /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch|serve)(?:\s|$)/i.test(cmd)
        || /^\s*(?:vite|webpack-dev-server|next|nuxt|astro)\s+(?:dev|start)(?:\s|$)/i.test(cmd);
    const longPowerShellSleep = [...cmd.matchAll(/\bStart-Sleep\b([^;&|\r\n]*)/gi)].some((m) => {
        const part = String(m[1] || '');
        const ms = part.match(/-(?:Milliseconds|m)\s+(\d+)/i);
        if (ms) return Number(ms[1]) >= 30000;
        const sec = part.match(/-(?:Seconds|s)\s+(\d+)/i) || part.match(/^\s+(\d+)/);
        return sec ? Number(sec[1]) >= 30 : false;
    });
    const longSleep = /\bsleep\s+(?:[3-9]\d|\d{3,}|\d+[mh])\b/i.test(cmd) || longPowerShellSleep;
    if (!watchLike && !longSleep) return '';
    if (!longTimeout && !watchLike && !longSleep) return '';
    return 'Error: long foreground command detected.';
}
