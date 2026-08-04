'use strict';

import { isDangerousDeleteTarget as _isDangerousDeleteTarget } from './shell-policy-danger-target.mjs';
export { isDangerousDeleteTarget } from './shell-policy-danger-target.mjs';
// Shell execution security policy — shared constants used by both
// destructive-warning.mjs (heuristic classifier) and bash-session.mjs
// (hard block list). Centralised here so the two files stay in sync
// without requiring manual "drift should be fixed in BOTH files" notes.
//
// These are documented security-policy allowlists, not heuristic
// classifiers: membership is explicit and reviewed on addition.

// Shells whose `-c` payloads must be recursively scanned for destructive
// commands. Expand when a new shell interpreter is supported.
export const SHELL_NAMES = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash',
]);

// Wrapper programs that transparently exec their first non-option argument.
// We peel these (and their option args) before reading the real command name.
export const WRAPPER_NAMES = new Set([
  'env', 'sudo', 'doas', 'nice', 'stdbuf', 'chronic', 'time', 'timeout',
  'nohup', 'setpriv', 'ionice', 'taskset',
]);

// Hard-block patterns shared by the stateless bash tool (builtin.mjs) and
// the persistent bash_session tool (bash-session.mjs). Adding a pattern
// here propagates to both without manual sync.
//
// These block outright data-destructive or system-destabilising operations
// that the agent must never execute regardless of context. Informational
// warnings (non-blocking) live in destructive-warning.mjs instead.
// A command-runner wrapper (sudo, env, timeout, …) or VAR=val assignment may
// precede the real command. A destructive verb following such a peeled wrapper
// chain is still at command position, so `sudo shutdown` / `env timeout 5 dd …`
// stay hard-blocked, while a bare prose token before the verb (e.g. "graceful
// shutdown" in a commit message) does NOT satisfy command position and passes.
// Wrapper names are sourced from WRAPPER_NAMES above so this path and the
// destructive-warning peeler cannot drift apart. Each chain unit ends in \s+
// (no zero-width iteration) so the nested quantifier cannot backtrack-blow.
const _WRAP_CHAIN =
  '(?:' +
    '(?:[A-Za-z_]\\w*=\\S*\\s+)' +
    '|(?:(?:' + [...WRAPPER_NAMES].join('|') + ')\\s+(?:(?:[-+]\\S*|\\d+[smhd]?|\\d+m\\d+s?)\\s+)*)' +
  ')*';
const _CMD_START = '(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|[<>]\\(\\s*|`\\s*)' + _WRAP_CHAIN;
// Wrapper chain for the token-level rm guard. Same shape as _WRAP_CHAIN
// (backtrack-safe: every unit ends in \s+) but also peels `command`, the
// bash builtin that execs its first non-option argument. Lets the rm guard
// see `sudo rm -r -f /`, `env X=1 rm -r -f ~`, `timeout 5 rm -rf /`, etc.
const _RM_WRAP_CHAIN =
  '(?:' +
    '(?:[A-Za-z_]\\w*=\\S*\\s+)' +
    '|(?:(?:' + [...WRAPPER_NAMES, 'command'].join('|') + ')\\s+(?:(?:[-+]\\S*|\\d+[smhd]?|\\d+m\\d+s?)\\s+)*)' +
  ')*';
const BLOCKED_PATTERNS = [
  // Recursive deletes (bash `rm -rf`, PowerShell `Remove-Item -Recurse -Force`,
  // cmd `del /s` / `rd /s`) are NOT blocked outright — each is target-checked
  // by a dedicated guard below via _isDangerousDeleteTarget, blocking only
  // filesystem-root / home / top-level-system / whole-cwd targets (CC-level).
  // `git reset --hard` is likewise no longer hard-blocked (CC prompts; the
  // agent workflow already gates destructive git ops).
  // Bare `git push --force` (and `--force=`) still blocks; the safer
  // `--force-with-lease` / `--force-if-includes` variants pass.
  /\bgit\s+push\b[^\n]*?\s--force(?![\w-])/i,
  /\bformat\s+[a-z]:/i,
  new RegExp(_CMD_START + '(?:shutdown|reboot|halt)\\b', 'i'),
  new RegExp(_CMD_START + 'mkfs(?:\\.|\\b)', 'i'),
  new RegExp(_CMD_START + 'dd\\s+[^\\n]*\\b(?:if|of)=/dev/', 'i'),
  new RegExp(_CMD_START + 'diskpart\\b[^\\n]*\\bclean\\b', 'i'),
  /:\(\)\s*\{[^}]*:\|:&[^}]*\};\s*:/, // bash fork-bomb signature
];

// PowerShell `-EncodedCommand <base64>` (also `-enc`, `-e` short forms)
// transparently runs a UTF-16LE/base64 script that bypasses the literal-text
// BLOCKED_PATTERNS scan. Recognise the flag, decode the payload, and re-test
// the decoded text so a `powershell -EncodedCommand <Remove-Item ...>` smuggle
// still hits the policy. Bad base64 / decode failure falls through silently
// — the original literal scan still applies.
// Option names accept PowerShell's unambiguous prefix abbreviations so that
// `-nop` (NoProfile), `-nol` (NoLogo), `-noni` (NonInteractive), `-ep`
// (ExecutionPolicy), `-w hidden` (WindowStyle), etc. preceding the encoded
// flag no longer make the regex miss and skip decoding. Widening the option
// whitelist only makes more payloads get decoded + re-scanned; it never lets
// a previously-blocked command through.
const _ENCODED_CMD_RE = /(?:^|\s)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:[-/](?:NoP(?:rofile)?|NoL(?:ogo)?|NonI(?:nteractive)?|Sta|Mta|(?:ExecutionPolicy|Ep|Ex)\s+\S+|(?:WindowStyle|Win|W)\s+\S+|(?:InputFormat|Inp|If)\s+\S+|(?:OutputFormat|Out|Of)\s+\S+|Command|(?:File|Fi)\s+\S+|(?:Version|Ver)\s+\S+)\s+)*[-/](?:EncodedCommand|enc|e)\s+["']?([A-Za-z0-9+/=]+)["']?/gi;
function _decodePowerShellEncodedCommand(command) {
  const cmd = String(command || '');
  // Scan ALL -EncodedCommand occurrences (quoted or unquoted) so a chained
  // payload like `powershell -enc A...; powershell -enc B...` exposes both
  // decoded scripts to BLOCKED_PATTERNS. PowerShell -EncodedCommand expects
  // UTF-16LE. Bad base64 / decode failure is skipped silently per match.
  const decoded = [];
  for (const m of cmd.matchAll(_ENCODED_CMD_RE)) {
    try {
      const buf = Buffer.from(m[1], 'base64');
      decoded.push(buf.toString('utf16le'));
    } catch { /* skip bad base64 */ }
  }
  return decoded.length > 0 ? decoded.join('\n') : null;
}

// Shared decode for policy scan targets (hard-block + destructive warnings).
export function decodePowerShellEncodedCommand(command) {
  return _decodePowerShellEncodedCommand(command);
}

// Shared catastrophic-delete target test — see shell-policy-danger-target.mjs

// Token-level rm guard. BLOCKED_PATTERNS catches inline split-flag forms
// (`rm -rf /`, `rm -r -f /`, `rm -fr /`), but the regex misses arbitrary
// flag interleaving (`rm -r -f -v /`, `rm -v -r -f /`). Tokenise rm args
// and block any recursive+force combination whose target resolves to
// root, home, or $HOME — independent of flag order or extra options.
function _rmRecursiveForceUnsafe(command) {
  const text = String(command || '');
  const RM_RE = new RegExp('(?:^|[;&|\\n(){}]\\s*|\\$[\\({]\\s*|`\\s*)' + _RM_WRAP_CHAIN + '\\brm\\s+([^|;&\\n`)]+)', 'gi');
  for (const m of text.matchAll(RM_RE)) {
    const args = m[1].split(/\s+/).filter(Boolean);
    let recursive = false;
    let force = false;
    const targets = [];
    let endOfOpts = false;
    for (const arg of args) {
      if (endOfOpts) { targets.push(arg); continue; }
      if (arg === '--') { endOfOpts = true; continue; }
      if (arg === '--recursive') { recursive = true; continue; }
      if (arg === '--force') { force = true; continue; }
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
        if (/[fF]/.test(arg)) force = true;
        continue;
      }
      if (arg.startsWith('-')) continue;
      targets.push(arg);
    }
    if (!(recursive && force)) continue;
    for (const t of targets) {
      if (_isDangerousDeleteTarget(t)) return true;
    }
  }
  return false;
}

// PowerShell `Remove-Item -Recurse -Force` target guard. Uses the shared
// _isDangerousDeleteTarget test (parity with the bash rm guard): blocks only
// root / home / top-level-system / whole-cwd targets, plus a MISSING target.
// Generic variables ($x, $env:TEMP) are allowed (CC-level) — only known
// home/system env vars are treated as dangerous.
// -Force is matched at its minimum unambiguous PowerShell prefix `-fo` (NOT
// bare `-f`, which is ambiguous with -Filter); -Recurse matches `-r`/`-rec`.
function _removeItemRecursiveForceUnsafe(command) {
  const text = String(command || '');
  const RI_RE = /(?:^|[;&|\n(){}]\s*|`\s*)\s*(?:Remove-Item|ri|rm|rmdir|rd|del|erase)\b([^\n;|]*)/gi;
  for (const m of text.matchAll(RI_RE)) {
    const toks = m[1].split(/\s+/).filter(Boolean);
    let recursive = false;
    let force = false;
    const targets = [];
    for (let i = 0; i < toks.length; i += 1) {
      const low = toks[i].toLowerCase();
      if (low.startsWith('-')) {
        if (/^-r(ec(urse)?)?$/.test(low)) { recursive = true; continue; }
        if (/^-r(ec(urse)?)?:\$true$/i.test(low)) { recursive = true; continue; }
        if (/^-fo(rce)?$/.test(low)) { force = true; continue; }
        if (/^-fo(rce)?:\$true$/i.test(low)) { force = true; continue; }
        if (low === '-path' || low === '-literalpath' || low === '-lp') {
          if (toks[i + 1] !== undefined) { targets.push(toks[i + 1]); i += 1; }
          continue;
        }
        continue; // unrelated switch
      }
      targets.push(toks[i]);
    }
    if (!(recursive && force)) continue;
    if (targets.length === 0) return true; // recursive+force with no target
    for (const raw of targets) {
      const parts = raw.replace(/^@\(/, '').replace(/\)$/, '').split(',');
      for (const p0 of parts) {
        if (_isDangerousDeleteTarget(p0)) return true;
      }
    }
  }
  return false;
}

// cmd.exe recursive delete guard: `del /s [..] <path>`, `rd /s [..] <path>`,
// `rmdir /s <path>`. Only the recursive `/s` form is dangerous (plain `rd`
// removes empty dirs only; plain `del` is non-recursive), so we block solely
// when `/s` is present AND the target is catastrophic (via the shared
// _isDangerousDeleteTarget) or missing. Safe concrete paths pass (CC-level).
function _cmdRecursiveDeleteUnsafe(command) {
  const text = String(command || '');
  const RE = /(?:^|[;&|\n(){}]\s*|`\s*)\s*(?:del|erase|rd|rmdir)\b([^\n;|&]*)/gi;
  for (const m of text.matchAll(RE)) {
    const toks = m[1].split(/\s+/).filter(Boolean);
    let recursive = false;
    const targets = [];
    for (const tk of toks) {
      if (tk.startsWith('/')) {            // cmd switch: /s /q /f /a …
        if (/^\/s/i.test(tk)) recursive = true;
        continue;
      }
      if (tk.startsWith('-')) continue;    // stray POSIX-style flag
      targets.push(tk);
    }
    if (!recursive) continue;
    if (targets.length === 0) return true; // `del /s` / `rd /s` with no target
    for (const t of targets) if (_isDangerousDeleteTarget(t)) return true;
  }
  return false;
}

export function isBlockedCommand(command) {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(command)) return true;
  }
  // Token-level rm guard catches split-flag forms the inline regex misses
  // (e.g. `rm -r -f -v /`, `rm -v -R -F ~`).
  if (_rmRecursiveForceUnsafe(command)) return true;
  // PowerShell Remove-Item recursive+force guard — target-checked, parity
  // with the bash rm guard above (and its decoded-payload variant below).
  if (_removeItemRecursiveForceUnsafe(command)) return true;
  // cmd-style recursive delete (`del /s`, `rd /s`, `rmdir /s`) — target-checked.
  if (_cmdRecursiveDeleteUnsafe(command)) return true;
  const decodedForRm = _decodePowerShellEncodedCommand(command);
  if (decodedForRm && _rmRecursiveForceUnsafe(decodedForRm)) return true;
  if (decodedForRm && _removeItemRecursiveForceUnsafe(decodedForRm)) return true;
  if (decodedForRm && _cmdRecursiveDeleteUnsafe(decodedForRm)) return true;
  // Re-scan decoded PowerShell -EncodedCommand payload. A destructive script
  // smuggled as base64 (UTF-16LE) was previously invisible to the literal
  // pattern match. Decode is best-effort; bad base64 / non-text bytes just
  // return null and the function below skips. The decoded form is fed
  // through the same BLOCKED_PATTERNS so any future addition automatically
  // covers the encoded variant too.
  const decoded = _decodePowerShellEncodedCommand(command);
  if (decoded) {
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(decoded)) return true;
    }
  }
  return false;
}

const WMIC_PROCESS_DEFAULT_FIELDS = Object.freeze([
  'ProcessId',
  'Name',
  'CreationDate',
  'ExecutablePath',
  'CommandLine',
]);

const WMIC_PROCESS_FIELD_MAP = new Map([
  ['processid', 'ProcessId'],
  ['name', 'Name'],
  ['creationdate', 'CreationDate'],
  ['executablepath', 'ExecutablePath'],
  ['commandline', 'CommandLine'],
  ['parentprocessid', 'ParentProcessId'],
  ['workingsetsize', 'WorkingSetSize'],
  ['threadcount', 'ThreadCount'],
  ['handlecount', 'HandleCount'],
]);

function _psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function _psArray(values) {
  return `@(${values.map(_psQuote).join(', ')})`;
}

function _encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function _parseWmicProcessFields(command) {
  const normalized = String(command || '').replace(/\\"/g, '"');
  const m = normalized.match(/\bget\s+([\s\S]+?)(?:\s+\/format:\w+)?\s*["']?\s*$/i);
  if (!m) return [...WMIC_PROCESS_DEFAULT_FIELDS];
  const fields = [];
  for (const raw of m[1].split(/[,\s]+/)) {
    const key = raw.trim().replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
    const field = WMIC_PROCESS_FIELD_MAP.get(key);
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields.length ? fields : [...WMIC_PROCESS_DEFAULT_FIELDS];
}

/**
 * Rewrite deprecated `wmic process ... get ...` probes to a bounded
 * PowerShell/CIM equivalent. WMIC routinely stalls for the full shell timeout
 * on Windows hosts; EncodedCommand also protects PowerShell's `$_` token from
 * any outer shell parsing before PowerShell sees it.
 *
 * Returns null for non-matching commands.
 */
export function maybeRewriteWmicProcessCommand(command) {
  const text = typeof command === 'string' ? command : '';
  // Composite shell structure detection (pipes / &&  / ;  / $( / backtick).
  // The full-command rewrite below replaces the entire `text`, which would
  // silently drop surrounding `cd`, pipes, `&&`/`;` segments. For composite
  // commands containing wmic, return null so the caller falls back to other
  // policy handling instead of dropping context.
  if (/[|&;]|\$\(|`/.test(text) && /\bwmic(?:\.exe)?\s+process\b/i.test(text)) return null;
  if (!/\bwmic(?:\.exe)?\s+process\b/i.test(text)) return null;
  if (!/\bget\b/i.test(text)) {
    return {
      error: 'wmic process commands are disabled because WMIC can stall for minutes; use PowerShell Get-CimInstance/Get-Process instead.',
    };
  }

  const normalized = text.replace(/\\"/g, '"');
  const names = [...normalized.matchAll(/\bname\s*=\s*['"]([^'"]+)['"]/ig)]
    .map(m => m[1])
    .filter(Boolean);
  const pids = [...normalized.matchAll(/\bprocessid\s*=\s*(\d+)/ig)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);
  const fields = _parseWmicProcessFields(normalized);

  const filters = [];
  const setup = [`$fields = ${_psArray(fields)}`];
  if (names.length > 0) {
    setup.push(`$names = ${_psArray([...new Set(names)])}`);
    filters.push('($names -contains $_.Name)');
  }
  if (pids.length > 0) {
    setup.push(`$pids = @(${[...new Set(pids)].join(', ')})`);
    filters.push('($pids -contains [int]$_.ProcessId)');
  }

  const where = filters.length ? ` | Where-Object { ${filters.join(' -or ')} }` : '';
  const script = [
    ...setup,
    `$ErrorActionPreference = 'Stop'`,
    `Get-CimInstance Win32_Process${where} | Select-Object -Property $fields | Format-List`,
  ].join('; ');

  return {
    command: `powershell.exe -NoProfile -EncodedCommand ${_encodePowerShellCommand(script)}`,
    timeoutMs: 30_000,
    note: '[auto-rewrite: deprecated wmic process query -> PowerShell Get-CimInstance; timeout capped at 30000ms]',
  };
}
