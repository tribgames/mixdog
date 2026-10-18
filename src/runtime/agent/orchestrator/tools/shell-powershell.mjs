// PowerShell inline-command normalization + policy-scan extraction. shell-command.mjs
// re-exports _maybeEncodePowerShellCommand / extractPowerShellCommandInner so
// the module's public export surface is unchanged.
//
// On Windows, nested `powershell -Command "<inline>"` invocations can be
// mangled by an outer shell quoting layer before powershell.exe sees
// automatic variables (`$_`, `$args`, `$($_.Line)`, etc.). Rewrite
// `powershell -Command "<inline>"` / `pwsh -Command "<inline>"` to
// `-EncodedCommand <utf16le-base64>` so the payload stays opaque to the
// outer shell. Other shells / non-Windows are no-op pass-through.
import { codeMask } from './builtin/bash-tool/bashism-rewrite.mjs';

// Match -Command "<body>" where the body may contain escaped quotes
// (`\"` or `""`). Stops at the first unescaped closing quote so nested
// patterns like `"... \"inner\" ..."` survive intact. Common PowerShell
// flags (NoProfile, NonInteractive, WindowStyle, ExecutionPolicy, Sta,
// Mta, NoLogo, NoExit) are recognised so they don't break the match.
// Single-quoted -Command '<body>' is also covered.
const _POWERSHELL_FLAGS_RE =
  /\s+-(?:NoProfile|NonInteractive|WindowStyle\s+\S+|ExecutionPolicy\s+\S+|Sta|Mta|NoLogo|NoExit)/.source;
// What may follow the closing quote: the end of the command or a shell
// operator. Anything else (`pwsh -Command "a" "b"`) is more arguments, which
// PowerShell appends to the command text and an -EncodedCommand would drop.
const _POWERSHELL_TRAILING = '(?=[ \\t]*(?:$|[\\r\\n;|&<>]|\\d+>))';
const _POWERSHELL_DOUBLE_RE = new RegExp(
  '\\b(powershell(?:\\.exe)?|pwsh(?:\\.exe)?)((?:' +
    _POWERSHELL_FLAGS_RE +
    ')*)\\s+(?:-Command|-c)\\s+"((?:[^"\\\\]|\\\\.|"")+?)"' +
    _POWERSHELL_TRAILING,
  'gi'
);
const _POWERSHELL_SINGLE_RE = new RegExp(
  '\\b(powershell(?:\\.exe)?|pwsh(?:\\.exe)?)((?:' +
    _POWERSHELL_FLAGS_RE +
    ")*)\\s+(?:-Command|-c)\\s+'((?:[^'\\\\]|\\\\.|'')+?)'" +
    _POWERSHELL_TRAILING,
  'gi'
);

// One pass of one quote style. Only an invocation the outer shell itself runs
// is rewritten: the same text inside a string, here-string or comment (a
// README being written, a commit message) is data, not a command.
function _encodePass(command, pattern, quote) {
  const live = codeMask(command);
  if (!live) return command;
  return command.replace(pattern, (match, exe, flags, body, offset) => {
    if (!live[offset]) return match;
    try {
      // Unescape the quote the caller used to embed the body: the PowerShell
      // doubled form (`""` / `''`) AND the bash-style backslash form (`\"` /
      // `\'`) POSIX outer-shell wrappers commonly use. Without the backslash
      // unescape, `pwsh -Command "Get-Process \"foo\""` would base64-encode the
      // literal backslash. The OTHER quote is the body's own syntax and stays.
      const unescaped = _unescapePowerShellCommandBody(body, quote);
      const encoded = Buffer.from(unescaped, 'utf16le').toString('base64');
      const trimmedFlags = (flags || '').replace(/\s+/g, ' ').trim();
      return `${exe}${trimmedFlags ? ` ${trimmedFlags}` : ''} -EncodedCommand ${encoded}`;
    } catch {
      return match;
    }
  });
}

export function _maybeEncodePowerShellCommand(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  return _encodePass(_encodePass(command, _POWERSHELL_DOUBLE_RE, '"'), _POWERSHELL_SINGLE_RE, "'");
}

// `quote` names the delimiter that wrapped the body, so only its own escapes
// are removed. Without it (policy scanning, which wants every reading of the
// body) both styles are removed.
function _unescapePowerShellCommandBody(body, quote) {
  let text = String(body || '');
  if (quote !== "'") text = text.replace(/""/g, '"').replace(/\\"/g, '"');
  if (quote !== '"') text = text.replace(/''/g, "'").replace(/\\'/g, "'");
  return text;
}

// Extract inline `powershell -Command "…"` bodies for policy scan parity
// with hard-block normalization (encoded payloads use decodePowerShellEncodedCommand).
export function extractPowerShellCommandInner(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const out = [];
  const push = (body) => {
    const unescaped = _unescapePowerShellCommandBody(body);
    if (unescaped.trim()) out.push(unescaped);
  };
  for (const m of command.matchAll(_POWERSHELL_DOUBLE_RE)) push(m[3]);
  for (const m of command.matchAll(_POWERSHELL_SINGLE_RE)) push(m[3]);
  return out;
}
