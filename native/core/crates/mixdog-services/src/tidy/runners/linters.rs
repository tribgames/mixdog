//! The JSON-reporting linters: ESLint and ShellCheck. Both exit 1 for "found something" and
//! higher when they could not lint what they were given.

use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use super::shared::*;
use crate::tidy::process::ProcessResult;

fn rows(stdout: &str) -> Option<Vec<Value>> {
    serde_json::from_str(mixdog_js::js_trim(stdout)).ok()
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn linted(r: &ProcessResult) -> bool {
    r.code == 0 || r.code == 1
}

// ---- ESLint: project-local only, JSON formatter; `--fix` applies its own fixes.

/// The start of the warning ESLint gives, with no rule, for a file its configuration ignores.
const IGNORED: &str = "File ignored";

/// The files of an ESLint JSON report; `None` when the output is not that document.
pub fn parse_eslint_json(stdout: &str, cwd: &Path) -> Option<Findings> {
    let mut found = Findings::default();
    for row in rows(stdout)? {
        let file = to_rel(cwd, text(&row, "filePath"));
        if number(row.get("fixableErrorCount")) + number(row.get("fixableWarningCount")) > 0 {
            found.changed.push(file.clone());
        }
        for m in row.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let rule = m.get("ruleId").and_then(Value::as_str).filter(|r| !r.is_empty());
            if rule.is_none() && text(m, "message").starts_with(IGNORED) {
                found.ignored.push(file.clone());
                continue;
            }
            found.diagnostics.push(diagnostic(DiagnosticInit {
                file: &file,
                line: number(m.get("line")),
                col: number(m.get("column")),
                code: rule.unwrap_or("eslint"),
                message: text(m, "message"),
                severity: if number(m.get("severity")) == 2 { "error" } else { "warning" },
                fixable: m.get("fix").is_some_and(|f| !f.is_null()),
            }));
        }
    }
    found.changed = unique_paths(found.changed);
    Some(found)
}

pub struct Eslint;

#[async_trait]
impl Runner for Eslint {
    fn id(&self) -> &'static str {
        "eslint"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| match parse_eslint_json(&r.stdout, &req.cwd) {
            Some(found) if linted(r) => Batch::Done(found),
            _ => Batch::Incomplete(said(r)),
        };
        run_batches(req, "eslint", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["-f", "json"], files), &read).await.into_result()
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, "eslint", &["--fix"], &linted).await.into_result()
    }
}

// ---- ShellCheck: JSON reporter, lint only.

/// The rows of `shellcheck -f json`; `None` when the output is not that document.
pub fn parse_shellcheck_json(stdout: &str, cwd: &Path) -> Option<Vec<Diagnostic>> {
    Some(
        rows(stdout)?
            .iter()
            .map(|row| {
                let code = match row.get("code") {
                    Some(c) if !c.is_null() && *c != 0 && *c != "" => format!("SC{}", c.as_str().map_or_else(|| c.to_string(), str::to_owned)),
                    _ => "shellcheck".to_owned(),
                };
                diagnostic(DiagnosticInit {
                    file: &to_rel(cwd, text(row, "file")),
                    line: number(row.get("line")),
                    col: number(row.get("column")),
                    code: &code,
                    message: text(row, "message"),
                    severity: level_severity(text(row, "level")),
                    fixable: false,
                })
            })
            .collect(),
    )
}

pub struct Shellcheck;

#[async_trait]
impl Runner for Shellcheck {
    fn id(&self) -> &'static str {
        "shellcheck"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let read = |r: &ProcessResult, _: &[String]| match parse_shellcheck_json(&r.stdout, &req.cwd) {
            Some(diagnostics) if linted(r) => Batch::Done(Findings { diagnostics, ..Default::default() }),
            _ => Batch::Incomplete(said(r)),
        };
        run_batches(req, "shellcheck", &req.files, req.files_per_spawn, &|files| Invocation::over(req, &["-f", "json"], files), &read).await.into_result()
    }
    /// ShellCheck writes nothing: no finding of its is fixable, so no file reaches a fix.
    async fn fix(&self, _: &RunRequest) -> RunnerResult {
        RunnerResult::default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tokio_util::sync::CancellationToken;

    use super::*;

    const CWD: &str = "/r";

    struct Fake(Box<dyn Fn(&[String]) -> ProcessResult + Send + Sync>);

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
            (self.0)(args)
        }
    }

    fn request(files: &[&str], reply: impl Fn(&[String]) -> ProcessResult + Send + Sync + 'static) -> RunRequest {
        RunRequest::new(
            Path::new(CWD),
            "engine",
            files.iter().map(|f| (*f).to_owned()).collect(),
            Arc::new(Fake(Box::new(reply))),
            mixdog_rt::testing::tokens().durability_io,
        )
    }

    #[test]
    fn eslint_json_yields_messages_fixable_files_and_the_files_its_configuration_ignores() {
        let json = r#"[{"filePath":"/r/a.js","fixableErrorCount":1,"fixableWarningCount":0,"messages":[{"line":2,"column":3,"ruleId":"semi","message":"Missing semicolon.","severity":2,"fix":{"range":[0,1],"text":";"}},{"line":1,"column":1,"ruleId":null,"message":"x","severity":1}]},{"filePath":"/r/b.js","messages":[]},{"filePath":"/r/dist/c.js","messages":[{"ruleId":null,"severity":1,"message":"File ignored because of a matching ignore pattern. Use \"--no-ignore\" to disable file ignore settings."}]}]"#;
        let found = parse_eslint_json(json, Path::new(CWD)).unwrap();
        assert_eq!((found.changed, found.ignored), (vec!["a.js".to_owned()], vec!["dist/c.js".to_owned()]));
        assert_eq!((found.diagnostics[0].code.as_str(), found.diagnostics[0].severity.as_str(), found.diagnostics[0].fixable), ("semi", "error", true));
        assert_eq!((found.diagnostics.len(), found.diagnostics[1].code.as_str(), found.diagnostics[1].severity.as_str()), (2, "eslint", "warning"));
        assert!(parse_eslint_json("not json", Path::new(CWD)).is_none());
    }

    #[test]
    fn shellcheck_rows_map_to_diagnostics() {
        let rows = parse_shellcheck_json(r#"[{"file":"/r/a.sh","line":3,"column":2,"code":2086,"level":"info","message":"Quote"}]"#, Path::new(CWD)).unwrap();
        assert_eq!((rows[0].code.as_str(), rows[0].severity.as_str(), rows[0].file.as_str(), rows[0].line), ("SC2086", "info", "a.sh", 3));
    }

    #[tokio::test]
    async fn findings_of_every_spawn_are_kept_and_a_file_shellcheck_could_not_open_is_unprocessed() {
        // One JSON document per spawn; exit 2 with the other files' findings still printed.
        let shellcheck = |args: &[String]| {
            let rows: Vec<Value> = args
                .iter()
                .filter(|a| a.starts_with("warn"))
                .map(|a| serde_json::json!({"file": a, "line": 1, "column": 1, "code": 2086, "level": "info", "message": "Quote"}))
                .collect();
            match args.iter().find(|a| a.starts_with("gone")) {
                Some(gone) => ProcessResult {
                    code: 2,
                    stdout: Value::Array(rows).to_string(),
                    stderr: format!("{gone}: openBinaryFile: does not exist"),
                    ..Default::default()
                },
                None => ProcessResult { code: i32::from(!rows.is_empty()), stdout: Value::Array(rows).to_string(), ..Default::default() },
            }
        };
        let mut req = request(&["warn1.sh", "warn2.sh", "gone.sh", "warn3.sh"], shellcheck);
        req.files_per_spawn = 2;
        let out = Shellcheck.check(&req).await;
        assert_eq!((out.files_checked, out.diagnostics.len(), out.error.clone()), (Some(3), 3, None));
        assert_eq!(out.unprocessed.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(), ["gone.sh"]);
    }

    #[tokio::test]
    async fn an_eslint_that_cannot_lint_is_a_failure_and_ignored_files_are_not_counted_as_checked() {
        let fatal = |_: &[String]| ProcessResult {
            code: 2,
            stderr: "Oops! Something went wrong! ESLint couldn't find a configuration file.".into(),
            ..Default::default()
        };
        assert!(Eslint.check(&request(&["a.js", "b.js"], fatal)).await.error.is_some_and(|e| e.contains("configuration file")));
        let ignoring = |_: &[String]| {
            ProcessResult { stdout: r#"[{"filePath":"/r/a.js","messages":[]},{"filePath":"/r/dist/c.js","messages":[{"ruleId":null,"severity":1,"message":"File ignored by default."}]}]"#.into(), ..Default::default() }
        };
        let out = Eslint.check(&request(&["a.js", "dist/c.js"], ignoring)).await;
        assert_eq!((out.files_checked, out.ignored.clone(), out.diagnostics.len()), (Some(1), vec!["dist/c.js".to_owned()], 0));
    }
}
