import { stripQuotedAndHeredoc, extractShellCInner } from './destructive-warning.mjs';
import { decodePowerShellEncodedCommand } from './shell-policy.mjs';
import { extractPowerShellCommandInner } from './shell-command.mjs';
import { evaluateExecPolicyFromTargets, formatExecPolicyBlockMessage } from './shell-exec-policy.mjs';

function _decodeAnsiCQuotes(s) {
  if (typeof s !== 'string') return '';
  if (s.indexOf('$') === -1) return s;
  return s.replace(/\$(['"])((?:\\.|[^\\])*?)\1/g, (_full, _q, body) =>
    body
      .replace(/\\x([0-9a-fA-F]{1,2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{1,4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\0([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\').replace(/\\(['"])/g, '$1'),
  );
}

function _extractSubstitutionBodies(s) {
  if (typeof s !== 'string') return [];
  const out = [];
  const re = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const body = m[1] != null ? m[1] : m[2];
    if (body && body.trim()) out.push(body);
  }
  return out;
}

export function injectionBlockTargets(cmd) {
  const targets = [];
  const decoded = _decodeAnsiCQuotes(cmd);
  if (decoded && decoded !== cmd) targets.push(decoded);
  for (const body of _extractSubstitutionBodies(cmd)) {
    targets.push(body);
    const bodyDecoded = _decodeAnsiCQuotes(body);
    if (bodyDecoded && bodyDecoded !== body) targets.push(bodyDecoded);
  }
  return targets;
}

export function buildBashPolicyScanTargets(command) {
  const cmd = String(command || '');
  if (!cmd) return [];
  const targets = [
    cmd,
    stripQuotedAndHeredoc(cmd),
    ...extractShellCInner(cmd).map(stripQuotedAndHeredoc),
    ...injectionBlockTargets(cmd),
  ];
  for (const inner of extractPowerShellCommandInner(cmd)) {
    targets.push(inner, stripQuotedAndHeredoc(inner));
  }
  const psDecoded = decodePowerShellEncodedCommand(cmd);
  if (psDecoded) targets.push(psDecoded);
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    if (typeof t !== 'string' || !t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function checkExecPolicyMessage(command) {
  return formatExecPolicyBlockMessage(
    evaluateExecPolicyFromTargets(buildBashPolicyScanTargets(command)),
  );
}