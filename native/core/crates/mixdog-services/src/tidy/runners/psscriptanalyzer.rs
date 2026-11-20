//! PSScriptAnalyzer — `Invoke-ScriptAnalyzer` for diagnostics and `Invoke-Formatter` for
//! formatting, through pwsh/powershell. The script text is a fixed literal: file paths arrive as
//! JSON on stdin, never interpolated, so no path can become PowerShell code. Write mode is
//! selected by an environment flag, not by editing the script.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use super::shared::*;
use crate::tidy::process::ProcessResult;

/// Invoke-ScriptAnalyzer is slow enough that 20+ files in one 120s spawn times out.
const FILES_PER_SPAWN_PS: usize = 4;

/// The paths come in, and the report goes out, as UTF-8 whatever the console's code page (a
/// Korean Windows reads and prints cp949, which turns a non-ASCII file name into another one).
/// Per file: read it in the encoding its byte order mark names (UTF-8 without one; bytes that are
/// not UTF-8 fail the file, since its encoding could not be kept), format it only when it parses
/// (the formatter rewrites the text of a script that does not), compare case-sensitively (the
/// formatter corrects letter case), write back in the encoding it was read in, then analyze it
/// under the project's settings file when the project has one.
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$module = $env:MIXDOG_TIDY_PSSA_MODULE
if (-not [string]::IsNullOrWhiteSpace($module)) { Import-Module -Name $module -Force -ErrorAction Stop }
$out = New-Object System.Collections.ArrayList
$write = $env:MIXDOG_TIDY_PSSA_WRITE -eq '1'
$analyze = @{}
$settings = Join-Path (Get-Location).ProviderPath 'PSScriptAnalyzerSettings.psd1'
if (Test-Path -LiteralPath $settings -PathType Leaf) { $analyze['Settings'] = $settings }
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$paths = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
foreach ($p in $paths) {
  try {
    $full = (Resolve-Path -LiteralPath $p).ProviderPath
    $reader = New-Object System.IO.StreamReader($full, $utf8, $true)
    try { $text = $reader.ReadToEnd(); $encoding = $reader.CurrentEncoding } finally { $reader.Dispose() }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -eq 0 -and $text.Length -gt 0) {
      $formatted = Invoke-Formatter -ScriptDefinition $text
      if ($formatted -cne $text) {
        if ($write) { [System.IO.File]::WriteAllText($full, $formatted, $encoding) }
        else { [void]$out.Add([pscustomobject]@{ file = $p; line = 0; col = 0; code = 'PSFormatting'; message = 'Invoke-Formatter would reformat this file'; severity = 'Warning'; format = $true; failed = $false }) }
      }
    }
    foreach ($d in @(Invoke-ScriptAnalyzer -Path ([WildcardPattern]::Escape($full)) @analyze)) {
      [void]$out.Add([pscustomobject]@{ file = $p; line = $d.Line; col = $d.Column; code = "$($d.RuleName)"; message = "$($d.Message)"; severity = "$($d.Severity)"; format = $false; failed = $false })
    }
  } catch {
    [void]$out.Add([pscustomobject]@{ file = $p; line = 0; col = 0; code = 'PSScriptAnalyzer'; message = "$($_.Exception.Message)"; severity = 'Error'; format = $false; failed = $true })
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

/// What the fixed script printed for one group of files.
#[derive(Debug, Default)]
pub struct Payload {
    pub findings: Findings,
    /// Files the script could not read, format or analyze, each with the error it caught.
    pub failed: Vec<(String, String)>,
    /// The module the script ran.
    pub module: Option<String>,
}

/// Parses the fixed script's JSON payload; `None` when the output is not that document (the
/// script itself failed: no module, a host that cannot run it).
pub fn parse_psscriptanalyzer_json(stdout: &str, cwd: &Path) -> Option<Payload> {
    let payload: Value = serde_json::from_str(mixdog_js::js_trim(stdout)).ok()?;
    let mut out = Payload { module: payload.get("modulePath").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_owned), ..Default::default() };
    for row in payload.get("diagnostics")?.as_array()? {
        let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or("");
        let flag = |key: &str| row.get(key).and_then(Value::as_bool).unwrap_or(false);
        let file = to_rel(cwd, text("file"));
        if flag("failed") {
            out.failed.push((file, text("message").to_owned()));
            continue;
        }
        if flag("format") {
            out.findings.changed.push(file.clone());
        }
        out.findings.diagnostics.push(diagnostic(DiagnosticInit {
            file: &file,
            line: number(row.get("line")),
            col: number(row.get("col")),
            code: Some(text("code")).filter(|c| !c.is_empty()).unwrap_or("PSScriptAnalyzer"),
            message: text("message"),
            severity: severity_of(text("severity")),
            fixable: flag("format"),
        }));
    }
    Some(out)
}

async fn invoke(req: &RunRequest, write: bool) -> RunnerResult {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("MIXDOG_TIDY_PSSA_WRITE".into(), if write { "1" } else { "0" }.into());
    env.insert("MIXDOG_TIDY_PSSA_MODULE".into(), req.module_path.clone().unwrap_or_default());
    let base: Vec<String> = req.args.iter().cloned().chain(["-NoProfile", "-NonInteractive", "-Command", SCRIPT].map(String::from)).collect();
    let plan = |files: &[String]| Invocation { args: base.clone(), env: Some(env.clone()), input: Some(serde_json::to_vec(files).expect("paths serialize")) };
    // The script settles each file itself, so a group it answers for is complete whatever its files did.
    let (failed, loaded) = (Mutex::new(Vec::new()), Mutex::new(None));
    let read = |r: &ProcessResult, _: &[String]| match parse_psscriptanalyzer_json(&r.stdout, &req.cwd) {
        Some(payload) => {
            failed.lock().expect("no panic holds it").extend(payload.failed);
            if payload.module.is_some() {
                *loaded.lock().expect("no panic holds it") = payload.module;
            }
            Batch::Done(payload.findings)
        }
        // The script prints its report last: with nothing printed it did not get through its files
        // at all (the module did not load, the host refused the script).
        None if r.code != 0 && mixdog_js::js_trim(&r.stdout).is_empty() => Batch::Refused(said(r)),
        None => Batch::Incomplete(said(r)),
    };
    let command = if write { Command::Writes } else { Command::Reads };
    let mut pass = run_groups(req, "psscriptanalyzer", command, &req.files, FILES_PER_SPAWN_PS, &plan, &read).await;
    let failed = failed.into_inner().expect("no panic holds it");
    pass.processed -= failed.len();
    pass.unprocessed.extend(failed);
    let note = loaded.into_inner().expect("no panic holds it").map(|module| format!("PSScriptAnalyzer module: {module}"));
    RunnerResult { note, ..pass.into_result() }
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
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

    use super::*;

    #[test]
    fn the_scripts_json_payload_maps_formatting_analyzer_and_failed_rows() {
        let payload = r#"{"diagnostics":[{"file":"/r/a.ps1","line":0,"col":0,"code":"PSFormatting","message":"m","severity":"Warning","format":true,"failed":false},{"file":"/r/a.ps1","line":3,"col":1,"code":"PSAvoidUsingWriteHost","message":"x","severity":"ParseError","format":false,"failed":false},{"file":"/r/b.ps1","line":0,"col":0,"code":"PSScriptAnalyzer","message":"Unable to translate bytes","severity":"Error","format":false,"failed":true}],"modulePath":"/m/PSScriptAnalyzer.psd1"}"#;
        let out = parse_psscriptanalyzer_json(payload, Path::new("/r")).unwrap();
        assert_eq!(out.findings.changed, ["a.ps1"]);
        assert_eq!((out.findings.diagnostics.len(), out.findings.diagnostics[0].fixable, out.findings.diagnostics[1].severity.as_str(), out.findings.diagnostics[1].line), (2, true, "error", 3));
        assert_eq!(out.failed, [("b.ps1".to_owned(), "Unable to translate bytes".to_owned())]);
        assert_eq!(out.module.as_deref(), Some("/m/PSScriptAnalyzer.psd1"));
        assert!(parse_psscriptanalyzer_json("", Path::new("/r")).is_none());
    }

    #[test]
    fn paths_never_enter_the_script_text() {
        assert!(!SCRIPT.contains("{0}") && SCRIPT.contains("[Console]::In.ReadToEnd()"));
    }

    struct Fake(Box<dyn Fn(&[String]) -> ProcessResult + Send + Sync>);

    #[async_trait]
    impl Spawn for Fake {
        async fn run(&self, _: &str, _: &[String], _: &Path, _: std::time::Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, input: Option<Vec<u8>>) -> ProcessResult {
            (self.0)(&serde_json::from_slice::<Vec<String>>(&input.unwrap()).unwrap())
        }
    }

    fn request(files: &[&str], reply: impl Fn(&[String]) -> ProcessResult + Send + Sync + 'static) -> RunRequest {
        RunRequest::new(Path::new("/r"), "pwsh", files.iter().map(|f| (*f).to_owned()).collect(), Arc::new(Fake(Box::new(reply))), mixdog_rt::testing::tokens().durability_io)
    }

    #[tokio::test]
    async fn a_file_the_script_failed_on_is_unprocessed_and_a_script_that_printed_no_report_is_a_failure() {
        let script = |files: &[String]| {
            let rows: Vec<Value> = files.iter().filter(|f| f.starts_with("bad")).map(|f| serde_json::json!({"file": f, "code": "PSScriptAnalyzer", "message": "not UTF-8", "severity": "Error", "format": false, "failed": true})).collect();
            ProcessResult { stdout: serde_json::json!({"diagnostics": rows, "modulePath": "/m/PSSA.psd1"}).to_string(), ..Default::default() }
        };
        let out = PsScriptAnalyzer.check(&request(&["a.ps1", "bad.ps1", "c.ps1", "d.ps1", "e.ps1"], script)).await;
        assert_eq!((out.files_checked, out.unprocessed.clone(), out.error.clone()), (Some(4), vec![("bad.ps1".to_owned(), "not UTF-8".to_owned())], None));
        assert_eq!(out.note.as_deref(), Some("PSScriptAnalyzer module: /m/PSSA.psd1"));
        let no_module = |_: &[String]| ProcessResult { code: 1, stderr: "Import-Module: The specified module 'PSScriptAnalyzer' was not loaded".into(), ..Default::default() };
        let failed = PsScriptAnalyzer.fix(&request(&["a.ps1", "b.ps1"], no_module)).await;
        assert!(failed.error.as_deref().is_some_and(|e| e.contains("was not loaded")), "{:?}", failed.error);
        // A write whose report was cut is not run again over files it has already written.
        let calls = Arc::new(std::sync::Mutex::new(0));
        let seen = calls.clone();
        let cut = move |_: &[String]| {
            *seen.lock().unwrap() += 1;
            ProcessResult { stdout: "{\"diagnostics\":[{\"file\":".into(), truncated: true, ..Default::default() }
        };
        let written = PsScriptAnalyzer.fix(&request(&["a.ps1", "b.ps1"], cut)).await;
        assert_eq!((*calls.lock().unwrap(), written.files_checked, written.unprocessed.len(), written.error), (1, Some(0), 2, None));
    }
}
