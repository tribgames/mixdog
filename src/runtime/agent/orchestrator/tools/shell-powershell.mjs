'use strict';
// PowerShell inline-command normalization + policy-scan extraction. Extracted
// verbatim from shell-command.mjs (behavior-preserving). shell-command.mjs
// re-exports _maybeEncodePowerShellCommand / extractPowerShellCommandInner so
// the module's public export surface is unchanged.
//
// On Windows, nested `powershell -Command "<inline>"` invocations can be
// mangled by an outer shell quoting layer before powershell.exe sees
// automatic variables (`$_`, `$args`, `$($_.Line)`, etc.). Rewrite
// `powershell -Command "<inline>"` / `pwsh -Command "<inline>"` to
// `-EncodedCommand <utf16le-base64>` so the payload stays opaque to the
// outer shell. Other shells / non-Windows are no-op pass-through.
// Match -Command "<body>" where the body may contain escaped quotes
// (`\"` or `""`). Stops at the first unescaped closing quote so nested
// patterns like `"... \"inner\" ..."` survive intact. Common PowerShell
// flags (NoProfile, NonInteractive, WindowStyle, ExecutionPolicy, Sta,
// Mta, NoLogo, NoExit) are recognised so they don't break the match.
// Single-quoted -Command '<body>' is also covered.
const _POWERSHELL_FLAGS_RE = /\s+-(?:NoProfile|NonInteractive|WindowStyle\s+\S+|ExecutionPolicy\s+\S+|Sta|Mta|NoLogo|NoExit)/.source;
const _POWERSHELL_DOUBLE_RE = new RegExp(
  '\\b(powershell(?:\\.exe)?|pwsh(?:\\.exe)?)((?:' + _POWERSHELL_FLAGS_RE + ')*)\\s+(?:-Command|-c)\\s+"((?:[^"\\\\]|\\\\.|"")+?)"(?=\\s|$|;|&&|\\|\\|)',
  'gi',
);
const _POWERSHELL_SINGLE_RE = new RegExp(
  "\\b(powershell(?:\\.exe)?|pwsh(?:\\.exe)?)((?:" + _POWERSHELL_FLAGS_RE + ")*)\\s+(?:-Command|-c)\\s+'((?:[^'\\\\]|\\\\.|'')+?)'(?=\\s|$|;|&&|\\|\\|)",
  'gi',
);

export function _maybeEncodePowerShellCommand(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  const replaceFn = (match, exe, flags, body) => {
    try {
      // Unescape doubled-up quotes the caller used to embed " / ' inside
      // the -Command literal. We're handing the body to powershell as
      // base64 so the outer-shell escaping is no longer needed.
      // Unescape both PowerShell-style doubled quotes (`""` / `''`) AND
      // bash-style backslash-escaped quotes (`\"` / `\'`) since POSIX
      // outer-shell wrappers commonly use backslash form. Without
      // backslash unescape, `pwsh -Command "Get-Process \"foo\""` would
      // base64-encode the literal backslash, breaking inside PowerShell.
      const unescaped = body
        .replace(/""/g, '"')
        .replace(/''/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
      const encoded = Buffer.from(unescaped, 'utf16le').toString('base64');
      const trimmedFlags = (flags || '').replace(/\s+/g, ' ').trim();
      return `${exe}${trimmedFlags ? ' ' + trimmedFlags : ''} -EncodedCommand ${encoded}`;
    } catch {
      return match;
    }
  };
  return command.replace(_POWERSHELL_DOUBLE_RE, replaceFn).replace(_POWERSHELL_SINGLE_RE, replaceFn);
}

function _unescapePowerShellCommandBody(body) {
  return String(body || '')
    .replace(/""/g, '"')
    .replace(/''/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
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
