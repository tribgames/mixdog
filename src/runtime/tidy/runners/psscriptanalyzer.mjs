// PSScriptAnalyzer — Invoke-ScriptAnalyzer for diagnostics and Invoke-Formatter
// for formatting, through pwsh/powershell.
//
// The script text below is a FIXED literal: the file paths arrive as JSON on
// stdin, never interpolated into the script, so no path can become PowerShell
// code. Write mode is selected by an environment flag, not by editing the
// script.
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$out = New-Object System.Collections.ArrayList
$write = $env:MIXDOG_TIDY_PSSA_WRITE -eq '1'
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
foreach ($p in $paths) {
  try {
    $text = Get-Content -LiteralPath $p -Raw -ErrorAction Stop
    if ($null -eq $text) { $text = '' }
    $formatted = Invoke-Formatter -ScriptDefinition $text
    if ($formatted -ne $text) {
      if ($write) { Set-Content -LiteralPath $p -Value $formatted -NoNewline }
      [void]$out.Add([pscustomobject]@{ file = $p; line = 0; col = 0; code = 'PSFormatting'; message = 'Invoke-Formatter would reformat this file'; severity = 'Warning'; format = $true })
    }
    foreach ($d in @(Invoke-ScriptAnalyzer -Path $p)) {
      [void]$out.Add([pscustomobject]@{ file = $p; line = $d.Line; col = $d.Column; code = "$($d.RuleName)"; message = "$($d.Message)"; severity = "$($d.Severity)"; format = $false })
    }
  } catch {
    [void]$out.Add([pscustomobject]@{ file = $p; line = 0; col = 0; code = 'PSScriptAnalyzer'; message = "$($_.Exception.Message)"; severity = 'Error'; format = $false })
  }
}
ConvertTo-Json -InputObject @{ diagnostics = @($out) } -Depth 4 -Compress
`;

function severityOf(value) {
  const level = String(value || '').toLowerCase();
  if (level === 'error' || level === 'parseerror') return 'error';
  if (level === 'warning') return 'warning';
  return 'info';
}

/** Parse the fixed script's JSON payload. */
export function parsePsScriptAnalyzerJson(stdout, cwd) {
  const text = String(stdout || '').trim();
  if (!text) return { diagnostics: [], changedFiles: [] };
  let payload;
  try { payload = JSON.parse(text); } catch { return { diagnostics: [], changedFiles: [] }; }
  const rows = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
  const diagnostics = [];
  const changedFiles = [];
  for (const row of rows) {
    const file = toRel(cwd, row?.file || '');
    if (row?.format) changedFiles.push(file);
    diagnostics.push(diagnostic({
      file,
      line: row?.line || 0,
      col: row?.col || 0,
      code: String(row?.code || 'PSScriptAnalyzer'),
      message: String(row?.message || ''),
      severity: severityOf(row?.severity),
      fixable: Boolean(row?.format),
    }));
  }
  return { diagnostics, changedFiles: uniquePaths(changedFiles) };
}

async function invoke({ files, cwd, bin, args = [], timeoutMs, signal, write }) {
  const result = await runChunked({
    bin,
    baseArgs: [...args, '-NoProfile', '-NonInteractive', '-Command', SCRIPT],
    files: [],
    withoutFiles: true,
    cwd,
    timeoutMs,
    signal,
    input: JSON.stringify(files),
    env: { ...process.env, MIXDOG_TIDY_PSSA_WRITE: write ? '1' : '0' },
  });
  if (result.error) return spawnFailureResult('psscriptanalyzer', result);
  const parsed = parsePsScriptAnalyzerJson(result.stdout, cwd);
  return { ...parsed, stderrTail: tail(result.stderr) };
}

export const runner = {
  id: 'psscriptanalyzer',
  check: (options) => invoke({ ...options, write: false }),
  fix: (options) => invoke({ ...options, write: true }),
};

export default runner;
