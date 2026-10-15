import { extractHeredocBodies, extractShellCInner, stripQuotedAndHeredoc } from './destructive-warning.mjs';
import { extractPowerShellCommandInner } from './shell-powershell.mjs';
import { decodePowerShellEncodedCommand, isBlockedCommand, WRAPPER_NAMES } from './shell-policy.mjs';

/** @typedef {'allow'|'ask'|'deny'} ExecPolicyDecision */

const EXEC_POLICY_DENY_PATTERNS = [
  /\b(curl|wget|fetch|Invoke-WebRequest|iwr)\b[^\n|&;]*\|[^\n|&;]*\b(sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\b/i,
  /\|\s*(sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\b/i,
  /\b(?:sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\s+<\s*\(/i,
  /\bInvoke-Expression\b/i,
  // PowerShell's Invoke-Expression alias. `… | iex` is the actual remote-exec
  // shape and a bare `iex <expression>` executes text as code, so both deny.
  // A LAUNCH of the Elixir REPL (`iex -S mix`, `iex script.exs`) is an
  // ordinary program start and must stay allowed — hence the expression-only
  // lookahead instead of the previous bare `iex\s+`.
  /\|\s*iex\b/i,
  /\biex\s+[$("'@]/i,
];

// Elevated launch: `Start-Process` (or its aliases `saps` / `start`) with
// `-Verb RunAs`. Not a hard deny — the user is asked (parity with Claude Code's
// "Command requests elevated privileges"). `-Verb` may be abbreviated to any
// prefix (`-v`, `-ve`, `-ver`) and take its value after a space or a colon.
// `Start-Process` matches anywhere (as the former deny rule did); the short
// aliases only at a command position so `npm start -v RunAs` stays allowed.
const ELEVATION_ASK_PATTERN =
  /(?:\bStart-Process\b|(?:^|[;&|({=\n])\s*(?:&\s*)?(?:saps|start)(?![\w-]))[^\n]*?\s-v(?:e(?:rb?)?)?(?:\s*:\s*|\s+)RunAs\b/i;
const ELEVATION_ASK_REASON = 'Command requests elevated privileges';

// PowerShell spellings of the same token that the quote-stripping pass would
// otherwise hide or split: backtick line continuation, backtick-escaped
// letters (`-V`erb`), and a quoted `-Verb` value (`-Verb:'RunAs'`).
function _normalizeElevationSyntax(text) {
  return String(text || '')
    .replace(/`\r?\n/g, ' ')
    .replace(/`([A-Za-z])/g, '$1')
    .replace(/(\s-v\w*(?:\s*:\s*|\s+))(['"])\s*RunAs\s*\2/gi, '$1RunAs');
}

// Verbs with no non-destructive invocation. `dd` is deliberately ABSENT: the
// disk-destroying form (`of=/dev/<disk>`) is hard-blocked at every command
// position by shell-policy, while `dd if=/dev/zero of=file` is the ordinary
// way to create a fixed-size file and blocking it only cost retries.
const EXEC_POLICY_DENY_COMMANDS = new Set([
  'diskpart',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  'mkfs',
  'mkfs.ext4',
  'mkfs.ntfs',
  'format',
  'fdisk',
  'parted',
]);

const _POLICY_RANK = { allow: 0, ask: 1, deny: 2 };

// EVERY command position, not just the first: a deny-listed verb after `&&`,
// `;`, `|` or a newline is still an execution request, and reading only
// segment 0 let `true && shutdown /s` through. Callers pass quote-stripped
// text, so prose inside a string ("graceful shutdown") never reaches here.
const _ELEVATION_WRAPPERS = new Set(['sudo', 'doas', 'pkexec', 'gsudo']);
const _bareName = (token) =>
  token
    .replace(/^.*[\\/]/, '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com)$/i, '');

// Returns the first privilege-escalation wrapper (sudo, doas, pkexec, gsudo,
// with or without path/extension) found at any command position, else null.
function _elevationWrapperAtPositions(command) {
  for (const seg of String(command || '').split(/[;&|\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      const base = _bareName(t);
      if (_ELEVATION_WRAPPERS.has(base)) return base;
      if (WRAPPER_NAMES.has(base)) {
        i++;
        while (i < tokens.length && (/^[-+]/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]))) i++;
        continue;
      }
      break;
    }
  }
  return null;
}

function _commandNamesAtPositions(command) {
  const names = [];
  for (const seg of String(command || '').split(/[;&|\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i++;
        continue;
      }
      if (WRAPPER_NAMES.has(_bareName(t))) {
        i++;
        while (i < tokens.length && (/^[-+]/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]))) i++;
        continue;
      }
      const base = t.replace(/^.*[\\/]/, '').toLowerCase();
      names.push(base.replace(/\.(exe|cmd|bat|com)$/i, ''));
      break;
    }
  }
  return names;
}

function classifyExecPolicy(command) {
  const text = String(command || '');
  if (!text.trim()) return { decision: 'allow', reason: '' };
  // Scan executable syntax, not quoted log/search text. Recursively preserve
  // actual shell, PowerShell, heredoc, and encoded-command payload coverage.
  const rawTargets = [
    text,
    ...extractShellCInner(text),
    ...extractPowerShellCommandInner(text),
    ...extractHeredocBodies(text),
  ];
  const decodedPowerShell = decodePowerShellEncodedCommand(text);
  if (decodedPowerShell) rawTargets.push(decodedPowerShell);
  const executableTargets = rawTargets.map(stripQuotedAndHeredoc);
  if (executableTargets.some((target) => isBlockedCommand(target))) {
    return {
      decision: 'deny',
      reason: 'destructive or system-destabilising pattern (hard block)',
      rule: 'hard-block',
    };
  }
  // Hard-deny only real executable syntax. The policy scanner also sees user
  // search strings / regex literals (e.g. `-match 'powershell|bash|grep'`), so
  // high-risk pipe-to-shell / IEX / RunAs patterns must ignore quoted spans.
  const executableText = stripQuotedAndHeredoc(text);
  for (const pat of EXEC_POLICY_DENY_PATTERNS) {
    const hit = pat.exec(executableText);
    if (hit) {
      return {
        decision: 'deny',
        reason: 'high-risk shell invocation (pipe-to-shell, elevated launcher, or remote-exec pattern)',
        rule: `high-risk-pattern-${EXEC_POLICY_DENY_PATTERNS.indexOf(pat) + 1}`,
        match: hit[0].trim().slice(0, 80),
        alternative: 'save the script to a file, inspect it, then run it directly',
      };
    }
  }
  for (const name of _commandNamesAtPositions(executableText)) {
    if (EXEC_POLICY_DENY_COMMANDS.has(name)) {
      return {
        decision: 'deny',
        reason: `command "${name}" is not permitted`,
        rule: 'denied-command',
        match: name,
      };
    }
  }
  // Elevation asks only after every deny rule above has had its say.
  for (const target of rawTargets) {
    const hit = ELEVATION_ASK_PATTERN.exec(stripQuotedAndHeredoc(_normalizeElevationSyntax(target)));
    if (hit) {
      return {
        decision: 'ask',
        reason: ELEVATION_ASK_REASON,
        rule: 'elevation',
        match: hit[0].trim().slice(0, 80),
      };
    }
  }
  for (const target of executableTargets) {
    const wrapper = _elevationWrapperAtPositions(target);
    if (wrapper) {
      return { decision: 'ask', reason: ELEVATION_ASK_REASON, rule: 'elevation', match: wrapper };
    }
  }
  // Destructive-but-legitimate commands are NOT judged here. The caller
  // computes that non-blocking warning once (getDedupedDestructiveWarnings)
  // and prepends it to the result; deriving it again per scan target only
  // produced throwaway passes on every shell call.
  return { decision: 'allow', reason: '' };
}

function mergeExecPolicyDecisions(a, b) {
  const left = a?.decision ? a : { decision: 'allow', reason: '' };
  const right = b?.decision ? b : { decision: 'allow', reason: '' };
  if (_POLICY_RANK[right.decision] > _POLICY_RANK[left.decision]) return right;
  if (_POLICY_RANK[right.decision] < _POLICY_RANK[left.decision]) return left;
  return right.reason ? right : left;
}

export function evaluateExecPolicyFromTargets(targets) {
  let worst = { decision: 'allow', reason: '' };
  for (const t of targets || []) {
    if (typeof t !== 'string' || !t) continue;
    worst = mergeExecPolicyDecisions(worst, classifyExecPolicy(t));
    if (worst.decision === 'deny') break;
  }
  return worst;
}

/** Pre-spawn block message. An 'ask' decision blocks unless the runtime
 *  already obtained the user's approval for this call (`elevationApproved`). */
export function formatExecPolicyBlockMessage(policyResult, { elevationApproved = false } = {}) {
  const r = policyResult || { decision: 'allow' };
  if (r.decision === 'ask') {
    if (elevationApproved === true) return null;
    const rule = r.rule ? ` [rule ${r.rule}${r.match ? `: "${r.match}"` : ''}]` : '';
    return `Error: command requires user approval for elevation — ${r.reason || ELEVATION_ASK_REASON}${rule}; no approval was granted for this call`;
  }
  if (r.decision === 'deny') {
    const rule = r.rule ? ` [rule ${r.rule}${r.match ? `: "${r.match}"` : ''}]` : '';
    const alt = r.alternative ? `; instead: ${r.alternative}` : '';
    return `Error: command blocked by exec policy${r.reason ? ` — ${r.reason}` : ''}${rule}${alt}`;
  }
  return null;
}
