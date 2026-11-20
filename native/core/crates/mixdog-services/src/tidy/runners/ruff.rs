//! Ruff: `check` for lint findings (JSON) and `format --diff` for the files it would reformat.
//! The diff is the one report of the formatter that has kept its shape across versions: the text
//! of `format --check` has not, and its JSON form is recent.

use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use super::shared::*;
use crate::tidy::process::ProcessResult;

/// Ruff lints and formats a path it is handed even when the project excludes it, unless told
/// `--force-exclude`; told that, it skips the file without a word. So it is asked first which of
/// the files it would touch, and only those are run.
const SELECT: [&str; 3] = ["check", "--show-files", "--force-exclude"];

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The rows of `ruff check --output-format json`; `None` when the output is not that document.
pub fn parse_ruff_json(stdout: &str, cwd: &Path) -> Option<Vec<Diagnostic>> {
    let rows: Vec<Value> = serde_json::from_str(mixdog_js::js_trim(stdout)).ok()?;
    Some(
        rows.iter()
            .map(|row| {
                let code = row.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("ruff");
                // `ruff check --fix --no-unsafe-fixes` applies safe fixes only; an unsafe or display-only fix is not one apply makes.
                let applicability = row.pointer("/fix/applicability").and_then(Value::as_str).unwrap_or("");
                diagnostic(DiagnosticInit {
                    file: &to_rel(cwd, text(row, "filename")),
                    line: number(row.pointer("/location/row")),
                    col: number(row.pointer("/location/column")),
                    code,
                    message: text(row, "message"),
                    severity: "error",
                    fixable: applicability == "safe",
                })
            })
            .collect(),
    )
}

/// The files `ruff format --diff` printed a diff for: a `--- <path>` line directly above the
/// `+++ <path>` line of the same path.
pub fn parse_ruff_format_diff(stdout: &str, cwd: &Path) -> Vec<String> {
    let lines: Vec<&str> = stdout.lines().collect();
    unique_paths(lines.windows(2).filter_map(|pair| {
        let from = pair[0].strip_prefix("--- ")?;
        (pair[1].strip_prefix("+++ ")? == from).then(|| to_rel(cwd, from))
    }))
}

fn found_or_clean(r: &ProcessResult) -> bool {
    r.code == 0 || r.code == 1
}

pub struct Ruff;

#[async_trait]
impl Runner for Ruff {
    fn id(&self) -> &'static str {
        "ruff"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let (selected, ignored) = match selected_files(req, "ruff", &SELECT, exited_zero).await {
            Ok(split) => split,
            Err(why) => return engine_stopped(why),
        };
        let lint = |r: &ProcessResult, _: &[String]| match parse_ruff_json(&r.stdout, &req.cwd) {
            Some(diagnostics) if found_or_clean(r) => Batch::Done(Findings { diagnostics, ..Default::default() }),
            _ => Batch::Incomplete(said(r)),
        };
        let format = |r: &ProcessResult, _: &[String]| {
            if !found_or_clean(r) {
                return Batch::Incomplete(said(r));
            }
            let changed = parse_ruff_format_diff(&r.stdout, &req.cwd);
            Batch::Done(Findings { diagnostics: reformat_diagnostics(&changed, "ruff", "ruff/format"), changed, ..Default::default() })
        };
        let linted = run_batches(
            req,
            "ruff",
            &selected,
            req.files_per_spawn,
            &|files| Invocation::over(req, &["check", "--output-format", "json", "--no-fix", "--force-exclude"], files),
            &lint,
        )
        .await;
        if linted.failure.is_some() {
            return linted.into_result();
        }
        let formatted =
            run_batches(req, "ruff", &selected, req.files_per_spawn, &|files| Invocation::over(req, &["format", "--diff", "--force-exclude"], files), &format)
                .await;
        RunnerResult { ignored, ..linted.and(formatted).into_result() }
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let linted = run_writes(req, "ruff", &["check", "--fix", "--no-unsafe-fixes", "--force-exclude"], &found_or_clean).await;
        if linted.failure.is_some() {
            return linted.into_result();
        }
        linted.and(run_writes(req, "ruff", &["format", "--force-exclude"], &exited_zero).await).into_result()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use tokio_util::sync::CancellationToken;

    use super::*;

    const CWD: &str = "/r";

    /// Answers each spawn from its arguments and records them.
    struct Fake(Mutex<Vec<Vec<String>>>, Box<dyn Fn(&[String]) -> ProcessResult + Send + Sync>);

    #[async_trait]
    impl Spawn for Fake {
        async fn run(
            &self,
            _: &str,
            args: &[String],
            _: &Path,
            _: std::time::Duration,
            _: Option<&CancellationToken>,
            _: Option<&HashMap<String, String>>,
            _: Option<Vec<u8>>,
        ) -> ProcessResult {
            self.0.lock().unwrap().push(args.to_vec());
            (self.1)(args)
        }
    }

    fn request(files: &[&str], reply: impl Fn(&[String]) -> ProcessResult + Send + Sync + 'static) -> (Arc<Fake>, RunRequest) {
        let spawn = Arc::new(Fake(Mutex::default(), Box::new(reply)));
        (
            spawn.clone(),
            RunRequest::new(Path::new(CWD), "ruff", files.iter().map(|f| (*f).to_owned()).collect(), spawn, mixdog_rt::testing::tokens().durability_io),
        )
    }

    fn files_of(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).filter(|a| a.ends_with(".py")).collect()
    }

    /// A ruff whose project excludes `gen/`, that cannot parse `bad.py`, and would reformat `messy.py`.
    fn ruff(args: &[String]) -> ProcessResult {
        let files = files_of(args);
        if args.contains(&"--show-files".to_owned()) {
            return ProcessResult { stdout: files.iter().filter(|f| !f.starts_with("gen/")).map(|f| format!("/r/{f}\n")).collect(), ..Default::default() };
        }
        if args[0] == "check" {
            let rows: Vec<Value> = files.iter().filter(|f| **f == "messy.py").map(|f| serde_json::json!({"filename": format!("/r/{f}"), "code": "F401", "message": "unused", "location": {"row": 1, "column": 8}, "fix": {"applicability": "safe"}})).collect();
            return ProcessResult { code: i32::from(!rows.is_empty()), stdout: Value::Array(rows).to_string(), ..Default::default() };
        }
        let diff: String = files.iter().filter(|f| **f == "messy.py").map(|f| format!("--- {f}\n+++ {f}\n@@ -1 +1 @@\n-x=1\n+x = 1\n\n")).collect();
        match files.iter().find(|f| **f == "bad.py") {
            Some(bad) => {
                ProcessResult { code: 2, stdout: diff, stderr: format!("error: Failed to parse {bad}:1:7: Expected a parameter"), ..Default::default() }
            }
            None => ProcessResult { code: i32::from(!diff.is_empty()), stdout: diff, ..Default::default() },
        }
    }

    #[test]
    fn json_rows_mark_only_safe_fixes_fixable_and_anything_else_is_not_a_report() {
        let row = |code: &str, fix: &str| format!(r#"{{"filename":"/r/a.py","code":"{code}","message":"m","location":{{"row":1,"column":8}},"fix":{fix}}}"#);
        let json = format!(
            "[{},{},{},{}]",
            row("F401", r#"{"applicability":"safe","edits":[]}"#),
            row("F841", r#"{"applicability":"unsafe","edits":[]}"#),
            row("X1", r#"{"applicability":"display_only","edits":[]}"#),
            row("E501", "null")
        );
        let rows = parse_ruff_json(&json, Path::new(CWD)).unwrap();
        assert_eq!(rows.iter().map(|d| d.fixable).collect::<Vec<_>>(), [true, false, false, false]);
        assert_eq!((rows[0].file.as_str(), rows[0].code.as_str(), rows[0].line, rows[0].col), ("a.py", "F401", 1, 8));
        assert!(parse_ruff_json("", Path::new(CWD)).is_none() && parse_ruff_json("[][]", Path::new(CWD)).is_none());
    }

    #[test]
    fn a_diff_names_its_file_and_a_removed_line_that_looks_like_a_header_does_not() {
        let diff = "--- src/a.py\n+++ src/a.py\n@@ -1,2 +1,2 @@\n--- not a header\n+x = 1\n--- b.py\n+++ b.py\n";
        assert_eq!(parse_ruff_format_diff(diff, Path::new(CWD)), ["src/a.py", "b.py"]);
    }

    #[tokio::test]
    async fn check_reports_formatting_excluded_files_and_the_file_ruff_could_not_parse() {
        let (spawn, req) = request(&["messy.py", "gen/g.py", "ok.py", "bad.py"], ruff);
        let out = Ruff.check(&req).await;
        assert_eq!((out.files_checked, out.ignored.clone(), out.error.clone()), (Some(2), vec!["gen/g.py".to_owned()], None));
        assert_eq!(out.changed_files, ["messy.py"]);
        assert_eq!(out.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["F401", "ruff/format"]);
        assert_eq!(out.unprocessed.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(), ["bad.py"]);
        assert!(out.unprocessed[0].1.contains("Failed to parse bad.py"));
        assert!(spawn.0.lock().unwrap().iter().skip(1).all(|args| !files_of(args).contains(&"gen/g.py")), "an excluded file is never linted or formatted");
    }

    #[tokio::test]
    async fn findings_survive_any_number_of_spawns() {
        let (_spawn, mut req) = request(&["messy.py", "ok.py", "messy.py"], ruff);
        req.files_per_spawn = 1;
        let out = Ruff.check(&req).await;
        assert_eq!((out.files_checked, out.diagnostics.iter().filter(|d| d.code == "F401").count()), (Some(3), 2));
    }

    #[tokio::test]
    async fn fix_applies_safe_fixes_only_and_fails_when_ruff_does() {
        let (spawn, req) = request(&["messy.py"], |_| ProcessResult::default());
        assert!(Ruff.fix(&req).await.error.is_none());
        let calls = spawn.0.lock().unwrap().clone();
        assert_eq!(calls, [vec!["check", "--fix", "--no-unsafe-fixes", "--force-exclude", "messy.py"], vec!["format", "--force-exclude", "messy.py"]]);
        let (_spawn, req) = request(&["messy.py"], |args| ProcessResult {
            code: if args[0] == "format" { 2 } else { 0 },
            stderr: "error: Failed to parse messy.py".into(),
            ..Default::default()
        });
        let failed = Ruff.fix(&req).await;
        assert_eq!(failed.unprocessed.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(), ["messy.py"]);
        let (_spawn, req) = request(&["a.py", "b.py"], |_| ProcessResult { code: 2, stderr: "error: invalid configuration".into(), ..Default::default() });
        assert!(Ruff.check(&req).await.error.is_some_and(|e| e.contains("invalid configuration")));
    }
}
