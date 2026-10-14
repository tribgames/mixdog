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

// The `mixdog-skill-node` definition PowerShell commands carry next
// (renderPowerShellSkillFunction) is the same kind of execution detail.
const SKILL_FUNCTION_LINE = /^[ \t]*function mixdog-skill-node \{[^\r\n]*\r?\n/;

export function displayShellCommand(value) {
  const text = String(value ?? '');
  let rest = text.trimStart();
  const prefixed = rest.startsWith(POWERSHELL_UTF8_PREFIX);
  if (prefixed) rest = rest.slice(POWERSHELL_UTF8_PREFIX.length).replace(/^[ \t]*\r?\n/, '');
  const withoutFunction = rest.replace(SKILL_FUNCTION_LINE, '');
  return prefixed || withoutFunction !== rest ? withoutFunction : text;
}
