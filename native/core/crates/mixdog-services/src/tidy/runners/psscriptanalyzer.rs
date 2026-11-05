//! PSScriptAnalyzer — `Invoke-ScriptAnalyzer` for diagnostics and `Invoke-Formatter` for
//! formatting, through pwsh/powershell. The script text is a fixed literal: file paths arrive as
//! JSON on stdin, never interpolated, so no path can become PowerShell code. Write mode is
//! selected by an environment flag, not by editing the script.

use std::collections::HashMap;
use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use super::shared::*;

/// Invoke-ScriptAnalyzer is slow enough that 20+ files in one 120s spawn times out.
const FILES_PER_SPAWN_PS: usize = 4;

const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$module = $env:MIXDOG_TIDY_PSSA_MODULE
if (-not [string]::IsNullOrWhiteSpace($module)) { Import-Module -Name $module -Force -ErrorAction Stop }
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
$loaded = ''
try { $loaded = [string]((Get-Module PSScriptAnalyzer).Path) } catch {}
ConvertTo-Json -InputObject @{ diagnostics = @($out); modulePath = $loaded } -Depth 4 -Compress
"#;

fn severity_of(value: &str) -> &'static str {
    match value.to_lowercase().as_str() {
        "error" | "parseerror" => "error",
        "warning" => "warning",
        _ => "info",
    }
}

/// Parses the fixed script's JSON payload; `note` carries the loaded module path.
pub fn parse_psscriptanalyzer_json(stdout: &str, cwd: &Path) -> (RunnerResult, Option<String>) {
    let Ok(payload) = serde_json::from_str::<Value>(mixdog_js::js_trim(stdout)) else { return (RunnerResult::default(), None) };
    let (mut diagnostics, mut changed) = (Vec::new(), Vec::new());
    for row in payload.get("diagnostics").and_then(Value::as_array).into_iter().flatten() {
        let file = to_rel(cwd, row.get("file").and_then(Value::as_str).unwrap_or(""));
        let format = row.get("format").and_then(Value::as_bool).unwrap_or(false);
        if format {
            changed.push(file.clone());
        }
        let code = row.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("PSScriptAnalyzer");
        diagnostics.push(diagnostic(DiagnosticInit {
            file: &file,
            line: number(row.get("line")),
            col: number(row.get("col")),
            code,
            message: row.get("message").and_then(Value::as_str).unwrap_or(""),
            severity: severity_of(row.get("severity").and_then(Value::as_str).unwrap_or("")),
            fixable: format,
        }));
    }
    let module = payload.get("modulePath").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned);
    (RunnerResult { diagnostics, changed_files: unique_paths(changed), ..Default::default() }, module)
}

async fn invoke(req: &RunRequest, write: bool) -> RunnerResult {
    let (mut diagnostics, mut changed, mut stderr, mut loaded) = (Vec::new(), Vec::new(), String::new(), String::new());
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("MIXDOG_TIDY_PSSA_WRITE".into(), if write { "1" } else { "0" }.into());
    env.insert("MIXDOG_TIDY_PSSA_MODULE".into(), req.module_path.clone().unwrap_or_default());
    let base: Vec<String> = req.args.iter().cloned().chain(["-NoProfile", "-NonInteractive", "-Command", SCRIPT].map(String::from)).collect();
    for chunk in chunk_files(&req.files, FILES_PER_SPAWN_PS) {
        if chunk.is_empty() {
            continue;
        }
        let input = serde_json::to_vec(&chunk).expect("paths serialize");
        let r = run_chunked_with(req, &base, &[], true, Some(&env), Some(input)).await;
        if !r.error.is_empty() {
            return spawn_failure("psscriptanalyzer", &r);
        }
        let (parsed, module) = parse_psscriptanalyzer_json(&r.stdout, &req.cwd);
        diagnostics.extend(parsed.diagnostics);
        changed.extend(parsed.changed_files);
        if let Some(m) = module {
            loaded = m;
        }
        stderr.push_str(&r.stderr);
    }
    RunnerResult { diagnostics, changed_files: unique_paths(changed), stderr_tail: tail600(&stderr), note: (!loaded.is_empty()).then(|| format!("PSScriptAnalyzer module: {loaded}")), ..Default::default() }
}

pub struct PsScriptAnalyzer;

#[async_trait]
impl Runner for PsScriptAnalyzer {
    fn id(&self) -> &'static str {
        "psscriptanalyzer"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        invoke(req, false).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        invoke(req, true).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scripts_json_payload_maps_formatting_and_analyzer_rows() {
        let payload = r#"{"diagnostics":[{"file":"/r/a.ps1","line":0,"col":0,"code":"PSFormatting","message":"m","severity":"Warning","format":true},{"file":"/r/a.ps1","line":3,"col":1,"code":"PSAvoidUsingWriteHost","message":"x","severity":"ParseError","format":false}],"modulePath":"/m/PSScriptAnalyzer.psd1"}"#;
        let (out, module) = parse_psscriptanalyzer_json(payload, Path::new("/r"));
        assert_eq!(out.changed_files, ["a.ps1"]);
        assert_eq!((out.diagnostics[0].fixable, out.diagnostics[1].severity.as_str(), out.diagnostics[1].line), (true, "error", 3));
        assert_eq!(module.as_deref(), Some("/m/PSScriptAnalyzer.psd1"));
        assert!(parse_psscriptanalyzer_json("", Path::new("/r")).0.diagnostics.is_empty());
    }

    #[test]
    fn paths_never_enter_the_script_text() {
        assert!(!SCRIPT.contains("{0}") && SCRIPT.contains("[Console]::In.ReadToEnd()"));
    }
}
