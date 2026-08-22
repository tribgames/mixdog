'use strict';

import {
  extractHeredocBodies,
  extractShellCInner,
  stripQuotedAndHeredoc,
} from './destructive-warning.mjs';
import { extractPowerShellCommandInner } from './shell-command.mjs';
import { decodePowerShellEncodedCommand, isBlockedCommand, WRAPPER_NAMES } from './shell-policy.mjs';

/** @typedef {'allow'|'deny'} ExecPolicyDecision */

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
  /\bStart-Process\b[^\n]*\s-Verb\s+RunAs\b/i,
];

// Verbs with no non-destructive invocation. `dd` is deliberately ABSENT: the
// disk-destroying form (`of=/dev/<disk>`) is hard-blocked at every command
// position by shell-policy, while `dd if=/dev/zero of=file` is the ordinary
// way to create a fixed-size file and blocking it only cost retries.
const EXEC_POLICY_DENY_COMMANDS = new Set([
  'diskpart', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit',
  'mkfs', 'mkfs.ext4', 'mkfs.ntfs', 'format', 'fdisk', 'parted',
]);

const _POLICY_RANK = { allow: 0, deny: 1 };

// EVERY command position, not just the first: a deny-listed verb after `&&`,
// `;`, `|` or a newline is still an execution request, and reading only
// segment 0 let `true && shutdown /s` through. Callers pass quote-stripped
// text, so prose inside a string ("graceful shutdown") never reaches here.
function _commandNamesAtPositions(command) {
  const names = [];
  for (const seg of String(command || '').split(/[;&|\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
      if (WRAPPER_NAMES.has(t.toLowerCase())) {
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
  const executableTargets = [
    stripQuotedAndHeredoc(text),
    ...extractShellCInner(text).map(stripQuotedAndHeredoc),
    ...extractPowerShellCommandInner(text).map(stripQuotedAndHeredoc),
    ...extractHeredocBodies(text).map(stripQuotedAndHeredoc),
  ];
  const decodedPowerShell = decodePowerShellEncodedCommand(text);
  if (decodedPowerShell) executableTargets.push(stripQuotedAndHeredoc(decodedPowerShell));
  if (executableTargets.some((target) => isBlockedCommand(target))) {
    return { decision: 'deny', reason: 'destructive or system-destabilising pattern (hard block)' };
  }
  // Hard-deny only real executable syntax. The policy scanner also sees user
  // search strings / regex literals (e.g. `-match 'powershell|bash|grep'`), so
  // high-risk pipe-to-shell / IEX / RunAs patterns must ignore quoted spans.
  const executableText = stripQuotedAndHeredoc(text);
  for (const pat of EXEC_POLICY_DENY_PATTERNS) {
    if (pat.test(executableText)) {
      return { decision: 'deny', reason: 'high-risk shell invocation (pipe-to-shell, elevated launcher, or remote-exec pattern)' };
    }
  }
  for (const name of _commandNamesAtPositions(executableText)) {
    if (EXEC_POLICY_DENY_COMMANDS.has(name)) {
      return { decision: 'deny', reason: `command "${name}" is not permitted` };
    }
  }
  // Destructive-but-legitimate commands are NOT judged here. The caller
  // computes that non-blocking warning once (getDedupedDestructiveWarnings)
  // and prepends it to the result; deriving it again per scan target only
  // produced throwaway passes on every shell call.
  return { decision: 'allow', reason: '' };
}

function mergeExecPolicyDecisions(a, b) {
  const left = a && a.decision ? a : { decision: 'allow', reason: '' };
  const right = b && b.decision ? b : { decision: 'allow', reason: '' };
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

/** Pre-spawn block message — deny is the only decision this scan produces. */
export function formatExecPolicyBlockMessage(policyResult) {
  const r = policyResult || { decision: 'allow' };
  if (r.decision === 'deny') {
    return `Error: command blocked by exec policy${r.reason ? ` — ${r.reason}` : ''}`;
  }
  return null;
}