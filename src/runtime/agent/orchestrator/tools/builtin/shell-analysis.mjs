import { closeSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { assertPathReachable, assertPathsReachable } from './fs-reachability.mjs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { Script } from 'node:vm';
import { cwdRelativePath, normalizeInputPath, normalizeOutputPath, resolveAgainstCwd } from './path-utils.mjs';
import { codeMask } from './bash-tool/bashism-rewrite.mjs';

// Hard-block patterns live exclusively in ../shell-policy.mjs (BLOCKED_PATTERNS /
// isBlockedCommand). This lighter detector only classifies cache invalidation
// scope for commands that already passed policy.
const SHELL_MUTATION_PATTERN =
  /(?:^|[;&|\n]\s*)(?:touch|mkdir|mktemp|rm|rmdir|mv|cp|install|ln|chmod|chown|truncate|dd|sed\s+-i|perl\s+-pi|npm\s+(?:install|i|ci|uninstall)|pnpm\s+(?:install|i|add|remove|update|up)|yarn\s+(?:install|add|remove|up)|bun\s+(?:install|add|remove|update|up)|pip(?:3)?\s+install|python(?:3)?\s+-m\s+pip\s+install|git\s+(?:checkout|switch|restore|clean|apply|am|cherry-pick|merge|rebase|stash|pull|reset)|cargo\s+(?:build|install|clean)|go\s+(?:build|install|generate)|make|cmake)\b/i;
// `source` / `.` removed from read-only set: sourced scripts can mutate
// files, cwd, env, and persistent-shell state arbitrarily. Without static
// analysis of the target script, treating these as read-only would skip
// cache invalidation that the sourced script's mutations require. Classify
// as unknown/global mutation by falling through to the default branch.
const SHELL_READ_ONLY_SEGMENT_RE =
  /^(?:cd|pwd|echo|printf|env|printenv|set|unset|export|alias|unalias|type|which|whereis|ls|dir|cat|head|tail|wc|grep|rg|find|git\s+(?:status|diff|show|log|rev-parse|branch|remote|ls-files)|stat|readlink|realpath|basename|dirname|sort|uniq|cut|sed\s+-n|awk|ps|whoami|uname|date|true|false|test|\[)\b/i;
const SHELL_GLOBAL_MUTATORS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'python',
  'python3',
  'git',
  'cargo',
  'go',
  'make',
  'cmake',
  'dd',
]);

// Whether a backslash escapes the character after it: anything outside quotes,
// only `"` or `\` inside double quotes, never inside single quotes (`'C:\'` is
// a closed string, not an escaped quote).
function startsEscape(quote, next) {
  if (quote === "'") return false;
  return quote === '"' ? next === '"' || next === '\\' : true;
}

export function shellSplitSegments(command) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && startsEscape(quote, command[i + 1])) {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
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
  const push = () => {
    if (current !== '') tokens.push(current);
    current = '';
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '\\' && quote !== "'") {
      // A backslash escapes only what a shell would need it for. Before an
      // ordinary character it is a path separator (`C:\Users\x`, `\\server\s`),
      // which dropping would turn into a different, nonexistent path.
      const next = segment[i + 1];
      const escapes = quote === '"' ? next === '"' : next !== undefined && /[\s"'$`;&|<>()*?]/.test(next);
      if (!escapes) {
        current += ch;
        continue;
      }
      current += next;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
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
  return lower === '>' || lower === '>>' || /^(?:\d+>>?|\d+>|&>>?|&>)$/.test(lower);
}

function isShellInputRedirectToken(tok) {
  const lower = String(tok || '').toLowerCase();
  return lower === '<' || lower === '<<' || /^(?:\d*<<?)$/.test(lower);
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
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
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
  let escaped = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && startsEscape(quote, segment[i + 1])) {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
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
    if (!tok) {
      idx++;
      continue;
    }
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

// Short flags are case-sensitive: grep -A takes a line count while -a does not.
function shellOptionConsumesValue(cmd, tok) {
  const flag = String(tok || '');
  if (cmd === 'grep' || cmd === 'rg') {
    if (
      [
        '-e',
        '-f',
        '-g',
        '--glob',
        '-A',
        '-B',
        '-C',
        '--context',
        '-t',
        '--type',
        '--type-add',
        '-m',
        '--max-count',
      ].includes(flag)
    )
      return true;
    if (/^-[AABCegfmt]$/.test(flag)) return true;
  }
  if (cmd === 'sed') {
    if (['-e', '-f'].includes(flag)) return true;
  }
  if (cmd === 'awk') {
    if (['-f', '-F', '-v'].includes(flag)) return true;
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
    if (
      tok === '--count' ||
      tok === '--quiet' ||
      tok === '--silent' ||
      tok === '--files-with-matches' ||
      tok === '--files-without-match'
    )
      return true;
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
    return { kind: 'relative-unknown' };
  }
  return { kind: 'path', path: resolveAgainstCwd(normalized, cwd) };
}

function extractShellProbeTargets(tokens, cwd, { minIndex = 1, cwdKnown = true } = {}) {
  const out = { paths: [], skippedRelativeUnknown: false };
  const record = (info) => {
    if (info.kind === 'path') out.paths.push(info.path);
    else if (info.kind === 'relative-unknown') out.skippedRelativeUnknown = true;
  };
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
      record(classifyShellProbeToken(tokens[i + 1], cwd, { cwdKnown }));
      i++;
      continue;
    }
    const outputInline = /^(?:\d+>>?|\d+>|&>>?|&>)(.+)?$/i.exec(tok);
    if (outputInline) continue;
    const inputInline = /^(?:\d*<<?)(.+)$/i.exec(tok);
    if (inputInline) {
      record(classifyShellProbeToken(inputInline[1], cwd, { cwdKnown }));
      continue;
    }
    record(classifyShellProbeToken(tok, cwd, { cwdKnown }));
  }
  return out;
}

// Index just past a sed/awk program: options (and their values) are skipped,
// `--` ends them, and the first non-option token is the script itself.
function indexAfterScriptOperand(cmd, tokens) {
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) {
      i++;
      continue;
    }
    if (tok === '--') return i + 1;
    if (tok.startsWith('-')) {
      i += shellOptionConsumesValue(cmd, tok) ? 2 : 1;
      continue;
    }
    return i + 1;
  }
  return i;
}

function extractShellProbePaths(tokens, cwd, { cwdKnown = true } = {}) {
  const cmd = String(tokens?.[0] || '').toLowerCase();
  if (!cmd) return { paths: [], skippedRelativeUnknown: false, cmd: '' };
  if (LARGE_FILE_READ_CMDS.has(cmd)) {
    return { ...extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
  }
  if (cmd === 'head' || cmd === 'tail') {
    if (isHeadTailBounded(tokens)) return { paths: [], skippedRelativeUnknown: false, cmd };
    return { ...extractShellProbeTargets(tokens, cwd, { minIndex: 1, cwdKnown }), cmd };
  }
  if (cmd === 'grep' || cmd === 'rg') {
    if (isGrepBounded(tokens)) return { paths: [], skippedRelativeUnknown: false, cmd };
    let i = 1;
    let sawPattern = false;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (!tok) {
        i++;
        continue;
      }
      if (!sawPattern) {
        if (tok === '--') {
          i++;
          continue;
        }
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
  if (cmd === 'sed' || cmd === 'awk') {
    const bounded = cmd === 'sed' ? isSedBounded(tokens) : isAwkBounded(tokens);
    if (bounded) return { paths: [], skippedRelativeUnknown: false, cmd };
    // Remaining path-like args after the program are candidate target files.
    const minIndex = indexAfterScriptOperand(cmd, tokens);
    return { ...extractShellProbeTargets(tokens, cwd, { minIndex, cwdKnown }), cmd };
  }
  return { paths: [], skippedRelativeUnknown: false, cmd };
}

function buildLargeShellFileProbeMessage(fullPath, sizeBytes, cmd, cwd) {
  const kb = Math.round(sizeBytes / 1024);
  const display = normalizeOutputPath(cwdRelativePath(fullPath, cwd));
  return `large-file shell probe blocked: \`${cmd}\` is targeting \`${display}\` (${kb} KB).`;
}

// PowerShell hygiene preflight (Windows PS host only). Two behaviors:
//   (1) LOSSLESS auto-substitution: MSYS/Git-Bash `/x/…` absolute paths (x is a
//       single drive letter) are impossible on Windows, so they are rewritten
//       to `X:\…` and execution continues.
//   (2) HARD BLOCK + hint: Unix-only commands used as the first token of any
//       pipeline stage (grep/egrep/fgrep, tail, head, sed, awk), `$PID`
//       reassignment, and `&&` on Windows PowerShell 5.1 are rejected with a
//       PowerShell-native correction hint so the agent retries valid syntax.
// POSIX shells are a strict no-op.
const MSYS_ABS_PATH_RE = /(^|[\s"'=,(])\/([A-Za-z])\/([^\s"'`|&;<>()]*)/g;

// Replace every character that lives inside a single/double-quoted string with a
// filler ('\0'), keeping the string length 1:1 so match offsets stay aligned.
// Quote delimiters are preserved (they never match /x/, &&, or $PID=), and a
// backtick inside double quotes escapes the next char (PS escape). Callers run
// the drive-rewrite and bash-ism regexes against the mask so quoted literals /
// regex patterns are never treated as real path tokens or connectors.
function maskQuotedRegions(command) {
  // The full PowerShell tokeniser first: it knows here-strings, comments and
  // doubled quotes, which a bare quote-pair scan reads wrongly (an apostrophe
  // inside `@'…'@` or a `# don't` comment flips every region after it). It
  // declines on text it cannot tokenise with confidence; the pair scan below
  // then keeps the previous behaviour.
  const codeOnly = codeMask(command);
  if (codeOnly) {
    let masked = '';
    for (let i = 0; i < command.length; i++) masked += codeOnly[i] ? command[i] : '\0';
    return masked;
  }
  const FILL = '\0';
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      out += FILL;
      escaped = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === '`') {
        out += FILL;
        escaped = true;
        continue;
      }
      if (ch === quote) {
        out += ch;
        quote = null;
        continue;
      }
      out += FILL;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
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
  // Matches occur only in unquoted regions (quoted chars are '\0' in `mask`),
  // so the captured groups hold the real, unmasked path text.
  for (const m of mask.matchAll(re)) {
    const [full, pre, drive, rest] = m;
    out += src.slice(last, m.index);
    out += `${pre}${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
    last = m.index + full.length;
    changed = true;
  }
  out += src.slice(last);
  return { command: changed ? out : src, changed };
}

export function preflightPowerShellHygiene(command, { shellType, shellName } = {}) {
  const original = String(command || '');
  if (shellType !== 'powershell' || !original.trim()) {
    return { command: original, block: null, note: null };
  }
  // (1) lossless MSYS `/x/…` → `X:\…` rewrite; execution continues.
  const { command: rewritten, changed } = rewriteMsysDrivePaths(original);
  const note = changed ? 'note: rewrote MSYS-style `/x/…` absolute path(s) to Windows `X:\\…`.' : null;

  // (2) Reject invalid PowerShell syntax, not command names. Dedicated-tool
  // routing is model-facing guidance, not an execution gate. Windows PS 5.1
  // lacks `&&`; PS 7+ supports it, so only legacy PS blocks `&&`.
  const name = String(shellName || '').toLowerCase();
  const isLegacyPS = /powershell/.test(name) && !/pwsh/.test(name);
  const violations = [];
  // `$PID=` reassignment and `&&` connectors are judged on a quote-masked
  // copy so quoted literals (`echo "a && b"`, `Write-Output '$PID=1'`) and
  // regex/search args are never mistaken for real syntax.
  const masked = maskQuotedRegions(rewritten);

  if (/\$PID\s*=(?!=)/i.test(masked)) {
    violations.push('`$PID` is a reserved PowerShell automatic variable — do not reassign it (use a different name).');
  }
  if (isLegacyPS && /(?:^|[^&])&&(?:[^&]|$)/.test(masked)) {
    violations.push('`&&` is not supported in Windows PowerShell 5.1 — use `;` to sequence or issue separate calls.');
  }

  if (violations.length > 0) {
    const hints = [...new Set(violations)];
    return {
      command: rewritten,
      note,
      block: `PowerShell preflight blocked this command (invalid PowerShell syntax). Fix and retry:\n- ${hints.join('\n- ')}`,
    };
  }
  return { command: rewritten, note, block: null };
}

// PowerShell-only constructs. Used to decide whether a command carries syntax
// that REQUIRES a PowerShell host: with zero PowerShell-specific syntax the
// command can be spawned directly (see shell-direct-exe), while `$env:`,
// cmdlets, `2>$null` and here-strings must keep their interpreter.
// Deliberately over-inclusive — a false positive only declines the direct
// spawn and falls back to the shell.
const POWERSHELL_ONLY_SYNTAX = [
  /\$(?:null|true|false|env:|_\b|args\b|host\b|profile\b|pwd\b|psversiontable\b|psscriptroot\b|lastexitcode\b|erroractionpreference\b)/i,
  /\$[A-Za-z_]\w*\s*=/,
  // A verb joined to the previous character by a path/word char (`mixdog-test-scratch`, `a/test-x`) is part of a
  // path or name, not a cmdlet.
  /(?<![\w\-./\\:])(?:get|set|new|remove|select|where|foreach|invoke|out|write|start|stop|test|measure|sort|join|split|convert|import|export|add|copy|move|rename|resolve|compare|clear|push|pop)-[A-Za-z]+\b/i,
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
//     import.meta, __dirname/__filename, python __file__ / sys.path[0]);
//   - a body that reads its own invocation identity: process.argv[1]
//     (undefined under -e, a path in a file), sys.argv[0] ('-c' under -c, the
//     script path in a file), require.main / module.filename (undefined vs the
//     module record). Reading any of them makes the two forms observably
//     different runs, not the same run with a different transport.
const INLINE_SCRIPT_RE =
  /\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+"((?:[^"\\]|\\.)*)"/;
const INLINE_UNSAFE_BODY = /[$`\\]/;
// What may follow the closing quote for the run to be the same as a file run:
// end of command or a shell operator/newline. Anything else is either more
// argument text (`""` is an escaped quote in PowerShell, and adjacent quoted
// strings concatenate in bash, so the body did not end at that quote) or script
// arguments, which `-e` and a file run number differently in process.argv.
const INLINE_TRAILING_OK = /^[ \t]*(?:$|[\r\n|;&)<>]|\d+>)/;
const INLINE_FILE_RELATIVE =
  /(?:require|import)\s*\(\s*['"]\.{1,2}\/|from\s+['"]\.{1,2}\/|import\.meta|__dirname|__filename|__file__|require\.main|module\.(?:filename|parent)|sys\.argv\s*\[\s*0\s*\]|sys\.path\s*\[\s*0\s*\]|argv\s*\[\s*1\s*\]/;
const WINDOWS_INLINE_COMMAND_FILE_THRESHOLD = 24_000;
const LONG_INLINE_SCRIPT_RE =
  /\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')/i;
const POWERSHELL_FILE_SEMANTIC_RE = /\$(?:PSScriptRoot|PSCommandPath|MyInvocation)\b|^\s*(?:param\s*\(|#requires\b)/im;

// `node -e` resolves a package name from the working directory; a hoisted file
// resolves it from the temp directory it lives in, where no node_modules is.
// Any package specifier (not a Node builtin), require.resolve, or a specifier
// that is not a string literal therefore keeps the -e form.
const NODE_SPECIFIER_RE = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)['"]([^'"]+)['"]/g;
const NODE_LOADER_CALL_RE = /\b(?:require|import)\s*\(/g;
const NODE_LITERAL_LOADER_CALL_RE = /\b(?:require|import)\s*\(\s*['"][^'"]+['"]/g;
function importsPackage(body) {
  if (/\brequire\s*\.\s*resolve\b/.test(body)) return true;
  if ((body.match(NODE_LOADER_CALL_RE) || []).length !== (body.match(NODE_LITERAL_LOADER_CALL_RE) || []).length) {
    return true;
  }
  for (const [, specifier] of body.matchAll(NODE_SPECIFIER_RE)) {
    if (!isBuiltin(specifier)) return true;
  }
  return false;
}

/** File extension a hoisted inline script gets: Python, or the Node module kind the flags declare. */
function inlineScriptExtension(isNode, esm) {
  if (!isNode) return '.py';
  return esm ? '.mjs' : '.cjs';
}

// The hoisted file's extension and the interpreter flags that survive: the
// `--input-type` flag only describes an inline body; the extension carries
// the module kind for a file, so the flag is dropped with the body.
function inlineScriptFileShape(exe, rawFlags) {
  const flags = String(rawFlags || '');
  const extension = inlineScriptExtension(/^node/i.test(exe), /--input-type=module/.test(flags));
  return { extension, keptFlags: flags.replace(/\s+--input-type=\w+/g, '') };
}

// `python -c` puts the working directory first on sys.path; a script file puts
// its own (temp) directory there. Only a body whose every import is a standard
// library module resolves identically from both, so any other import — a
// project-local module, a relative import, a dynamic import — keeps `-c`.
const PYTHON_STDLIB = new Set(
  `__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath numbers opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`.split(
    ' '
  )
);
const PYTHON_DYNAMIC_IMPORT = /\b(?:__import__|importlib|exec|eval|compile|runpy)\b/;
function pythonImportsOutsideStdlib(body) {
  if (PYTHON_DYNAMIC_IMPORT.test(body)) return true;
  for (const [, module] of body.matchAll(/(?:^|[;:\n])[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/g)) {
    if (module.startsWith('.') || !PYTHON_STDLIB.has(module.split('.')[0])) return true;
  }
  for (const [, list] of body.matchAll(/(?:^|[;:\n])[ \t]*import[ \t]+([^;\n]+)/g)) {
    for (const part of list.split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
        .split('.')[0];
      if (name && !PYTHON_STDLIB.has(name)) return true;
    }
  }
  return false;
}

// `node -e` accepts ESM syntax and top-level `await` (Node's syntax detection);
// the `.cjs` file a hoist writes does not, so a body using either stays inline.
// An `await` is top-level exactly when the body no longer compiles as CommonJS.
const NODE_ESM_SYNTAX = /(?:^|[;{}\n])[ \t]*(?:import[ \t]*[\w$*{'"]|export[ \t])/;
function nodeBodyNeedsModuleSyntax(body) {
  if (NODE_ESM_SYNTAX.test(body)) return true;
  if (!/\bawait\b/.test(body)) return false;
  try {
    new Script(`(function (exports, require, module, __filename, __dirname) {${body}\n})`);
    return false;
  } catch {
    return true;
  }
}

// PowerShell ends a double-quoted string at any typographic double quote and a
// single-quoted one at any typographic single quote.
const POWERSHELL_SMART_DOUBLE = /[\u201C\u201D\u201E\u201F]/;
const POWERSHELL_SMART_SINGLE = /[\u2018\u2019\u201A\u201B]/;

function defaultInlineShellType() {
  return process.platform === 'win32' ? 'powershell' : 'posix';
}

// True when `index` is in live shell code of a POSIX shell: not inside a
// quote, `$'…'`, comment, or a heredoc body (any heredoc earlier in the text
// declines, since its body cannot be bounded here).
function posixLiveAt(text, index) {
  let i = 0;
  const skipTo = (end) => {
    if (end < 0 || end >= index) return false;
    i = end + 1;
    return true;
  };
  // The quote that closes a region whose backslashes escape (`"…"`, `$'…'`).
  const closer = (from, quote) => {
    let j = from;
    while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
    return j < text.length ? j : -1;
  };
  while (i < index) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === "'") {
      if (!skipTo(text.indexOf("'", i + 1))) return false;
    } else if (ch === '$' && text[i + 1] === "'") {
      if (!skipTo(closer(i + 2, "'"))) return false;
    } else if (ch === '"') {
      if (!skipTo(closer(i + 1, '"'))) return false;
    } else if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const nl = text.indexOf('\n', i);
      if (nl < 0 || nl >= index) return false;
      i = nl;
    } else if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') return false;
    else i++;
  }
  return true;
}

// A node/python invocation may be turned into a file run only when the shell
// itself runs it: live code (not text inside a string, here-string, comment or
// heredoc) at command position (not an argument of docker/ssh/wsl/ts-node/…,
// which would run the file somewhere that cannot see it).
function isShellInvocationAt(text, index, shellType) {
  if (shellType === 'powershell') {
    if (!codeMask(text)?.[index]) return false;
  } else if (!posixLiveAt(text, index)) {
    return false;
  }
  let start = index;
  while (start > 0 && /[^\s;|&(){}<>'"]/.test(text[start - 1])) start--;
  if (start < index && !/[\\/]$/.test(text.slice(start, index))) return false;
  const before = text.slice(0, start);
  const assignments = /(?:^|[\s;|&(){}])[A-Za-z_]\w*=[^\s;|&(){}]*[ \t]+$/;
  let head = before;
  while (assignments.test(head)) head = head.replace(assignments, (m) => m.match(/^[\s;|&(){}]?/)[0]);
  const trimmed = head.replace(/[ \t]+$/, '');
  if (trimmed === '') return true;
  const last = trimmed.at(-1);
  if (!';|&({\n'.includes(last)) return false;
  // A line continuation joins the next line onto this command's arguments.
  return !(last === '\n' && /[\\`]\r?\n$/.test(trimmed));
}

export function planInlineScriptHoist(command, { shellType = defaultInlineShellType() } = {}) {
  const text = String(command || '');
  if (!text.trim()) return null;
  const match = text.match(INLINE_SCRIPT_RE);
  if (!match) return null;
  const [whole, exe, rawFlags, , body] = match;
  if (INLINE_UNSAFE_BODY.test(body)) return null;
  if (!INLINE_TRAILING_OK.test(text.slice(match.index + whole.length))) return null;
  if (INLINE_FILE_RELATIVE.test(body)) return null;
  if (shellType === 'powershell' && POWERSHELL_SMART_DOUBLE.test(body)) return null;
  const isNode = /^node/i.test(exe);
  if (isNode && importsPackage(body)) return null;
  if (isNode && !/--input-type=module/.test(rawFlags) && nodeBodyNeedsModuleSyntax(body)) return null;
  if (!isNode && pythonImportsOutsideStdlib(body)) return null;
  if (!isShellInvocationAt(text, match.index, shellType)) return null;
  const { extension, keptFlags } = inlineScriptFileShape(exe, rawFlags);
  return {
    exe,
    extension,
    body,
    // Spliced at the match offset, not by searching for its text: an earlier
    // look-alike (`xnode -e "…"`) must not be the one rewritten. Plain
    // concatenation also keeps a path holding `$&` / `$1` from being expanded.
    replace: (filePath) =>
      `${text.slice(0, match.index)}${exe}${keptFlags} "${filePath}"${text.slice(match.index + whole.length)}`,
  };
}

// CreateProcess caps every native child command line near 32K UTF-16 code
// units. Wrapping only the outer shell is insufficient: that shell would still
// spawn `node -e <huge body>` and hit the same limit. Extract the body itself
// into a script file and replace only that invocation, preserving any
// surrounding shell sequencing while the native child receives a short path.
export function planLongInlineScriptFileTransport(
  command,
  { platform = process.platform, shellType = 'powershell' } = {}
) {
  const text = String(command || '');
  if (platform !== 'win32' || text.length < WINDOWS_INLINE_COMMAND_FILE_THRESHOLD) return null;
  const match = text.match(LONG_INLINE_SCRIPT_RE);
  if (!match) return null;
  const [whole, exe, rawFlags, , doubleBody, singleBody] = match;
  const powershell = String(shellType || '').toLowerCase() === 'powershell';
  // The same refusals as the short hoist: text after the closing quote means
  // the body did not end there (or the script has arguments), and the match
  // must be a command the shell itself runs.
  if (!INLINE_TRAILING_OK.test(text.slice(match.index + whole.length))) return null;
  if (!isShellInvocationAt(text, match.index, powershell ? 'powershell' : 'posix')) return null;
  const { extension, keptFlags } = inlineScriptFileShape(exe, rawFlags);
  let body = doubleBody;
  if (body === undefined) {
    body = String(singleBody || '');
    if (powershell && POWERSHELL_SMART_SINGLE.test(body)) return null;
    body = powershell ? body.replace(/''/g, "'") : body.replace(/''/g, '');
  } else if (
    // Inside double quotes the shell rewrites `$…`, backtick and backslash
    // escapes (and PowerShell ends the string at a typographic quote) before
    // the child sees them, so the verbatim body would be a different script.
    /[$`]|\\"/.test(body) ||
    (powershell ? POWERSHELL_SMART_DOUBLE.test(body) : body.includes('\\\\'))
  ) {
    return null;
  }
  return {
    command: text,
    extension,
    body,
    replace(filePath) {
      const normalized = String(filePath || '').replace(/\\/g, '/');
      return `${text.slice(0, match.index)}${exe}${keptFlags} "${normalized}"${text.slice(match.index + whole.length)}`;
    },
  };
}

// Generic oversized PowerShell commands cannot reach powershell.exe on
// Windows because CreateProcess rejects command lines around 32K UTF-16 code
// units. Execute a semantics-safe whole-command script from a short path.
// Script-location/introspection constructs are refused because moving those
// commands into a file would observably change their values.
export function planLongShellScriptFileTransport(
  command,
  { platform = process.platform, shellType = 'powershell' } = {}
) {
  const text = String(command || '');
  if (
    platform !== 'win32' ||
    String(shellType || '').toLowerCase() !== 'powershell' ||
    text.length < WINDOWS_INLINE_COMMAND_FILE_THRESHOLD ||
    POWERSHELL_FILE_SEMANTIC_RE.test(text)
  )
    return null;
  return {
    command: text,
    extension: '.ps1',
    body: text,
    replace(filePath) {
      const escaped = String(filePath || '')
        .replace(/\\/g, '/')
        .replace(/'/g, "''");
      // Evaluated in the host's own scope, not called as a script: `& file.ps1`
      // turns `exit N` into exit code 1 and a failing last command into 0,
      // where the command itself would have ended with N and 1. The trailing
      // statement reads the last command's `$?` the way -Command does.
      return `Invoke-Expression ([System.IO.File]::ReadAllText('${escaped}', [System.Text.Encoding]::UTF8) + "\`n" + '$global:__mixdogLastOk = $?'); if ($global:__mixdogLastOk -eq $false) { exit 1 }`;
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

// Commands whose arguments after the command name are the paths they write.
const SHELL_PATH_ARG_MUTATORS = new Set([
  'touch',
  'mkdir',
  'mktemp',
  'rm',
  'rmdir',
  'chmod',
  'chown',
  'truncate',
  'mv',
  'cp',
  'install',
  'ln',
]);

// find/awk are read-only by default but can delete, exec, or write files.
// Conservative: any such action makes the stage a mutation.
const FIND_MUTATING_FLAG_RE = /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/;
const AWK_MUTATING_PROGRAM_RE = /\bsystem\s*\(|\b(?:print|printf)\b[^;}]*(?:>>?|\|)|\|\s*getline\b/;

function isMutatingFindOrAwk(tokens) {
  const cmd = String(tokens[0] || '').toLowerCase();
  if (cmd === 'find') return tokens.some((tok) => FIND_MUTATING_FLAG_RE.test(String(tok)));
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') {
    return tokens.slice(1).some((tok) => AWK_MUTATING_PROGRAM_RE.test(String(tok)));
  }
  return false;
}

export async function analyzeShellCommandEffects(command, cwd) {
  const text = String(command || '').trim();
  let localCwd = resolve(cwd || process.cwd());
  if (!text) return { mutationMode: 'none', paths: [], finalCwd: localCwd };
  const hasRedirect = /(?:^|[^0-9&<>])>>?(?!&)/.test(text) || /\btee\b/.test(text);
  // Classification is per PIPELINE STAGE, never per segment. A segment's
  // first command decided the whole segment before, so a read-only producer
  // (`rg … | xargs rm`, `cat … | tee f`) hid every mutator behind it and the
  // caches were left holding pre-command state.
  const stages = [];
  for (const segment of shellSplitSegments(text)) {
    for (const stage of shellSplitPipelineSegments(segment)) stages.push(stage);
  }
  if (!SHELL_MUTATION_PATTERN.test(text) && !hasRedirect) {
    const readOnly = stages.every((stage) => {
      const tokens = stripShellProbeWrappers(shellTokenize(stage) || []);
      if (tokens.length === 0) return true;
      const joined = tokens.join(' ');
      if (/^cd\b/i.test(joined)) {
        const target = tokens[1] || process.env.HOME || process.env.USERPROFILE || localCwd;
        const resolved = resolveShellPathToken(target, localCwd);
        if (resolved) localCwd = resolved;
        return true;
      }
      if (isMutatingFindOrAwk(tokens)) return false;
      return SHELL_READ_ONLY_SEGMENT_RE.test(joined);
    });
    return { mutationMode: readOnly ? 'none' : 'global', paths: [], finalCwd: localCwd };
  }
  const paths = new Set();
  let global = false;
  for (const stage of stages) {
    const parsed = shellTokenize(stage);
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
    if (isMutatingFindOrAwk(tokens)) {
      global = true;
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
      if (segPaths.length === 0) {
        global = true;
        continue;
      }
      for (const p of segPaths) paths.add(p);
      continue;
    }
    if (SHELL_GLOBAL_MUTATORS.has(cmd)) {
      if (cmd === 'git') {
        const sub = String(tokens[1] || '').toLowerCase();
        if (['status', 'diff', 'show', 'log', 'rev-parse', 'branch', 'remote', 'ls-files'].includes(sub)) continue;
      }
      // A python run can write anywhere (alone it already classifies as global
      // below the read-only check), so it never narrows a chain's effects.
      global = true;
      continue;
    }
    // tee and >/>> segments were handled above, so only argument-taking
    // mutators remain.
    let segmentPaths = [];
    if (SHELL_PATH_ARG_MUTATORS.has(cmd) || (cmd === 'perl' && tokens.some((t) => /^-p/i.test(t) || /^-i/i.test(t)))) {
      segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: 1 });
    } else if (cmd === 'sed' && tokens.includes('-i')) {
      segmentPaths = extractShellPathArgs(tokens, localCwd, { minIndex: tokens.lastIndexOf('-i') + 1 });
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
// Tee-Object passes objects through unchanged. The producer runs in a child
// scriptblock with a reference cell that captures its native exit immediately;
// the outer script exits with that value after filters finish, so cmdlets (or
// a native findstr stage) cannot replace the producer's status.
const _PS_PURE_FILTER_HEADS = new Set([
  'select-string',
  'sls',
  'select-object',
  'select',
  'where-object',
  'where',
  'foreach-object',
  '%',
  'findstr',
]);
const _TEE_AMBIGUOUS_RE = /[`]|\$\(|\$\{|@['"]|<\(|>\(/;

function _teeStageHead(tokens) {
  return String(tokens?.[0] || '')
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');
}

// The segment/pipeline splitters are not grouping-aware, so a `;` or `|`
// inside (), {} or [] (e.g. `(a | % { $_ }) -join ','`, `try { a | sls x }`)
// would be cut mid-group and the rewrite would break the parse. Only rewrite
// when the head, the last segment and every stage close their own groups.
function _groupingBalanced(text) {
  const pairs = { ')': '(', '}': '{', ']': '[' };
  const stack = [];
  let quote = null;
  let escaped = false;
  for (const ch of String(text || '')) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') stack.push(ch);
    else if (pairs[ch] && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0 && quote === null;
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
  if (!_groupingBalanced(last) || !_groupingBalanced(trimmed.slice(0, trimmed.length - last.length))) return null;
  // Behind `&&` / `||` the rewrite's leading assignment is not a pipeline (a
  // parse error), and it would run the producer even when `||` skips it.
  if (/(?:&&|\|\|)\s*$/.test(trimmed.slice(0, trimmed.length - last.length))) return null;
  const stages = shellSplitPipelineSegments(last);
  if (stages.length < 2) return null;
  const tokenized = [];
  for (const stage of stages) {
    if (!_groupingBalanced(stage)) return null;
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
  const token = randomUUID().replaceAll('-', '').slice(0, 8);
  const teePath = join(tmpdir(), `mixdog-tee-${token}.log`);
  if (teePath.includes("'")) return null;
  const head = trimmed.slice(0, trimmed.length - last.length);
  const exitRef = `$__mixdogProducerExit${token}`;
  const producer = `& { $global:LASTEXITCODE = 0; ${stages[0]}; ${exitRef}.Value = $global:LASTEXITCODE }`;
  const rewritten = `${head}${exitRef} = [ref]0; ${producer} | Tee-Object -FilePath '${teePath}' | ${stages.slice(1).join(' | ')}; exit ${exitRef}.Value`;
  return { command: rewritten, teePath };
}

// Read the tail of a tee spill file (BOM-sniffed: Windows PowerShell 5.1
// writes UTF-16LE, pwsh 7 writes UTF-8). Returns null when the file is
// missing/empty/unreadable.
export function readFilterTeeCapture(teePath, { maxBytes = 16384 } = {}) {
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
  return out?.trim() ? out : null;
}

// The tail of a tee spill file, which is then ALWAYS deleted.
export function consumeFilterTeeCapture(teePath, options) {
  const out = readFilterTeeCapture(teePath, options);
  try {
    unlinkSync(teePath);
  } catch {
    /* best-effort cleanup */
  }
  return out;
}
