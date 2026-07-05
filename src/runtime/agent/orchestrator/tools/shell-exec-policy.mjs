'use strict';

import { getDestructiveCommandWarning } from './destructive-warning.mjs';
import { isBlockedCommand, WRAPPER_NAMES } from './shell-policy.mjs';

/** @typedef {'allow'|'warn-prompt'|'deny'} ExecPolicyDecision */

const EXEC_POLICY_DENY_PATTERNS = [
  /\b(curl|wget|fetch|Invoke-WebRequest|iwr)\b[^\n|&;]*\|[^\n|&;]*\b(sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\b/i,
  /\|\s*(sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\b/i,
  /\b(?:sh|bash|zsh|dash|pwsh|powershell)(?:\.exe)?\s+<\s*\(/i,
  /\bInvoke-Expression\b/i,
  /\biex\s+/i,
  /\bStart-Process\b[^\n]*\b-Verb\s+RunAs\b/i,
];

const EXEC_POLICY_DENY_COMMANDS = new Set([
  'dd', 'diskpart', 'shutdown', 'reboot', 'halt', 'poweroff', 'init', 'telinit',
  'mkfs', 'mkfs.ext4', 'mkfs.ntfs', 'format', 'fdisk', 'parted',
]);

const _POLICY_RANK = { allow: 0, 'warn-prompt': 1, deny: 2 };

function _firstCommandName(command) {
  const seg = String(command || '').split(/[;&|\n]+/)[0] || '';
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
    return base.replace(/\.(exe|cmd|bat|com)$/i, '');
  }
  return null;
}

export function classifyExecPolicy(command) {
  const text = String(command || '');
  if (!text.trim()) return { decision: 'allow', reason: '' };
  if (isBlockedCommand(text)) {
    return { decision: 'deny', reason: 'destructive or system-destabilising pattern (hard block)' };
  }
  for (const pat of EXEC_POLICY_DENY_PATTERNS) {
    if (pat.test(text)) {
      return { decision: 'deny', reason: 'high-risk shell invocation (pipe-to-shell, elevated launcher, or remote-exec pattern)' };
    }
  }
  const name = _firstCommandName(text);
  if (name && EXEC_POLICY_DENY_COMMANDS.has(name)) {
    return { decision: 'deny', reason: `command "${name}" is not permitted without sandbox` };
  }
  const warn = getDestructiveCommandWarning(text);
  if (warn) {
    return { decision: 'warn-prompt', reason: warn };
  }
  return { decision: 'allow', reason: '' };
}

export function mergeExecPolicyDecisions(a, b) {
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

/** Pre-spawn block message — deny only. warn-prompt is non-blocking (see destructive-warning prepend). */
export function formatExecPolicyBlockMessage(policyResult) {
  const r = policyResult || { decision: 'allow' };
  if (r.decision === 'deny') {
    return `Error: command blocked by exec policy${r.reason ? ` — ${r.reason}` : ''}`;
  }
  return null;
}