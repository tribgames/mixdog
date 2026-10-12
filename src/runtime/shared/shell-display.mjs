/**
 * Display form of a background shell command.
 *
 * Windows shells are spawned with a UTF-8 console preamble prepended by the
 * bash tool (`_prefixPowerShellUtf8`). That preamble is an execution detail:
 * echoing it into job records, chips and completion envelopes buried the
 * command the user actually ran behind two encoding statements.
 */
// $OutputEncoding feeds native-program stdin: BOM-less, since Windows PowerShell
// 5.1 prepends a U+FEFF preamble for [Text.Encoding]::UTF8 (breaks `python -`).
export const POWERSHELL_UTF8_PREFIX =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=New-Object System.Text.UTF8Encoding $false;';

export function displayShellCommand(value) {
  const text = String(value ?? '');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(POWERSHELL_UTF8_PREFIX)) return text;
  return trimmed.slice(POWERSHELL_UTF8_PREFIX.length).replace(/^[ \t]*\r?\n/, '');
}
