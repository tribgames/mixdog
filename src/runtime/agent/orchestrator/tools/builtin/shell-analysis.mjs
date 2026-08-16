import { closeSync, openSync, readSync, statSync, unlinkSync } from 'fs';
import { assertPathReachable, assertPathsReachable } from './fs-reachability.mjs';
import { isAbsolute, join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
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

export function shellSplitSegments(command) {
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

export function shellTokenize(segment) {
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

export function shellSplitPipelineSegments(segment) {
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

export function stripShellProbeWrappers(tokens) {
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

// ---------------------------------------------------------------------------
// PowerShell hygiene preflight (Windows PS host only). Two behaviors:
//   (1) LOSSLESS auto-substitution: MSYS/Git-Bash `/x/…` absolute paths (x is a
//       single drive letter) are impossible on Windows, so they are rewritten
//       to `X:\…` and execution continues.
//   (2) HARD BLOCK + hint: Unix-only commands used as the first token of any
//       pipeline stage (grep/egrep/fgrep, tail, head, sed, awk), `$PID`
//       reassignment, and `&&` on Windows PowerShell 5.1 are rejected with a
//       PowerShell-native correction hint so the agent retries valid syntax.
// POSIX shells are a strict no-op.
// ---------------------------------------------------------------------------
const MSYS_ABS_PATH_RE = /(^|[\s"'=,(])\/([A-Za-z])\/([^\s"'`|&;<>()]*)/g;

// Replace every character that lives inside a single/double-quoted string with a
// filler ('\0'), keeping the string length 1:1 so match offsets stay aligned.
// Quote delimiters are preserved (they never match /x/, &&, or $PID=), and a
// backtick inside double quotes escapes the next char (PS escape). Callers run
// the drive-rewrite and bash-ism regexes against the mask so quoted literals /
// regex patterns are never treated as real path tokens or connectors.
function maskQuotedRegions(command) {
    const FILL = '\0';
    let out = '';
    let quote = null;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) { out += FILL; escaped = false; continue; }
        if (quote) {
            if (quote === '"' && ch === '`') { out += FILL; escaped = true; continue; }
            if (ch === quote) { out += ch; quote = null; continue; }
            out += FILL;
            continue;
        }
        if (ch === '\'' || ch === '"') { quote = ch; out += ch; continue; }
        out += ch;
    }
    return out;
}

function rewriteMsysDrivePaths(command) {
    const src = String(command);
    const mask = maskQuotedRegions(src);
    const re = new RegExp(MSYS_ABS_PATH_RE.source, 'g');
    let changed = false;
    let out = '';
    let last = 0;
    let m;
    // Matches occur only in unquoted regions (quoted chars are '\0' in `mask`),
    // so the captured groups hold the real, unmasked path text.
    while ((m = re.exec(mask)) !== null) {
        const [full, pre, drive, rest] = m;
        out += src.slice(last, m.index);
        out += `${pre}${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
        last = m.index + full.length;
        changed = true;
    }
    out += src.slice(last);
    return { command: changed ? out : src, changed };
}

// Unix-only command → PowerShell-native replacement hint. Keyed by the bare
// first token of a pipeline stage (path prefix stripped), so `Select-String`
// and other real cmdlets never match, and a filename/arg that merely contains
// "grep" is ignored (only the command token is judged).
const POWERSHELL_BASHISM_HINTS = {
    grep: 'grep → Select-String  (e.g. `Select-String -Pattern foo -Path file`)',
    egrep: 'egrep → Select-String -Pattern <regex>',
    fgrep: 'fgrep → Select-String -SimpleMatch',
    tail: 'tail → Get-Content -Tail N',
    head: 'head → Get-Content -TotalCount N',
    sed: 'sed → Select-String / ForEach-Object { $_ -replace \'a\',\'b\' }',
    awk: 'awk → Select-String / ForEach-Object { ($_ -split \'\\s+\')[N] }',
};

export function preflightPowerShellHygiene(command, { shellType, shellName } = {}) {
    const original = String(command || '');
    if (shellType !== 'powershell' || !original.trim()) {
        return { command: original, block: null, note: null };
    }
    // (1) lossless MSYS `/x/…` → `X:\…` rewrite; execution continues.
    const { command: rewritten, changed } = rewriteMsysDrivePaths(original);
    const note = changed
        ? 'note: rewrote MSYS-style `/x/…` absolute path(s) to Windows `X:\\…`.'
        : null;

    // (2) hard-block bash-isms. `powershell.exe` (Windows PS 5.1) lacks `&&`;
    // `pwsh` (PS 7+) supports it, so only legacy PS blocks `&&`.
    const name = String(shellName || '').toLowerCase();
    const isLegacyPS = /powershell/.test(name) && !/pwsh/.test(name);
    const violations = [];
    // Violation kinds drive the bash auto-rescue: a command blocked ONLY for
    // bash syntax can be run in bash unchanged, while a PowerShell-specific
    // violation ($PID reassignment) must stay a hard block.
    const kinds = [];
    // `$PID=` reassignment and `&&` connectors are judged on a quote-masked
    // copy so quoted literals (`echo "a && b"`, `Write-Output '$PID=1'`) and
    // regex/search args are never mistaken for real syntax.
    const masked = maskQuotedRegions(rewritten);

    for (const segment of shellSplitSegments(rewritten)) {
        for (const stage of shellSplitPipelineSegments(segment)) {
            const tokens = stripShellProbeWrappers(shellTokenize(stage) || []);
            if (tokens.length === 0) continue;
            const first = String(tokens[0] || '').toLowerCase().replace(/^.*[\\/]/, '');
            if (POWERSHELL_BASHISM_HINTS[first]) {
                violations.push(`\`${first}\` is a Unix command: ${POWERSHELL_BASHISM_HINTS[first]}`);
                kinds.push('bashism');
            }
        }
    }
    if (/\$PID\s*=(?!=)/i.test(masked)) {
        violations.push('`$PID` is a reserved PowerShell automatic variable — do not reassign it (use a different name).');
        kinds.push('powershell-only');
    }
    if (isLegacyPS && /(?:^|[^&])&&(?:[^&]|$)/.test(masked)) {
        violations.push('`&&` is not supported in Windows PowerShell 5.1 — use `;` to sequence or issue separate calls.');
        kinds.push('bashism');
    }

    if (violations.length > 0) {
        const hints = [...new Set(violations)];
        return {
            command: rewritten,
            note,
            // The MSYS path rewrite is a PowerShell-targeted normalisation, so
            // a bash rescue must re-run the ORIGINAL text.
            original,
            bashOnly: kinds.length > 0 && kinds.every((kind) => kind === 'bashism'),
            block: `PowerShell preflight blocked this command (bash syntax on a PowerShell host). Fix and retry:\n- ${hints.join('\n- ')}`,
        };
    }
    return { command: rewritten, note, block: null };
}

// PowerShell-only constructs. Used to decide whether a command the PowerShell
// preflight blocked for bash syntax can simply be RUN in bash: only a command
// with zero PowerShell-specific syntax qualifies, so a mixed script (bash
// pipes plus `$env:`/cmdlets/`2>$null`) stays a hard block instead of being
// silently rerouted into a shell that would mangle it. Deliberately
// over-inclusive — a false positive only declines the rescue.
const POWERSHELL_ONLY_SYNTAX = [
    /\$(?:null|true|false|env:|_\b|args\b|host\b|profile\b|pwd\b|psversiontable\b|psscriptroot\b|lastexitcode\b|erroractionpreference\b)/i,
    /\$[A-Za-z_]\w*\s*=/,
    /\b(?:get|set|new|remove|select|where|foreach|invoke|out|write|start|stop|test|measure|sort|join|split|convert|import|export|add|copy|move|rename|resolve|compare|clear|push|pop)-[A-Za-z]+\b/i,
    /\[[A-Za-z_][\w.]*\]::/,
    /(?:^|\s)-(?:eq|ne|gt|lt|ge|le|match|notmatch|like|notlike|contains|replace|not|and|or|is|as|ErrorAction|Recurse|Force|Encoding|TotalCount|Tail|Pattern|Path|LiteralPath)\b/,
    /2>\s*\$/,
    /\|\s*[%?]\s*\{/,
    /@['"][\s\S]*?['"]@/,
    /`\s*$/m,
];
export function hasPowerShellOnlySyntax(command) {
    const text = String(command || '');
    if (!text.trim()) return false;
    return POWERSHELL_ONLY_SYNTAX.some((pattern) => pattern.test(text));
}

// ── Inline-script hoisting ──────────────────────────────────────────────────
// `node -e "<body>"` / `python -c "<body>"` hand the script through the host
// shell's quoting layer, where nested quotes and escapes are the measured top
// cause of inline-script failures. When the body is quote-LITERAL (the shell
// would pass it through byte for byte) the same run is expressible as a file
// invocation, which has no quoting layer at all — so the failure cannot occur.
//
// The transform is refused whenever file semantics would differ from `-e`:
//   - a body with $, backtick or a backslash escape (the shell WOULD rewrite it);
//   - anything resolved relative to the script (relative require/import,
//     import.meta, __dirname/__filename);
//   - a body that reads process.argv[1] (undefined under -e, a path in a file).
const INLINE_SCRIPT_RE = /\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+"((?:[^"\\]|\\.)*)"/;
const INLINE_UNSAFE_BODY = /[$`\\]/;
const INLINE_FILE_RELATIVE = /(?:require|import)\s*\(\s*['"]\.{1,2}\/|from\s+['"]\.{1,2}\/|import\.meta|__dirname|__filename|argv\s*\[\s*1\s*\]/;
const WINDOWS_INLINE_COMMAND_FILE_THRESHOLD = 24_000;
const LONG_INLINE_SCRIPT_RE = /\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')/i;

export function planInlineScriptHoist(command) {
    const text = String(command || '');
    if (!text.trim()) return null;
    const match = text.match(INLINE_SCRIPT_RE);
    if (!match) return null;
    const [whole, exe, rawFlags, , body] = match;
    if (INLINE_UNSAFE_BODY.test(body)) return null;
    if (INLINE_FILE_RELATIVE.test(body)) return null;
    const flags = String(rawFlags || '');
    const isNode = /^node/i.test(exe);
    const esm = /--input-type=module/.test(flags);
    const extension = isNode ? (esm ? '.mjs' : '.cjs') : '.py';
    // `--input-type` only describes an inline body; the extension carries the
    // module kind for a file, so the flag is dropped with the body.
    const keptFlags = flags.replace(/\s+--input-type=\w+/g, '');
    return {
        exe,
        extension,
        body,
        replace: (filePath) => text.replace(whole, `${exe}${keptFlags} "${filePath}"`),
    };
}

// CreateProcess caps every native child command line near 32K UTF-16 code
// units. Wrapping only the outer shell is insufficient: that shell would still
// spawn `node -e <huge body>` and hit the same limit. Extract the body itself
// into a script file and replace only that invocation, preserving any
// surrounding shell sequencing while the native child receives a short path.
export function planLongInlineScriptFileTransport(command, {
    platform = process.platform,
    shellType = 'powershell',
} = {}) {
    const text = String(command || '');
    if (platform !== 'win32' || text.length < WINDOWS_INLINE_COMMAND_FILE_THRESHOLD) return null;
    const match = text.match(LONG_INLINE_SCRIPT_RE);
    if (!match) return null;
    const [whole, exe, rawFlags, , doubleBody, singleBody] = match;
    const flags = String(rawFlags || '');
    const isNode = /^node/i.test(exe);
    const esm = /--input-type=module/.test(flags);
    const extension = isNode ? (esm ? '.mjs' : '.cjs') : '.py';
    const keptFlags = flags.replace(/\s+--input-type=\w+/g, '');
    let body = doubleBody;
    if (body === undefined) {
        body = String(singleBody || '');
        body = String(shellType || '').toLowerCase() === 'powershell'
            ? body.replace(/''/g, "'")
            : body.replace(/''/g, '');
    }
    return {
        command: text,
        extension,
        body,
        replace(filePath) {
            const normalized = String(filePath || '').replace(/\\/g, '/');
            return text.replace(whole, `${exe}${keptFlags} "${normalized}"`);
        },
    };
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

// Shell interception: patch-trained models type `apply_patch <<'EOF' … EOF`
// INTO THE SHELL. No
// such binary exists here, so the invocation is extracted and routed to the
// internal apply_patch engine instead of dying as "command not found".
// Returns null when the command is not an apply_patch invocation, { patch }
// when one was extracted, or { error } for a recognized-but-malformed call.
export function extractShellApplyPatchInvocation(command) {
    let cmd = String(command || '').trim();
    if (!cmd) return null;
    // Unwrap one `bash|sh|zsh -lc '<script>'` / `-c "<script>"` layer.
    const wrap = /^(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd);
    if (wrap) cmd = wrap[2].trim();
    // A bare patch pasted into the shell (implicit invocation) is
    // unambiguous — route it to the engine directly.
    if (cmd.startsWith('*** Begin Patch')) return { patch: cmd };
    if (!/^apply_patch(?:\s|$)/.test(cmd)) return null;
    const rest = cmd.slice('apply_patch'.length).trim();
    // Heredoc form: apply_patch <<'EOF' \n <patch> \n EOF
    const heredoc = /^<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*)$/.exec(rest);
    if (heredoc) {
        const terminator = heredoc[2];
        const lines = heredoc[3].split('\n');
        const endIdx = lines.findIndex((l) => l.trim() === terminator);
        const patch = (endIdx === -1 ? lines : lines.slice(0, endIdx)).join('\n').trim();
        if (patch) return { patch };
        return { error: 'apply_patch heredoc contained no patch body' };
    }
    // Single-argument form: apply_patch '<patch>' / "<patch>" / bare.
    if (rest) {
        const q = rest[0];
        let patch = rest;
        if ((q === "'" || q === '"') && rest.length >= 2 && rest.endsWith(q)) {
            patch = rest.slice(1, -1);
            if (q === '"') patch = patch.replace(/\\([\\"$`])/g, '$1');
            else patch = patch.replace(/'\\''/g, "'");
        }
        patch = patch.trim();
        if (patch.startsWith('*** Begin Patch')) return { patch };
        return { error: 'apply_patch argument did not contain a V4A patch (expected "*** Begin Patch")' };
    }
    return { error: 'apply_patch requires the patch text (heredoc or single argument)' };
}

// ---------------------------------------------------------------------------
// Filter-swallow rescue (PowerShell one-shot path). Measured 2026-08: ~37
// failures/14d were `<producer> 2>&1 | Select-String … | Select-Object …`
// pipelines where the producer failed but the trailing filters matched
// nothing — the model saw `[exit code: 1]` + `(no output)` and burned turns
// re-running with different capture tricks. Plan: insert a Tee-Object spill
// of the UNFILTERED producer stream so a failing run can attach the original
// tail in the SAME call. Applies only to the exactly-recognized shape; any
// ambiguity returns null and the original command runs untouched:
//   - single-line command, no backticks / $( ) / ${ } / here-strings / procsub
//   - no existing Tee-Object
//   - last top-level segment is a byte-exact suffix of the command
//   - >= 2 pipeline stages; stage 0 is NOT a pure filter; stages 1..n are ALL
//     known pure pass-through filters; no stage redirects to a file
// Tee-Object passes objects through unchanged and does not touch
// $LASTEXITCODE, so success-path output and exit semantics are identical.
const _PS_PURE_FILTER_HEADS = new Set([
    'select-string', 'sls', 'select-object', 'select',
    'where-object', 'where', 'foreach-object', '%', 'findstr',
]);
const _TEE_AMBIGUOUS_RE = /[`]|\$\(|\$\{|@['"]|<\(|>\(/;

function _teeStageHead(tokens) {
    return String(tokens?.[0] || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
}

function _stageRedirectsToFile(tokens) {
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '>' || tokens[i] === '>>') {
            const next = String(tokens[i + 1] || '');
            if (!next.startsWith('&')) return true; // `> file` (2>&1-style stays allowed)
        }
    }
    return false;
}

export function buildPowerShellFilterTeePlan(command) {
    const cmd = String(command || '');
    if (!cmd.trim()) return null;
    if (/\r|\n/.test(cmd)) return null;
    if (/tee-object/i.test(cmd)) return null;
    if (_TEE_AMBIGUOUS_RE.test(cmd)) return null;
    const segments = shellSplitSegments(cmd);
    if (segments.length === 0) return null;
    const last = segments[segments.length - 1];
    const trimmed = cmd.trimEnd();
    if (!trimmed.endsWith(last)) return null;
    const stages = shellSplitPipelineSegments(last);
    if (stages.length < 2) return null;
    const tokenized = [];
    for (const stage of stages) {
        const tokens = shellTokenize(stage);
        if (!tokens || tokens.length === 0) return null;
        if (_stageRedirectsToFile(tokens)) return null;
        const stripped = stripShellProbeWrappers(tokens);
        if (stripped.length === 0) return null;
        tokenized.push(stripped);
    }
    if (_PS_PURE_FILTER_HEADS.has(_teeStageHead(tokenized[0]))) return null;
    for (let i = 1; i < tokenized.length; i++) {
        if (!_PS_PURE_FILTER_HEADS.has(_teeStageHead(tokenized[i]))) return null;
    }
    const teePath = join(tmpdir(), `mixdog-tee-${randomUUID().slice(0, 8)}.log`);
    if (teePath.includes("'")) return null;
    const head = trimmed.slice(0, trimmed.length - last.length);
    const rewritten = `${head}${stages[0]} | Tee-Object -FilePath '${teePath}' | ${stages.slice(1).join(' | ')}`;
    return { command: rewritten, teePath };
}

// Read the tail of a tee spill file (BOM-sniffed: Windows PowerShell 5.1
// writes UTF-16LE, pwsh 7 writes UTF-8) and ALWAYS delete the file. Returns
// null when the file is missing/empty/unreadable.
export function consumeFilterTeeCapture(teePath, { maxBytes = 16384 } = {}) {
    let out = null;
    try {
        const st = statSync(teePath);
        if (st.size > 0) {
            const fd = openSync(teePath, 'r');
            try {
                const bom = Buffer.alloc(2);
                readSync(fd, bom, 0, 2, 0);
                const utf16 = bom[0] === 0xff && bom[1] === 0xfe;
                let start = Math.max(0, st.size - maxBytes);
                if (utf16 && start % 2 === 1) start += 1;
                const len = st.size - start;
                const buf = Buffer.alloc(len);
                readSync(fd, buf, 0, len, start);
                out = buf.toString(utf16 ? 'utf16le' : 'utf8');
                if (start === 0 && out.charCodeAt(0) === 0xfeff) out = out.slice(1);
            } finally {
                closeSync(fd);
            }
        }
    } catch {
        out = null;
    }
    try { unlinkSync(teePath); } catch { /* best-effort cleanup */ }
    return out && out.trim() ? out : null;
}
