//! The straightforward engine runners: air, clang-format, dprint, ESLint, ShellCheck, StyLua,
//! rustfmt, Ruff and mago. Each keeps its output parsing in a pure function.

use std::path::Path;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_js::{Caps, JsRegex, js_trim, js_trim_end};
use serde_json::Value;

use super::shared::*;

fn re(cell: &'static OnceLock<JsRegex>, pattern: &str) -> &'static JsRegex {
    cell.get_or_init(|| JsRegex::new_static(pattern, ""))
}

/// Capture group `n` of a match that must have taken part (`m[n]` in JavaScript, never undefined here).
fn group<'t>(m: &Caps<'t>, n: usize) -> &'t str {
    m.get(n).unwrap_or("")
}

fn rows(text: &str) -> Option<Vec<Value>> {
    let t = js_trim(text);
    if t.is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(t).ok()?.as_array().cloned()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---- air (posit-dev/air): `air format --check` lists "Would reformat: <path>" on stderr.

pub fn parse_air_check(stderr: &str, cwd: &Path) -> RunnerResult {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(stderr, re(&R, r"^Would reformat:\s*(.+?)\s*$"), cwd, "air", "air", true)
}

pub struct Air;

#[async_trait]
impl Runner for Air {
    fn id(&self) -> &'static str {
        "air"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["format", "--check"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("air", &r);
        }
        let parsed = parse_air_check(&r.stderr, &req.cwd);
        let t = if parsed.changed_files.is_empty() { tail600(&r.stderr) } else { String::new() };
        parsed.with_stderr(t)
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["format"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("air", &r);
        }
        RunnerResult::default().with_stderr(tail600(&r.stderr))
    }
}

// ---- clang-format: `--dry-run -Werror` reports violations on stderr with positions.

pub fn parse_clang_format_dry_run(stderr: &str, cwd: &Path) -> RunnerResult {
    static R: OnceLock<JsRegex> = OnceLock::new();
    let violation = re(&R, r"^(.*?):(\d+):(\d+):\s*(warning|error):\s*(.*)$");
    let (mut diagnostics, mut changed) = (Vec::new(), Vec::new());
    for line in stderr.lines() {
        let Some(m) = violation.captures(js_trim(line)) else { continue };
        let file = to_rel(cwd, group(&m, 1));
        changed.push(file.clone());
        diagnostics.push(diagnostic(DiagnosticInit {
            file: &file,
            line: group(&m, 2).parse().unwrap_or(0),
            col: group(&m, 3).parse().unwrap_or(0),
            code: "clang-format",
            message: group(&m, 5),
            severity: if group(&m, 4) == "error" { "error" } else { "warning" },
            fixable: true,
        }));
    }
    RunnerResult { diagnostics, changed_files: unique_paths(changed), ..Default::default() }
}

pub struct ClangFormat;

#[async_trait]
impl Runner for ClangFormat {
    fn id(&self) -> &'static str {
        "clang-format"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["--dry-run", "-Werror"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("clang-format", &r);
        }
        let parsed = parse_clang_format_dry_run(&r.stderr, &req.cwd);
        let t = if parsed.diagnostics.is_empty() { tail600(&r.stderr) } else { String::new() };
        parsed.with_stderr(t)
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["-i"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("clang-format", &r);
        }
        RunnerResult::default().with_stderr(tail600(&r.stderr))
    }
}

// ---- dprint: `check` prints a per-file diff block, `fmt` writes.

pub fn parse_dprint_check(output: &str, cwd: &Path) -> RunnerResult {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(output, re(&R, r"^(?:from\s+(.+?):|---\s*(.+?)\s*---)$"), cwd, "dprint", "dprint", false)
}

pub struct Dprint;

#[async_trait]
impl Runner for Dprint {
    fn id(&self) -> &'static str {
        "dprint"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["check"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("dprint", &r);
        }
        let parsed = parse_dprint_check(&format!("{}\n{}", r.stdout, r.stderr), &req.cwd);
        let t = if parsed.changed_files.is_empty() { tail600(&r.stderr) } else { String::new() };
        parsed.with_stderr(t)
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["fmt"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("dprint", &r);
        }
        RunnerResult::default().with_stderr(tail600(&r.stderr))
    }
}

// ---- ESLint: project-local only, JSON formatter; `--fix` applies its own fixes.

pub fn parse_eslint_json(stdout: &str, cwd: &Path) -> RunnerResult {
    let Some(rows) = rows(stdout) else { return RunnerResult::default() };
    let (mut diagnostics, mut changed) = (Vec::new(), Vec::new());
    for row in rows {
        let file = to_rel(cwd, s(&row, "filePath"));
        if number(row.get("fixableErrorCount")) + number(row.get("fixableWarningCount")) > 0 {
            changed.push(file.clone());
        }
        for m in row.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let rule = m.get("ruleId").and_then(Value::as_str).filter(|r| !r.is_empty()).unwrap_or("eslint");
            diagnostics.push(diagnostic(DiagnosticInit {
                file: &file,
                line: number(m.get("line")),
                col: number(m.get("column")),
                code: rule,
                message: s(m, "message"),
                severity: if number(m.get("severity")) == 2 { "error" } else { "warning" },
                fixable: m.get("fix").is_some_and(|f| !f.is_null()),
            }));
        }
    }
    RunnerResult { diagnostics, changed_files: unique_paths(changed), ..Default::default() }
}

pub struct Eslint;

#[async_trait]
impl Runner for Eslint {
    fn id(&self) -> &'static str {
        "eslint"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["-f", "json"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("eslint", &r);
        }
        parse_eslint_json(&r.stdout, &req.cwd).with_stderr(tail600(&r.stderr))
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["--fix", "-f", "json"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("eslint", &r);
        }
        let mut parsed = parse_eslint_json(&r.stdout, &req.cwd);
        parsed.changed_files.clear();
        parsed.with_stderr(tail600(&r.stderr))
    }
}

// ---- ShellCheck: JSON reporter. Lint-only: `fix` re-runs the same read-only analysis.

pub fn parse_shellcheck_json(stdout: &str, cwd: &Path) -> Vec<Diagnostic> {
    rows(stdout)
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let code = match row.get("code") {
                Some(c) if !c.is_null() && *c != 0 && *c != "" => format!("SC{}", c.as_str().map_or_else(|| c.to_string(), str::to_owned)),
                _ => "shellcheck".to_owned(),
            };
            diagnostic(DiagnosticInit {
                file: &to_rel(cwd, s(row, "file")),
                line: number(row.get("line")),
                col: number(row.get("column")),
                code: &code,
                message: s(row, "message"),
                severity: level_severity(s(row, "level")),
                fixable: false,
            })
        })
        .collect()
}

pub struct Shellcheck;

impl Shellcheck {
    async fn analyze(req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["-f", "json"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("shellcheck", &r);
        }
        RunnerResult { diagnostics: parse_shellcheck_json(&r.stdout, &req.cwd), stderr_tail: tail600(&r.stderr), ..Default::default() }
    }
}

#[async_trait]
impl Runner for Shellcheck {
    fn id(&self) -> &'static str {
        "shellcheck"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        Self::analyze(req).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        Self::analyze(req).await
    }
}

// ---- StyLua: `--check` prints a diff per unformatted file; the bare command formats in place.

pub fn parse_stylua_check(output: &str, cwd: &Path) -> RunnerResult {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(output, re(&R, r"^Diff in (.+?):?\s*$"), cwd, "stylua", "stylua", false)
}

pub struct Stylua;

#[async_trait]
impl Runner for Stylua {
    fn id(&self) -> &'static str {
        "stylua"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["--check"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("stylua", &r);
        }
        let parsed = parse_stylua_check(&format!("{}\n{}", r.stdout, r.stderr), &req.cwd);
        let t = if parsed.changed_files.is_empty() { tail600(&r.stderr) } else { String::new() };
        parsed.with_stderr(t)
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &[]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("stylua", &r);
        }
        RunnerResult::default().with_stderr(tail600(&r.stderr))
    }
}

// ---- rustfmt: `--check` prints one "Diff in …" header per block.
//   1.8 and older: `Diff in <path> at line N:`   1.9+: `Diff in <path>:N:` (Windows may prefix `\\?\`)

fn parse_diff_header(line: &str) -> Option<(String, i64)> {
    static LEGACY: OnceLock<JsRegex> = OnceLock::new();
    static MODERN: OnceLock<JsRegex> = OnceLock::new();
    // Unified-diff context lines start with a space; only the CR is dropped.
    let trimmed = js_trim_end(line);
    if let Some(m) = re(&LEGACY, r"^Diff in (.+?) at line (\d+):").captures(trimmed) {
        return Some((group(&m, 1).to_owned(), group(&m, 2).parse().unwrap_or(0)));
    }
    re(&MODERN, r"^Diff in (.+):(\d+):$").captures(trimmed).map(|m| (group(&m, 1).to_owned(), group(&m, 2).parse().unwrap_or(0)))
}

pub fn parse_rustfmt_check(output: &str, cwd: &Path) -> RunnerResult {
    let (mut diagnostics, mut files) = (Vec::new(), Vec::new());
    for line in output.lines() {
        let Some((path, n)) = parse_diff_header(line) else { continue };
        let file = to_rel_long_path(cwd, &path);
        files.push(file.clone());
        diagnostics.push(diagnostic(DiagnosticInit { file: &file, line: n, code: "rustfmt", message: "rustfmt would reformat this block", severity: "warning", fixable: true, ..Default::default() }));
    }
    RunnerResult { diagnostics, changed_files: unique_paths(files), ..Default::default() }
}

pub struct Rustfmt;

#[async_trait]
impl Runner for Rustfmt {
    fn id(&self) -> &'static str {
        "rustfmt"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["--edition", "2021", "--check"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("rustfmt", &r);
        }
        let parsed = parse_rustfmt_check(&r.stdout, &req.cwd);
        if parsed.changed_files.is_empty() && !r.stderr.is_empty() {
            let from_err = parse_rustfmt_check(&r.stderr, &req.cwd);
            if !from_err.changed_files.is_empty() {
                return from_err;
            }
        }
        let t = if parsed.changed_files.is_empty() { tail600(&r.stderr) } else { String::new() };
        parsed.with_stderr(t)
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let r = run_chunked(req, &args_with(req, &["--edition", "2021"]), &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure("rustfmt", &r);
        }
        RunnerResult::default().with_stderr(tail600(&r.stderr))
    }
}

// ---- Ruff: `check --output-format json` + `format --check`.

pub fn parse_ruff_json(stdout: &str, cwd: &Path) -> Vec<Diagnostic> {
    rows(stdout)
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let code = row.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("ruff");
            diagnostic(DiagnosticInit {
                file: &to_rel(cwd, s(row, "filename")),
                line: number(row.pointer("/location/row")),
                col: number(row.pointer("/location/column")),
                code,
                message: s(row, "message"),
                severity: "error",
                fixable: row.get("fix").is_some_and(|f| !f.is_null()),
            })
        })
        .collect()
}

pub fn parse_ruff_format_check(stdout: &str, cwd: &Path) -> Vec<String> {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_pattern_paths(stdout, re(&R, r"^Would reformat:\s*(.+?)\s*$"), cwd, false)
}

pub struct Ruff;

#[async_trait]
impl Runner for Ruff {
    fn id(&self) -> &'static str {
        "ruff"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let lint = run_chunked(req, &args_with(req, &["check", "--output-format", "json", "--no-fix"]), &req.files, false).await;
        if !lint.error.is_empty() {
            return spawn_failure("ruff", &lint);
        }
        let format = run_chunked(req, &args_with(req, &["format", "--check"]), &req.files, false).await;
        RunnerResult {
            diagnostics: parse_ruff_json(&lint.stdout, &req.cwd),
            changed_files: parse_ruff_format_check(&format.stdout, &req.cwd),
            stderr_tail: tail600(&format!("{}\n{}", lint.stderr, format.stderr)),
            ..Default::default()
        }
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let lint = run_chunked(req, &args_with(req, &["check", "--fix"]), &req.files, false).await;
        if !lint.error.is_empty() {
            return spawn_failure("ruff", &lint);
        }
        let format = run_chunked(req, &args_with(req, &["format"]), &req.files, false).await;
        RunnerResult::default().with_stderr(tail600(&format!("{}\n{}", lint.stderr, format.stderr)))
    }
}

// ---- mago (carthage-software/mago): format dry-run headers + lint JSON.

pub fn parse_mago_format_dry_run(output: &str, cwd: &Path) -> RunnerResult {
    static R: OnceLock<JsRegex> = OnceLock::new();
    parse_reformat_report(output, re(&R, r"^diff of '(.+?)':\s*$"), cwd, "mago", "mago/format", true)
}

pub fn parse_mago_lint_json(stdout: &str, cwd: &Path) -> Vec<Diagnostic> {
    let t = js_trim(stdout);
    let Ok(payload) = serde_json::from_str::<Value>(t) else { return Vec::new() };
    let issues: Vec<Value> = payload.get("issues").and_then(Value::as_array).cloned().or_else(|| payload.as_array().cloned()).unwrap_or_default();
    issues
        .iter()
        .map(|issue| {
            let span = issue.pointer("/annotations/0/span");
            let name = span.and_then(|s| s.pointer("/file_id/name").or_else(|| s.pointer("/file_id/path"))).and_then(Value::as_str).unwrap_or("");
            // mago reports zero-based lines; the report speaks 1-based everywhere.
            let line = span.and_then(|s| s.pointer("/start/line")).and_then(Value::as_i64).map_or(0, |l| l + 1);
            let code = issue.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).unwrap_or("mago");
            diagnostic(DiagnosticInit {
                file: &to_rel(cwd, name),
                line,
                code,
                message: s(issue, "message"),
                severity: level_severity(s(issue, "level")),
                fixable: issue.get("edits").and_then(Value::as_array).is_some_and(|e| !e.is_empty()),
                ..Default::default()
            })
        })
        .collect()
}

pub struct Mago;

const MAGO_JSON: [&str; 4] = ["--reporting-format", "json", "--reporting-target", "stdout"];

#[async_trait]
impl Runner for Mago {
    fn id(&self) -> &'static str {
        "mago"
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let format = run_chunked(req, &args_with(req, &["format", "--dry-run"]), &req.files, false).await;
        if !format.error.is_empty() {
            return spawn_failure("mago", &format);
        }
        let lint_args: Vec<&str> = ["lint"].into_iter().chain(MAGO_JSON).collect();
        let lint = run_chunked(req, &args_with(req, &lint_args), &req.files, false).await;
        let mut parsed = parse_mago_format_dry_run(&format!("{}\n{}", format.stdout, format.stderr), &req.cwd);
        parsed.diagnostics.extend(parse_mago_lint_json(&lint.stdout, &req.cwd));
        parsed.with_stderr(tail600(&format!("{}\n{}", format.stderr, lint.stderr)))
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let lint_args: Vec<&str> = ["lint", "--fix"].into_iter().chain(MAGO_JSON).collect();
        let lint = run_chunked(req, &args_with(req, &lint_args), &req.files, false).await;
        if !lint.error.is_empty() {
            return spawn_failure("mago", &lint);
        }
        let format = run_chunked(req, &args_with(req, &["format"]), &req.files, false).await;
        RunnerResult::default().with_stderr(tail600(&format!("{}\n{}", lint.stderr, format.stderr)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CWD: &str = "/r";

    fn cwd() -> &'static Path {
        Path::new(CWD)
    }

    #[test]
    fn reformat_reports_name_files_per_engine() {
        assert_eq!(parse_air_check("\u{1b}[4mWould reformat: a.R\u{1b}[0m\nnoise", cwd()).changed_files, ["a.R"]);
        assert_eq!(parse_stylua_check("Diff in src/a.lua:\n-x\n+y", cwd()).changed_files, ["src/a.lua"]);
        assert_eq!(parse_dprint_check("from a.json:\n--- b.md ---", cwd()).changed_files, ["a.json", "b.md"]);
        let mago = parse_mago_format_dry_run("diff of 'x.php':\n", cwd());
        assert_eq!((mago.changed_files, mago.diagnostics[0].code.as_str()), (vec!["x.php".to_owned()], "mago/format"));
        assert_eq!(parse_ruff_format_check("Would reformat: a.py\n", cwd()), ["a.py"]);
    }

    #[test]
    fn rustfmt_headers_in_both_formats_and_context_lines_are_distinguished() {
        let out = parse_rustfmt_check("Diff in src/a.rs at line 4:\nDiff in src/b.rs:9:\n Diff in src/other.rs:99:\n", cwd());
        assert_eq!(out.changed_files, ["src/a.rs", "src/b.rs"]);
        assert_eq!((out.diagnostics[0].line, out.diagnostics[1].line), (4, 9));
        assert!(parse_rustfmt_check("Diff in \\\\?\\C:\\r\\a.rs:3:\n", Path::new("C:\\r")).changed_files.iter().all(|f| !f.starts_with("\\\\")));
    }

    #[test]
    fn clang_format_violations_carry_positions_and_severity() {
        let out = parse_clang_format_dry_run("src/a.c:3:5: error: code should be clang-formatted [-Wclang-format-violations]\nsrc/a.c:9:1: warning: x\nbad", cwd());
        assert_eq!(out.changed_files, ["src/a.c"]);
        assert_eq!((out.diagnostics[0].line, out.diagnostics[0].col, out.diagnostics[0].severity.as_str()), (3, 5, "error"));
        assert_eq!(out.diagnostics[1].severity, "warning");
    }

    #[test]
    fn eslint_json_yields_messages_and_files_with_fixable_counts() {
        let json = r#"[{"filePath":"/r/a.js","fixableErrorCount":1,"fixableWarningCount":0,"messages":[{"line":2,"column":3,"ruleId":"semi","message":"Missing semicolon.","severity":2,"fix":{"range":[0,1],"text":";"}},{"line":1,"column":1,"ruleId":null,"message":"x","severity":1}]},{"filePath":"/r/b.js","messages":[]}]"#;
        let out = parse_eslint_json(json, cwd());
        assert_eq!(out.changed_files, ["a.js"]);
        assert_eq!((out.diagnostics[0].code.as_str(), out.diagnostics[0].severity.as_str(), out.diagnostics[0].fixable), ("semi", "error", true));
        assert_eq!((out.diagnostics[1].code.as_str(), out.diagnostics[1].severity.as_str()), ("eslint", "warning"));
        assert!(parse_eslint_json("not json", cwd()).diagnostics.is_empty());
    }

    #[test]
    fn shellcheck_ruff_and_mago_json_map_to_diagnostics() {
        let sc = parse_shellcheck_json(r#"[{"file":"/r/a.sh","line":3,"column":2,"code":2086,"level":"info","message":"Quote"}]"#, cwd());
        assert_eq!((sc[0].code.as_str(), sc[0].severity.as_str(), sc[0].file.as_str()), ("SC2086", "info", "a.sh"));
        let ruff = parse_ruff_json(r#"[{"filename":"/r/a.py","code":"F401","message":"unused","location":{"row":1,"column":8},"fix":{"edits":[]}}]"#, cwd());
        assert_eq!((ruff[0].code.as_str(), ruff[0].line, ruff[0].col, ruff[0].fixable), ("F401", 1, 8, true));
        let mago = parse_mago_lint_json(r#"{"issues":[{"level":"Warning","code":"x","message":"m","annotations":[{"span":{"file_id":{"name":"/r/a.php"},"start":{"line":4}}}],"edits":[1]}]}"#, cwd());
        assert_eq!((mago[0].file.as_str(), mago[0].line, mago[0].severity.as_str(), mago[0].fixable), ("a.php", 5, "warning", true));
        assert!(parse_mago_lint_json("", cwd()).is_empty());
    }
}
