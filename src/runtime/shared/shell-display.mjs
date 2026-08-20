/**
 * Display form of a background shell command.
 *
 * Windows shells are spawned with a UTF-8 console preamble prepended by the
 * bash tool (`_prefixPowerShellUtf8`). That preamble is an execution detail:
 * echoing it into job records, chips and completion envelopes buried the
 * command the user actually ran behind two encoding statements.
 */
const POWERSHELL_UTF8_PREFIX =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;';

export function displayShellCommand(value) {
    const text = String(value ?? '');
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(POWERSHELL_UTF8_PREFIX)) return text;
    return trimmed.slice(POWERSHELL_UTF8_PREFIX.length).replace(/^[ \t]*\r?\n/, '');
}
