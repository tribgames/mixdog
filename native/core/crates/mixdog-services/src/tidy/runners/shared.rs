//! Shared helpers for the engine runners. Every runner has `check` and `fix` returning
//! diagnostics, changed files and a stderr tail, and keeps its output parsing in pure functions
//! so tests drive it from fixture strings without the real engine installed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::{JsRegex, js_trim, utf16_len};
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::tidy::process::{ProcessResult, Processes, RunOptions};

pub const DEFAULT_ENGINE_TIMEOUT: Duration = Duration::from_secs(120);
/// Command lines are bounded (~32k on Windows); long file lists are chunked.
pub const FILES_PER_SPAWN: usize = 80;

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub file: String,
    pub line: i64,
    pub col: i64,
    pub code: String,
    pub message: String,
    pub severity: String,
    pub fixable: bool,
    pub fix_kind: Option<String>,
    pub code_fix: Option<bool>,
}

impl Diagnostic {
    pub fn to_json(&self) -> Value {
        let mut v = json!({"file": self.file, "line": self.line, "col": self.col, "code": self.code, "message": self.message, "severity": self.severity, "fixable": self.fixable});
        if let Some(k) = self.fix_kind.as_ref().filter(|k| !k.is_empty()) {
            v["fixKind"] = json!(k);
        }
        if let Some(c) = self.code_fix {
            v["codeFix"] = json!(c);
        }
        v
    }
}

pub struct DiagnosticInit<'a> {
    pub file: &'a str,
    pub line: i64,
    pub col: i64,
    pub code: &'a str,
    pub message: &'a str,
    pub severity: &'a str,
    pub fixable: bool,
}

impl Default for DiagnosticInit<'_> {
    fn default() -> Self {
        Self { file: "", line: 0, col: 0, code: "", message: "", severity: "error", fixable: false }
    }
}

pub fn diagnostic(init: DiagnosticInit) -> Diagnostic {
    Diagnostic {
        file: init.file.to_owned(),
        line: init.line,
        col: init.col,
        code: init.code.to_owned(),
        message: js_trim(init.message).to_owned(),
        severity: init.severity.to_owned(),
        fixable: init.fixable,
        fix_kind: None,
        code_fix: None,
    }
}

/// The numeric value of a JSON field that may arrive as a number or a numeric string.
pub fn number(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => {
            let n = mixdog_js::string_to_number(s);
            if n.is_finite() { n as i64 } else { 0 }
        }
        _ => 0,
    }
}

#[derive(Debug, Clone, Default)]
pub struct RunnerResult {
    pub diagnostics: Vec<Diagnostic>,
    pub changed_files: Vec<String>,
    pub stderr_tail: String,
    pub error: Option<String>,
    pub truncated: bool,
    pub counts: Option<Value>,
    pub note: Option<String>,
}

impl RunnerResult {
    pub fn with_stderr(mut self, tail_text: String) -> Self {
        self.stderr_tail = tail_text;
        self
    }
}

/// Process spawning behind a seam, so chunking behaviour is testable without real engines.
#[async_trait]
pub trait Spawn: Send + Sync {
    async fn run(&self, bin: &str, args: &[String], cwd: &Path, timeout: Duration, cancel: Option<&CancellationToken>, env: Option<&HashMap<String, String>>, input: Option<Vec<u8>>) -> ProcessResult;
}

pub struct SystemSpawn(pub Processes);

#[async_trait]
impl Spawn for SystemSpawn {
    async fn run(&self, bin: &str, args: &[String], cwd: &Path, timeout: Duration, cancel: Option<&CancellationToken>, env: Option<&HashMap<String, String>>, input: Option<Vec<u8>>) -> ProcessResult {
        let mut options = RunOptions::new(cwd);
        options.timeout = timeout;
        options.cancel = cancel;
        options.env = env;
        options.input = input;
        self.0.run(bin, args, options).await
    }
}

pub struct RunRequest {
    pub files: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub bin: String,
    pub args: Vec<String>,
    pub timeout: Duration,
    pub cancel: Option<CancellationToken>,
    pub module_path: Option<String>,
    pub spawn: Arc<dyn Spawn>,
    pub files_per_spawn: usize,
    /// The lane a runner's own file work (a report it reads, a scratch directory) runs on.
    pub lane: DurabilityIo,
}

impl RunRequest {
    pub fn new(cwd: &Path, bin: &str, files: Vec<String>, spawn: Arc<dyn Spawn>, lane: DurabilityIo) -> Self {
        Self { files, cwd: cwd.to_owned(), bin: bin.to_owned(), args: Vec::new(), timeout: DEFAULT_ENGINE_TIMEOUT, cancel: None, module_path: None, spawn, files_per_spawn: FILES_PER_SPAWN, lane }
    }
}

#[async_trait]
pub trait Runner: Send + Sync {
    fn id(&self) -> &'static str;
    async fn check(&self, req: &RunRequest) -> RunnerResult;
    async fn fix(&self, req: &RunRequest) -> RunnerResult;
}

/// Splits `files` into argv-safe groups. An empty list is one empty chunk.
pub fn chunk_files(files: &[String], size: usize) -> Vec<Vec<String>> {
    if files.is_empty() {
        return vec![Vec::new()];
    }
    files.chunks(size.max(1)).map(<[String]>::to_vec).collect()
}

fn ansi() -> &'static JsRegex {
    static RE: OnceLock<JsRegex> = OnceLock::new();
    RE.get_or_init(|| JsRegex::new_static("\u{1b}\\[[0-9;]*m", "g"))
}

/// Engines colorize the paths they report, so every path-matching parser strips SGR first.
pub fn strip_ansi(text: &str) -> String {
    ansi().replace_all_with(text, |_| String::new())
}

/// `value.slice(-max)`: the last `max` UTF-16 units; a pair cut in half is dropped whole.
pub fn tail(text: &str, max: usize) -> String {
    let value = js_trim(text);
    if utf16_len(value) <= max {
        return value.to_owned();
    }
    let (mut units, mut start) = (0, value.len());
    for (at, c) in value.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        start = at;
    }
    format!("…{}", &value[start..])
}

pub fn tail600(text: &str) -> String {
    tail(text, 600)
}

/// Repo-relative, forward-slash path for report output.
pub fn to_rel(cwd: &Path, file_path: &str) -> String {
    let value = js_trim(file_path);
    if value.is_empty() {
        return String::new();
    }
    // A rooted path without a drive is absolute for engine output on any host.
    let rel = if Path::new(value).is_absolute() || value.starts_with('/') { relative(cwd, Path::new(value)) } else { value.to_owned() };
    let rel = rel.replace('\\', "/");
    rel.strip_prefix("./").unwrap_or(&rel).to_owned()
}

fn relative(base: &Path, target: &Path) -> String {
    let (b, t): (Vec<_>, Vec<_>) = (base.components().collect(), target.components().collect());
    let common = b.iter().zip(&t).take_while(|(x, y)| x == y).count();
    // A different root (another drive) has no relative form.
    if common == 0 {
        return target.to_string_lossy().into_owned();
    }
    let mut parts: Vec<String> = vec!["..".into(); b.len() - common];
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// [`to_rel`] for engines that report Windows long paths (`\\?\C:\…`, `\\?\UNC\…`).
pub fn to_rel_long_path(cwd: &Path, raw: &str) -> String {
    let value = if let Some(rest) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = raw.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        raw.to_owned()
    };
    to_rel(cwd, &value)
}

/// Report severity for an engine level of error / warning / anything else.
pub fn level_severity(level: &str) -> &'static str {
    match level.to_lowercase().as_str() {
        "error" => "error",
        "warning" => "warning",
        _ => "info",
    }
}

/// 1-based line/column of a char offset inside `source`.
pub fn position_at(source: &str, offset: usize) -> (i64, i64) {
    let chars: Vec<char> = source.chars().collect();
    let index = offset.min(chars.len());
    let before = &chars[..index];
    let line = before.iter().filter(|c| **c == '\n').count() as i64 + 1;
    let last_newline = before.iter().rposition(|c| *c == '\n').map_or(0, |p| p + 1);
    (line, (index - last_newline) as i64 + 1)
}

pub struct Chunked {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub error: String,
}

/// Runs one engine over a file list, chunked, and merges the captured output.
pub async fn run_chunked(req: &RunRequest, base_args: &[String], files: &[String], without_files: bool) -> Chunked {
    run_chunked_with(req, base_args, files, without_files, None, None).await
}

pub async fn run_chunked_with(req: &RunRequest, base_args: &[String], files: &[String], without_files: bool, env: Option<&HashMap<String, String>>, input: Option<Vec<u8>>) -> Chunked {
    let chunks = if without_files { vec![Vec::new()] } else { chunk_files(files, req.files_per_spawn) };
    let mut merged = Chunked { code: 0, stdout: String::new(), stderr: String::new(), timed_out: false, truncated: false, error: String::new() };
    for chunk in chunks {
        let args: Vec<String> = base_args.iter().cloned().chain(chunk).collect();
        let result = req.spawn.run(&req.bin, &args, &req.cwd, req.timeout, req.cancel.as_ref(), env, input.clone()).await;
        merged.stdout.push_str(&result.stdout);
        merged.stderr.push_str(&result.stderr);
        merged.timed_out |= result.timed_out;
        merged.truncated |= result.truncated;
        if !result.error.is_empty() && merged.error.is_empty() {
            merged.error = result.error.clone();
        }
        if result.code != 0 {
            merged.code = result.code;
        }
    }
    merged
}

/// The engine could not start (missing binary, EACCES): one actionable diagnostic.
pub fn spawn_failure_result(id: &str, error: &str, timed_out: bool, code: i32, stderr: &str) -> RunnerResult {
    let message = if timed_out { format!("{id} timed out") } else { format!("{id} could not run: {}", if error.is_empty() { format!("exit {code}") } else { error.to_owned() }) };
    RunnerResult {
        diagnostics: vec![diagnostic(DiagnosticInit { code: &format!("{id}/spawn"), message: &message, ..Default::default() })],
        stderr_tail: tail600(stderr),
        ..Default::default()
    }
}

pub fn spawn_failure(id: &str, r: &Chunked) -> RunnerResult {
    spawn_failure_result(id, &r.error, r.timed_out, r.code, &r.stderr)
}

pub fn unique_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter(|p| !p.is_empty() && seen.insert(p.clone())).collect()
}

/// "One unformatted path per line" listing (`shfmt -l`, `prettier -l`).
pub fn parse_path_list(stdout: &str, cwd: &Path) -> Vec<String> {
    unique_paths(stdout.lines().map(js_trim).filter(|l| !l.is_empty() && !l.starts_with('[')).map(|l| to_rel(cwd, l)))
}

/// Paths named by a per-line pattern (rustfmt/stylua diff headers, "Would reformat: <path>").
/// The first non-empty capture group of each matching line is the path.
pub fn parse_pattern_paths(output: &str, pattern: &JsRegex, cwd: &Path, strip: bool) -> Vec<String> {
    let text = if strip { strip_ansi(output) } else { output.to_owned() };
    unique_paths(
        text.lines()
            .filter_map(|line| pattern.captures(js_trim(line)).and_then(|c| (1..=9).find_map(|g| c.get(g).filter(|s| !s.is_empty()).map(str::to_owned))))
            .map(|f| to_rel(cwd, &f)),
    )
}

pub fn reformat_diagnostics(changed: &[String], id: &str, code: &str) -> Vec<Diagnostic> {
    changed
        .iter()
        .map(|file| diagnostic(DiagnosticInit { file, code, message: &format!("{id} would reformat this file"), severity: "warning", fixable: true, ..Default::default() }))
        .collect()
}

/// Check-mode result for a formatter whose output names the files it would rewrite.
pub fn parse_reformat_report(output: &str, pattern: &JsRegex, cwd: &Path, id: &str, code: &str, strip: bool) -> RunnerResult {
    let changed = parse_pattern_paths(output, pattern, cwd, strip);
    RunnerResult { diagnostics: reformat_diagnostics(&changed, id, code), changed_files: changed, ..Default::default() }
}

/// Runner for format-only engines whose check mode lists the files they would rewrite (shfmt -l,
/// gofmt -l, gofumpt -l, prettier --list-different) and whose fix mode writes in place.
pub struct ListFormatter {
    pub id: &'static str,
    pub list_args: &'static [&'static str],
    pub write_args: &'static [&'static str],
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

#[async_trait]
impl Runner for ListFormatter {
    fn id(&self) -> &'static str {
        self.id
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        let args: Vec<String> = req.args.iter().cloned().chain(strings(self.list_args)).collect();
        let r = run_chunked(req, &args, &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure(self.id, &r);
        }
        let changed = parse_path_list(&r.stdout, &req.cwd);
        RunnerResult { diagnostics: reformat_diagnostics(&changed, self.id, self.id), changed_files: changed, stderr_tail: tail600(&r.stderr), ..Default::default() }
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        let args: Vec<String> = req.args.iter().cloned().chain(strings(self.write_args)).collect();
        let r = run_chunked(req, &args, &req.files, false).await;
        if !r.error.is_empty() {
            return spawn_failure(self.id, &r);
        }
        RunnerResult { stderr_tail: tail600(&r.stderr), ..Default::default() }
    }
}

pub fn args_with(req: &RunRequest, extra: &[&str]) -> Vec<String> {
    req.args.iter().cloned().chain(strings(extra)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_chunked_and_empty_is_one_empty_chunk() {
        let files: Vec<String> = (0..5).map(|n| n.to_string()).collect();
        assert_eq!(chunk_files(&files, 2).len(), 3);
        assert_eq!(chunk_files(&[], 80), vec![Vec::<String>::new()]);
        assert_eq!(chunk_files(&files, 0).len(), 5);
    }

    #[test]
    fn paths_are_made_repo_relative_with_forward_slashes() {
        let cwd = Path::new(if cfg!(windows) { "C:\\repo" } else { "/repo" });
        let abs = if cfg!(windows) { "C:\\repo\\src\\a.rs" } else { "/repo/src/a.rs" };
        assert_eq!(to_rel(cwd, abs), "src/a.rs");
        assert_eq!(to_rel(cwd, "./x\\y.rs"), "x/y.rs");
        assert_eq!(to_rel(cwd, "  "), "");
        assert_eq!(to_rel_long_path(Path::new("C:\\repo"), "\\\\?\\C:\\repo\\a.rs"), "a.rs");
    }

    #[test]
    fn ansi_tails_positions_and_levels() {
        assert_eq!(strip_ansi("\u{1b}[4mpath\u{1b}[0m"), "path");
        assert_eq!(tail("  abcdef ", 3), "…def");
        assert_eq!(position_at("ab\ncd", 4), (2, 2));
        assert_eq!(position_at("ab", 99), (1, 3));
        assert_eq!((level_severity("ERROR"), level_severity("warning"), level_severity("note")), ("error", "warning", "info"));
        assert_eq!(number(Some(&json!("7"))), 7);
    }

    #[test]
    fn path_lists_and_patterns_dedupe_in_order() {
        let cwd = Path::new("/r");
        assert_eq!(parse_path_list("a.sh\n[warn] b\n\na.sh\nc.sh\n", cwd), ["a.sh", "c.sh"]);
        let re = JsRegex::new_static(r"^Would reformat:\s*(.+?)\s*$", "");
        assert_eq!(parse_pattern_paths("Would reformat: x.R\nnoise\nWould reformat: x.R\n", &re, cwd, false), ["x.R"]);
        let both = JsRegex::new_static(r"^(?:from\s+(.+?):|---\s*(.+?)\s*---)$", "");
        assert_eq!(parse_pattern_paths("from a.json:\n--- b.md ---", &both, cwd, false), ["a.json", "b.md"]);
    }

    struct Scripted(std::sync::Mutex<Vec<Vec<String>>>, ProcessResult);

    #[async_trait]
    impl Spawn for Scripted {
        async fn run(&self, _: &str, args: &[String], _: &Path, _: Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> ProcessResult {
            self.0.lock().unwrap().push(args.to_vec());
            self.1.clone()
        }
    }

    #[tokio::test]
    async fn list_formatters_chunk_the_files_and_report_listed_ones_as_fixable() {
        let spawn = Arc::new(Scripted(Default::default(), ProcessResult { stdout: "a.sh\n".into(), ..Default::default() }));
        let mut req = RunRequest::new(Path::new("/r"), "shfmt", (0..3).map(|n| format!("f{n}.sh")).collect(), spawn.clone(), mixdog_rt::testing::tokens().durability_io);
        req.files_per_spawn = 2;
        let runner = ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"] };
        let out = runner.check(&req).await;
        assert_eq!(out.changed_files, ["a.sh"]);
        assert!(out.diagnostics[0].fixable);
        assert_eq!(*spawn.0.lock().unwrap(), vec![vec!["-l", "f0.sh", "f1.sh"], vec!["-l", "f2.sh"]]);
        let failing = Arc::new(Scripted(Default::default(), ProcessResult { code: -1, error: "ENOENT".into(), ..Default::default() }));
        req.spawn = failing;
        let failed = runner.fix(&req).await;
        assert_eq!(failed.diagnostics[0].code, "shfmt/spawn");
        assert!(failed.diagnostics[0].message.contains("could not run: ENOENT"));
    }
}
