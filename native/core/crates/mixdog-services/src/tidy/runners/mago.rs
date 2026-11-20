//! mago (carthage-software/mago): the formatter one file at a time through stdin (see `stdin`),
//! the linter over paths with its JSON report. The linter says a file failed on an `ERROR` line
//! of stderr and may still exit 0, so that line, not the exit code, is what tells a completed run
//! from one that skipped a file.

use std::path::Path;

use async_trait::async_trait;
use mixdog_js::js_trim;
use serde_json::Value;

use super::shared::*;
use super::stdin::format_each;
use crate::tidy::process::ProcessResult;

/// `mago format --stdin-input`: exit 2 for text it cannot parse and for a `mago.toml` it cannot
/// read. Named with `--stdin-filepath`, a file that configuration excludes comes back unchanged.
async fn format(req: &RunRequest, write: bool) -> RunnerResult {
    let plan = |index: usize| -> Result<Vec<String>, String> { Ok(["format", "--stdin-input", "--stdin-filepath", req.files[index].as_str()].map(String::from).to_vec()) };
    let mut result = format_each(req, "mago", write, &plan).await;
    for finding in &mut result.diagnostics {
        finding.code = "mago/format".to_owned();
    }
    result
}

/// The formatter's and the linter's results over the same files: a file counts as checked when
/// neither left it unprocessed.
fn both(req: &RunRequest, mut first: RunnerResult, second: RunnerResult) -> RunnerResult {
    first.diagnostics.extend(second.diagnostics);
    first.changed_files = unique_paths(first.changed_files.into_iter().chain(second.changed_files));
    for (file, reason) in second.unprocessed {
        if !first.unprocessed.iter().any(|(known, _)| *known == file) {
            first.unprocessed.push((file, reason));
        }
    }
    first.error = first.error.or(second.error);
    first.files_checked = Some(if first.error.is_some() { 0 } else { req.files.len() - first.unprocessed.len() });
    if first.stderr_tail.is_empty() {
        first.stderr_tail = second.stderr_tail;
    }
    first
}

/// Every `safety` an issue's edits carry, at any depth of the edit list.
fn safeties<'a>(edits: &'a Value, found: &mut Vec<&'a str>) {
    match edits {
        Value::Array(items) => items.iter().for_each(|item| safeties(item, found)),
        Value::Object(fields) => {
            found.extend(fields.get("safety").and_then(Value::as_str));
            fields.values().for_each(|value| safeties(value, found));
        }
        _ => {}
    }
}

/// The issues of `mago lint --reporting-format json`; `None` when the output is not that document.
pub fn parse_mago_lint_json(stdout: &str, cwd: &Path) -> Option<Vec<Diagnostic>> {
    let payload: Value = serde_json::from_str(js_trim(stdout)).ok()?;
    let issues = payload.get("issues").and_then(Value::as_array).or_else(|| payload.as_array())?;
    Some(
        issues
            .iter()
            .map(|issue| {
                let span = issue.pointer("/annotations/0/span");
                let name = span.and_then(|s| s.pointer("/file_id/name").or_else(|| s.pointer("/file_id/path"))).and_then(Value::as_str).unwrap_or("");
                // mago reports zero-based lines; the report speaks 1-based everywhere.
                let line = span.and_then(|s| s.pointer("/start/line")).and_then(Value::as_i64).map_or(0, |l| l + 1);
                let code = issue.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("mago");
                // `lint --fix` applies an issue's edits only when all of them are safe.
                let mut found = Vec::new();
                if let Some(edits) = issue.get("edits") {
                    safeties(edits, &mut found);
                }
                diagnostic(DiagnosticInit {
                    file: &to_rel(cwd, name),
                    line,
                    code,
                    message: issue.get("message").and_then(Value::as_str).unwrap_or(""),
                    severity: level_severity(issue.get("level").and_then(Value::as_str).unwrap_or("")),
                    fixable: !found.is_empty() && found.iter().all(|safety| *safety == "safe"),
                    ..Default::default()
                })
            })
            .collect(),
    )
}

/// The `ERROR` lines of mago's log.
fn errors(stderr: &str) -> String {
    strip_ansi(stderr).lines().map(js_trim).filter(|line| line.starts_with("ERROR")).collect::<Vec<_>>().join("\n")
}

/// The reason mago did not complete a group, when it did not: its `ERROR` lines, else an exit code
/// outside `ok`.
fn incomplete(r: &ProcessResult, ok: &[i32]) -> Option<String> {
    let errors = errors(&r.stderr);
    if !errors.is_empty() {
        return Some(errors);
    }
    (!ok.contains(&r.code)).then(|| said(r))
}

fn completed(r: &ProcessResult, ok: &[i32]) -> bool {
    incomplete(r, ok).is_none()
}

pub struct Mago;

#[async_trait]
impl Runner for Mago {
    fn id(&self) -> &'static str {
        "mago"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        // Exit 1 is "found an error-level issue"; a group mago's configuration excludes prints nothing.
        let lint = |r: &ProcessResult, _: &[String]| {
            if let Some(reason) = incomplete(r, &[0, 1]) {
                return Batch::Incomplete(reason);
            }
            match parse_mago_lint_json(&r.stdout, &req.cwd) {
                Some(diagnostics) => Batch::Done(Findings { diagnostics, ..Default::default() }),
                None if js_trim(&r.stdout).is_empty() => Batch::Done(Findings::default()),
                None => Batch::Incomplete(said(r)),
            }
        };
        let formatted = format(req, false).await;
        if formatted.error.is_some() {
            return formatted;
        }
        let linted = run_batches(req, "mago", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["lint", "--reporting-format", "json", "--reporting-target", "stdout"], files), &lint).await;
        both(req, formatted, linted.into_result())
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        // `--fix` refuses the reporting options check passes.
        let linted = run_writes(req, "mago", &["lint", "--fix"], &|r| completed(r, &[0, 1])).await.into_result();
        if linted.error.is_some() {
            return linted;
        }
        both(req, linted, format(req, true).await)
    }
}

#[cfg(test)]
mod tests {
    use super::super::stdin::tests::project;
    use super::*;

    const CWD: &str = "/r";

    #[test]
    fn lint_issues_are_fixable_only_when_every_edit_is_safe() {
        let issue = |safety: &str| format!(r#"{{"level":"Warning","code":"x","message":"m","annotations":[{{"span":{{"file_id":{{"name":"a.php","path":"\\\\?\\C:\\r\\a.php"}},"start":{{"line":4}}}}}}],"edits":[[{{"name":"a.php"}},[{{"range":{{"start":5,"end":5}},"new_text":[10],"safety":"{safety}"}}]]]}}"#);
        let json = format!(r#"{{"issues":[{},{},{{"level":"Error","code":"parse","message":"p","annotations":[]}}]}}"#, issue("safe"), issue("potentiallyunsafe"));
        let rows = parse_mago_lint_json(&json, Path::new(CWD)).unwrap();
        assert_eq!(rows.iter().map(|d| d.fixable).collect::<Vec<_>>(), [true, false, false]);
        assert_eq!((rows[0].file.as_str(), rows[0].line, rows[0].severity.as_str(), rows[2].severity.as_str()), ("a.php", 5, "warning", "error"));
        assert!(parse_mago_lint_json("", Path::new(CWD)).is_none());
    }

    /// A mago that formats `messy` text, cannot parse `bad` text, and lints nothing but says the
    /// linter could not parse a `bad.php` it was given, exiting as if it had finished.
    fn mago(args: &[String], source: &str) -> ProcessResult {
        if args[0] == "format" {
            return match source {
                "bad" => ProcessResult { code: 2, stderr: "ERROR Failed to parse bad.php: Expected one of `Variable`".into(), ..Default::default() },
                "messy" => ProcessResult { stdout: "formatted".into(), ..Default::default() },
                clean => ProcessResult { stdout: clean.to_owned(), ..Default::default() },
            };
        }
        let stderr = if args.iter().any(|a| a == "bad.php") { "\u{1b}[31mERROR\u{1b}[0m Failed to parse file 'bad.php': Expected one of `Variable`".to_owned() } else { String::new() };
        ProcessResult { stdout: r#"{"issues":[]}"#.into(), stderr, ..Default::default() }
    }

    #[tokio::test]
    async fn the_formatter_reads_each_file_in_the_project_and_a_file_either_half_cannot_parse_is_unprocessed_once() {
        let (dir, spawn, req) = project(&[("a.php", "clean"), ("bad.php", "bad"), ("src/c.php", "messy")], &["a.php", "bad.php", "src/c.php"], mago);
        let out = Mago.check(&req).await;
        assert_eq!((out.files_checked, out.changed_files.clone(), out.error.clone()), (Some(2), vec!["src/c.php".to_owned()], None));
        assert_eq!(out.diagnostics.iter().map(|d| (d.file.as_str(), d.code.as_str(), d.fixable)).collect::<Vec<_>>(), [("src/c.php", "mago/format", true)]);
        assert_eq!(out.unprocessed, [("bad.php".to_owned(), "exit 2: ERROR Failed to parse bad.php: Expected one of `Variable`".to_owned())]);
        let calls = spawn.0.lock().unwrap();
        let formatted = calls.iter().find(|(_, _, source)| source == "messy").unwrap();
        assert_eq!((formatted.0.join(" "), formatted.1.as_path()), ("format --stdin-input --stdin-filepath src/c.php".to_owned(), dir.path()));
    }

    #[tokio::test]
    async fn fix_runs_the_fixer_without_the_reporting_options_it_refuses_then_writes_the_formatted_text() {
        let (dir, spawn, req) = project(&[("a.php", "messy")], &["a.php"], mago);
        let out = Mago.fix(&req).await;
        assert_eq!((out.error, out.files_checked, out.unprocessed.len()), (None, Some(1), 0));
        assert_eq!(spawn.0.lock().unwrap().iter().map(|(args, _, _)| args.join(" ")).collect::<Vec<_>>(), ["lint --fix a.php", "format --stdin-input --stdin-filepath a.php"]);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.php")).unwrap(), "formatted");
        let (_dir, _spawn, req) = project(&[("a.php", "x")], &["a.php"], |_, _| ProcessResult { code: 2, stderr: "error: the argument '--fix' cannot be used with: --reporting-format".into(), ..Default::default() });
        let refused = Mago.fix(&req).await;
        assert!(refused.unprocessed[0].1.contains("cannot be used with"), "{:?}", refused.unprocessed);
    }
}
