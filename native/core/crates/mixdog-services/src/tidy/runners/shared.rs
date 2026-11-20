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

use crate::lane::on_lane;
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
    /// The runner threw (Node: an exception out of `runner.check` / `runner.fix`, e.g. a cleanup in a `finally`):
    /// the engine reports it as the engine's error alone, with nothing checked (`run-engines.mjs:134-142`).
    pub thrown: bool,
    pub truncated: bool,
    pub counts: Option<Value>,
    pub note: Option<String>,
    /// Files the engine actually processed; `None` means every requested file when it ran cleanly
    /// and none when it failed.
    pub files_checked: Option<usize>,
    /// Requested files the engine did not process because its own configuration ignores them.
    pub ignored: Vec<String>,
    /// Requested files the engine could not process (unreadable, unparsable), each with the reason
    /// it gave. `error` is for an engine that could not run; these are files of one that did.
    pub unprocessed: Vec<(String, String)>,
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
    #[allow(clippy::too_many_arguments, reason = "Preserve the public process-runner port and its independent timeout, cancellation, environment and input arguments for existing implementers")]
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

/// Repo-relative, forward-slash path for report output. Engines on Windows also print long-path
/// forms (`\\?\C:\…`, `\\?\UNC\…`); those are read as the plain path.
pub fn to_rel(cwd: &Path, file_path: &str) -> String {
    let value = js_trim(file_path);
    if value.is_empty() {
        return String::new();
    }
    let plain = match value.strip_prefix("\\\\?\\UNC\\") {
        Some(rest) => format!("\\\\{rest}"),
        None => value.strip_prefix("\\\\?\\").unwrap_or(value).to_owned(),
    };
    // A rooted path without a drive is absolute for engine output on any host.
    let rel = if Path::new(&plain).is_absolute() || plain.starts_with('/') { relative(cwd, Path::new(&plain)) } else { plain };
    let rel = rel.replace('\\', "/");
    rel.strip_prefix("./").unwrap_or(&rel).to_owned()
}

/// Windows names one directory in any letter case; an engine prints the case the system gave it.
fn same_component(a: &std::path::Component, b: &std::path::Component) -> bool {
    if cfg!(windows) { a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase() } else { a == b }
}

fn relative(base: &Path, target: &Path) -> String {
    let (b, t): (Vec<_>, Vec<_>) = (base.components().collect(), target.components().collect());
    let common = b.iter().zip(&t).take_while(|(x, y)| same_component(x, y)).count();
    // A different root (another drive) has no relative form.
    if common == 0 {
        return target.to_string_lossy().into_owned();
    }
    let mut parts: Vec<String> = vec!["..".into(); b.len() - common];
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
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

/// A path as an engine argument: one that begins with `-` would be read as an option.
pub fn path_arg(file: &str) -> String {
    if file.starts_with('-') { format!("./{file}") } else { file.to_owned() }
}

/// One spawn of an engine over a group of files.
pub struct Invocation {
    pub args: Vec<String>,
    pub env: Option<HashMap<String, String>>,
    pub input: Option<Vec<u8>>,
}

impl Invocation {
    /// The engine's configured arguments, then `flags`, then the files.
    pub fn over(req: &RunRequest, flags: &[&str], files: &[String]) -> Self {
        Self { args: req.args.iter().cloned().chain(strings(flags)).chain(files.iter().map(|f| path_arg(f))).collect(), env: None, input: None }
    }
}

/// What an engine reported about the files it processed.
#[derive(Debug, Default)]
pub struct Findings {
    pub diagnostics: Vec<Diagnostic>,
    pub changed: Vec<String>,
    /// Files its own configuration made it skip.
    pub ignored: Vec<String>,
}

/// What one spawn established about its group of files.
pub enum Batch {
    /// The engine processed the whole group.
    Done(Findings),
    /// It processed the group except the files it named, each with the reason it gave.
    Partly(Findings, Vec<(String, String)>),
    /// It did not, for the reason it gave.
    Incomplete(String),
    /// It cannot process any file, for the reason it gave: a configuration it rejects.
    Refused(String),
}

/// One engine command over the requested files, group by group.
#[derive(Debug, Default)]
pub struct Pass {
    pub findings: Findings,
    /// Files the engine could not process, each with the reason it gave.
    pub unprocessed: Vec<(String, String)>,
    /// The engine could not run: it did not start, timed out, was cancelled, or failed the same way
    /// on separate groups of files.
    pub failure: Option<String>,
    /// Files in the groups the engine completed.
    pub processed: usize,
    /// What the engine wrote to stderr while completing them.
    pub stderr: String,
}

impl Pass {
    /// The result of an engine whose findings come from one command.
    pub fn into_result(self) -> RunnerResult {
        RunnerResult {
            files_checked: Some(self.processed.saturating_sub(self.findings.ignored.len())),
            diagnostics: self.findings.diagnostics,
            changed_files: unique_paths(self.findings.changed),
            ignored: self.findings.ignored,
            unprocessed: self.unprocessed,
            error: self.failure,
            stderr_tail: tail600(&self.stderr),
            ..Default::default()
        }
    }

    /// Joins the pass of a second command over the same files (a linter beside a formatter): a file
    /// counts as processed when both commands processed it.
    pub fn and(mut self, other: Pass) -> Pass {
        self.findings.diagnostics.extend(other.findings.diagnostics);
        self.findings.changed.extend(other.findings.changed);
        self.findings.ignored.extend(other.findings.ignored);
        for (file, reason) in other.unprocessed {
            if !self.unprocessed.iter().any(|(f, _)| *f == file) {
                self.unprocessed.push((file, reason));
            }
        }
        self.failure = self.failure.or(other.failure);
        self.processed = self.processed.min(other.processed);
        self.stderr.push_str(&other.stderr);
        self
    }

    /// Joins the pass of the same command over other files.
    pub fn plus(mut self, other: Pass) -> Pass {
        self.findings.diagnostics.extend(other.findings.diagnostics);
        self.findings.changed.extend(other.findings.changed);
        self.findings.ignored.extend(other.findings.ignored);
        self.unprocessed.extend(other.unprocessed);
        self.failure = self.failure.or(other.failure);
        self.processed += other.processed;
        self.stderr.push_str(&other.stderr);
        self
    }
}

/// Whether `text` ends its lines with CR LF, decided by its first line ending.
pub fn ends_lines_with_crlf(text: &[u8]) -> bool {
    text.iter().position(|b| *b == b'\n').is_some_and(|at| at > 0 && text[at - 1] == b'\r')
}

/// The request's files by how they end their lines.
#[derive(Debug, Default)]
pub struct ByLineEnding {
    pub crlf: Vec<String>,
    /// LF, or no line ending at all.
    pub lf: Vec<String>,
    /// Files that could not be read, each with the reason.
    pub unreadable: Vec<(String, String)>,
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn sort_by_line_ending(cwd: &Path, files: Vec<String>) -> ByLineEnding {
    let mut sorted = ByLineEnding::default();
    for file in files {
        match std::fs::read(cwd.join(&file)) {
            Ok(text) if ends_lines_with_crlf(&text) => sorted.crlf.push(file),
            Ok(_) => sorted.lf.push(file),
            Err(e) => sorted.unreadable.push((file, format!("could not be read: {e}"))),
        }
    }
    sorted
}

/// `req.files` by how they end their lines. `Err` when the read never ran.
pub async fn files_by_line_ending(req: &RunRequest, id: &str) -> Result<ByLineEnding, String> {
    let (cwd, files) = (req.cwd.clone(), req.files.clone());
    on_lane(req.lane, move || sort_by_line_ending(&cwd, files)).await.map_err(|_| format!("{id} could not run: its lane did not read the files"))
}

/// The flags that tell an engine how to end lines.
pub struct LineEndingFlags {
    pub lf: &'static [&'static str],
    pub crlf: &'static [&'static str],
}

/// One engine command over `req.files`, for an engine that ends lines by its configuration and
/// not by the file: tidy does not report or rewrite a file for its line endings, so the files are
/// run by how they end their lines, each group told its own. `plan` builds a spawn from the flags
/// to add and a group of files. A file tidy cannot read is unprocessed for that reason and is not
/// handed to the engine.
pub async fn run_by_line_ending(req: &RunRequest, id: &str, command: Command, flags: &LineEndingFlags, plan: &(dyn Fn(&[&str], &[String]) -> Invocation + Sync), read: &(dyn Fn(&ProcessResult, &[String]) -> Batch + Sync)) -> Pass {
    let files = match files_by_line_ending(req, id).await {
        Ok(files) => files,
        Err(why) => return Pass { failure: Some(why), ..Default::default() },
    };
    let mut pass = Pass { unprocessed: files.unreadable, ..Default::default() };
    for (group, line_ending) in [(&files.lf, flags.lf), (&files.crlf, flags.crlf)] {
        if pass.failure.is_none() {
            pass = pass.plus(run_groups(req, id, command, group, req.files_per_spawn, &|some| plan(line_ending, some), read).await);
        }
    }
    pass
}

/// Why a spawn says nothing about its files: the run was cancelled, the engine was killed at its
/// time limit, or it never started. A cancelled or killed child still leaves partial output behind.
pub fn stopped(req: &RunRequest, id: &str, r: &ProcessResult) -> Option<String> {
    if req.cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
        return Some(format!("{id} was cancelled"));
    }
    if r.timed_out {
        return Some(format!("{id} timed out"));
    }
    (!r.error.is_empty()).then(|| format!("{id} could not run: {}", r.error))
}

/// What an engine that did not complete said: its stderr, else its stdout, with its exit code.
pub fn said(r: &ProcessResult) -> String {
    match [&r.stderr, &r.stdout].into_iter().map(|text| tail600(&strip_ansi(text))).find(|text| !text.is_empty()) {
        Some(text) => format!("exit {}: {text}", r.code),
        None => format!("exit {}", r.code),
    }
}

/// The result of an engine that could not run.
pub fn engine_stopped(why: String) -> RunnerResult {
    RunnerResult { error: Some(why), ..Default::default() }
}

/// What a command does to the files it is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// It reports on them: a group it did not complete is run again in halves, to find the file.
    Reads,
    /// It rewrites them: it is never run twice over a file, since a second run could make changes
    /// the check did not announce. A group it did not complete is reported as it failed.
    Writes,
}

struct Batches<'a> {
    req: &'a RunRequest,
    id: &'a str,
    command: Command,
    plan: &'a (dyn Fn(&[String]) -> Invocation + Sync),
    read: &'a (dyn Fn(&ProcessResult, &[String]) -> Batch + Sync),
}

enum Attempt {
    Stopped(String),
    /// The group is settled: `left_out` are the files of it the engine said it did not process.
    Done { findings: Findings, left_out: Vec<(String, String)>, stderr: String },
    Incomplete { reason: String, truncated: bool },
}

impl Batches<'_> {
    async fn attempt(&self, group: &[String]) -> Attempt {
        let call = (self.plan)(group);
        let r = self.req.spawn.run(&self.req.bin, &call.args, &self.req.cwd, self.req.timeout, self.req.cancel.as_ref(), call.env.as_ref(), call.input).await;
        if let Some(why) = stopped(self.req, self.id, &r) {
            return Attempt::Stopped(why);
        }
        // A report that was cut is not a report; what a writing command printed is not its result.
        if r.truncated && self.command == Command::Reads {
            return Attempt::Incomplete { reason: format!("{} printed more than tidy captures", self.id), truncated: true };
        }
        match (self.read)(&r, group) {
            Batch::Done(findings) => Attempt::Done { findings, left_out: Vec::new(), stderr: r.stderr },
            Batch::Partly(findings, left_out) => Attempt::Done { findings, left_out, stderr: r.stderr },
            Batch::Incomplete(reason) => Attempt::Incomplete { reason, truncated: false },
            Batch::Refused(reason) => Attempt::Stopped(format!("{} could not run: {reason}", self.id)),
        }
    }

    /// Settles a group from its first attempt. A group a reading command did not complete is halved
    /// and each half run again, down to the single files it fails on: an exit code speaks for the
    /// whole group, never for a file. `false` ends the pass.
    fn settle<'a>(&'a self, group: &'a [String], first: Attempt, pass: &'a mut Pass) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>> {
        Box::pin(async move {
            match first {
                Attempt::Stopped(why) => {
                    pass.failure = Some(why);
                    false
                }
                Attempt::Done { findings, left_out, stderr } => {
                    pass.findings.diagnostics.extend(findings.diagnostics);
                    pass.findings.changed.extend(findings.changed);
                    pass.findings.ignored.extend(findings.ignored);
                    pass.processed += group.len() - left_out.len();
                    pass.unprocessed.extend(left_out);
                    pass.stderr.push_str(&stderr);
                    true
                }
                Attempt::Incomplete { reason, .. } if group.len() == 1 => {
                    pass.unprocessed.push((group[0].clone(), reason));
                    true
                }
                Attempt::Incomplete { reason, .. } if self.command == Command::Writes => {
                    let reason = format!("{} failed over the {} files it was given, this one among them: {reason}", self.id, group.len());
                    pass.unprocessed.extend(group.iter().map(|file| (file.clone(), reason.clone())));
                    true
                }
                Attempt::Incomplete { .. } => {
                    let (left, right) = group.split_at(group.len() / 2);
                    let a = self.attempt(left).await;
                    if let Attempt::Stopped(why) = &a {
                        pass.failure = Some(why.clone());
                        return false;
                    }
                    let b = self.attempt(right).await;
                    // Groups with no file in common that fail word for word alike are not failing
                    // on their files: the configuration or the invocation is what the engine rejects.
                    if let (Attempt::Incomplete { reason: x, truncated: false }, Attempt::Incomplete { reason: y, truncated: false }) = (&a, &b)
                        && x == y
                    {
                        pass.failure = Some(format!("{} failed the same way on separate groups of files: {x}", self.id));
                        return false;
                    }
                    self.settle(left, a, pass).await && self.settle(right, b, pass).await
                }
            }
        })
    }
}

/// Runs one engine command over `files`, `per_spawn` of them at a time: `plan` builds the spawn
/// for a group and `read` says whether the engine completed it.
pub async fn run_groups(req: &RunRequest, id: &str, command: Command, files: &[String], per_spawn: usize, plan: &(dyn Fn(&[String]) -> Invocation + Sync), read: &(dyn Fn(&ProcessResult, &[String]) -> Batch + Sync)) -> Pass {
    let batches = Batches { req, id, command, plan, read };
    let mut pass = Pass::default();
    for group in files.chunks(per_spawn.max(1)) {
        let first = batches.attempt(group).await;
        if !batches.settle(group, first, &mut pass).await {
            break;
        }
    }
    pass
}

/// Runs one reporting command over `files`.
pub async fn run_batches(req: &RunRequest, id: &str, files: &[String], per_spawn: usize, plan: &(dyn Fn(&[String]) -> Invocation + Sync), read: &(dyn Fn(&ProcessResult, &[String]) -> Batch + Sync)) -> Pass {
    run_groups(req, id, Command::Reads, files, per_spawn, plan, read).await
}

/// What a writing command established about a group: nothing to report beyond whether it
/// completed, which `completed` reads from the exit.
pub fn wrote(completed: &(dyn Fn(&ProcessResult) -> bool + Sync), r: &ProcessResult) -> Batch {
    if completed(r) { Batch::Done(Findings::default()) } else { Batch::Incomplete(said(r)) }
}

/// A writing command over `req.files`.
pub async fn run_writes(req: &RunRequest, id: &str, flags: &[&str], completed: &(dyn Fn(&ProcessResult) -> bool + Sync)) -> Pass {
    run_groups(req, id, Command::Writes, &req.files, req.files_per_spawn, &|files| Invocation::over(req, flags, files), &|r, _| wrote(completed, r)).await
}

/// Splits `req.files` into those the engine's configuration lets it process and those it leaves
/// out, by asking the engine to list them (`flags`, one path per line). An engine handed a path
/// its project excludes either processes it anyway or skips it without a word; neither is a report.
pub async fn selected_files(req: &RunRequest, id: &str, flags: &[&str], listed: fn(&ProcessResult) -> bool) -> Result<(Vec<String>, Vec<String>), String> {
    let mut named = std::collections::HashSet::new();
    for group in req.files.chunks(req.files_per_spawn.max(1)) {
        let call = Invocation::over(req, flags, group);
        let r = req.spawn.run(&req.bin, &call.args, &req.cwd, req.timeout, req.cancel.as_ref(), None, None).await;
        if let Some(why) = stopped(req, id, &r) {
            return Err(why);
        }
        if r.truncated || !listed(&r) {
            return Err(format!("{id} could not list the files it would process: {}", said(&r)));
        }
        named.extend(parse_path_list(&r.stdout, &req.cwd));
    }
    Ok(req.files.iter().cloned().partition(|file| named.contains(&to_rel(&req.cwd, file))))
}

/// The exit of a command that succeeds with 0 and nothing else.
pub fn exited_zero(r: &ProcessResult) -> bool {
    r.code == 0
}

pub fn unique_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter(|p| !p.is_empty() && seen.insert(p.clone())).collect()
}

/// "One unformatted path per line" listing (`shfmt -l`, `prettier -l`). A path may begin with any
/// character: `[id].tsx` is an ordinary file name.
pub fn parse_path_list(stdout: &str, cwd: &Path) -> Vec<String> {
    unique_paths(stdout.lines().map(js_trim).filter(|l| !l.is_empty()).map(|l| to_rel(cwd, l)))
}

/// Paths named by a per-line pattern (rustfmt/stylua diff headers, "Would reformat: <path>").
/// The first non-empty capture group of each matching line is the path.
pub fn parse_pattern_paths(output: &str, pattern: &JsRegex, cwd: &Path) -> Vec<String> {
    // Engines colour these lines into a pipe too (dprint does), so the colour always comes off.
    let text = strip_ansi(output);
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

/// What a formatter whose output names the files it would rewrite found.
pub fn parse_reformat_report(output: &str, pattern: &JsRegex, cwd: &Path, id: &str, code: &str) -> Findings {
    let changed = parse_pattern_paths(output, pattern, cwd);
    Findings { diagnostics: reformat_diagnostics(&changed, id, code), changed, ..Default::default() }
}

/// Runner for format-only engines whose check mode lists the files they would rewrite (shfmt -l,
/// gofmt -l, gofumpt -l, prettier --list-different) and whose fix mode writes in place.
pub struct ListFormatter {
    pub id: &'static str,
    pub list_args: &'static [&'static str],
    pub write_args: &'static [&'static str],
    /// Whether a listing run completed. The engines disagree on what exit 1 means.
    pub listed: fn(&ProcessResult) -> bool,
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
        let read = |r: &ProcessResult, _: &[String]| {
            if !(self.listed)(r) {
                return Batch::Incomplete(said(r));
            }
            let changed = parse_path_list(&r.stdout, &req.cwd);
            Batch::Done(Findings { diagnostics: reformat_diagnostics(&changed, self.id, self.id), changed, ..Default::default() })
        };
        run_batches(req, self.id, &req.files, req.files_per_spawn, &|files| Invocation::over(req, self.list_args, files), &read).await.into_result()
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        run_writes(req, self.id, self.write_args, &exited_zero).await.into_result()
    }
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
        assert_eq!(to_rel(Path::new("C:\\repo"), "\\\\?\\C:\\repo\\a.rs"), "a.rs");
        // Windows names a directory in any letter case; elsewhere a different case is a different directory.
        assert_eq!(to_rel(Path::new("C:\\Repo"), "c:\\repo\\src\\a.rs"), if cfg!(windows) { "src/a.rs" } else { "c:/repo/src/a.rs" });
        assert_eq!((path_arg("-x.sh"), path_arg("dir/-x.sh"), path_arg("x.sh")), ("./-x.sh".to_owned(), "dir/-x.sh".to_owned(), "x.sh".to_owned()));
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
        assert_eq!(parse_path_list("a.sh\n[id].sh\n\na.sh\nc.sh\n", cwd), ["a.sh", "[id].sh", "c.sh"]);
        let re = JsRegex::new_static(r"^Would reformat:\s*(.+?)\s*$", "");
        assert_eq!(parse_pattern_paths("Would reformat: x.R\nnoise\nWould reformat: x.R\n", &re, cwd), ["x.R"]);
        let both = JsRegex::new_static(r"^(?:from\s+(.+?):|---\s*(.+?)\s*---)$", "");
        assert_eq!(parse_pattern_paths("\u{1b}[0m\u{1b}[1m\u{1b}[31mfrom\u{1b}[0m a.json:\n--- b.md ---", &both, cwd), ["a.json", "b.md"]);
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
        let runner = ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"], listed: exited_zero };
        let out = runner.check(&req).await;
        assert_eq!((out.changed_files.clone(), out.files_checked), (vec!["a.sh".to_owned()], Some(3)));
        assert!(out.diagnostics[0].fixable);
        assert_eq!(*spawn.0.lock().unwrap(), vec![vec!["-l", "f0.sh", "f1.sh"], vec!["-l", "f2.sh"]]);
        let failing = Arc::new(Scripted(Default::default(), ProcessResult { code: -1, error: "ENOENT".into(), ..Default::default() }));
        req.spawn = failing.clone();
        let failed = runner.fix(&req).await;
        assert_eq!((failed.error.as_deref(), failed.files_checked), (Some("shfmt could not run: ENOENT"), Some(0)));
        assert_eq!(failing.0.lock().unwrap().len(), 1, "an engine that cannot start is not asked again for the next group");
    }

    #[tokio::test]
    async fn a_cancelled_or_timed_out_run_is_a_failure_whatever_the_killed_engine_printed() {
        let partial = ProcessResult { code: -1, stdout: "a.sh\n".into(), ..Default::default() };
        let mut req = RunRequest::new(Path::new("/r"), "shfmt", vec!["a.sh".into(), "b.sh".into()], Arc::new(Scripted(Default::default(), partial.clone())), mixdog_rt::testing::tokens().durability_io);
        let cancel = CancellationToken::new();
        cancel.cancel();
        req.cancel = Some(cancel);
        let runner = ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"], listed: exited_zero };
        let cancelled = runner.check(&req).await;
        assert_eq!((cancelled.error.as_deref(), cancelled.files_checked, cancelled.changed_files.len()), (Some("shfmt was cancelled"), Some(0), 0));
        req.cancel = None;
        req.spawn = Arc::new(Scripted(Default::default(), ProcessResult { timed_out: true, error: "timed out after 120000ms".into(), ..partial }));
        assert_eq!(runner.fix(&req).await.error.as_deref(), Some("shfmt timed out"));
    }

    #[tokio::test]
    async fn a_group_whose_output_was_cut_is_split_until_each_file_answers_in_full() {
        struct Cut;
        #[async_trait]
        impl Spawn for Cut {
            async fn run(&self, _: &str, args: &[String], _: &Path, _: Duration, _: Option<&CancellationToken>, _: Option<&HashMap<String, String>>, _: Option<Vec<u8>>) -> ProcessResult {
                let files = &args[1..];
                ProcessResult { stdout: files.iter().map(|f| format!("{f}\n")).collect(), truncated: files.len() > 1, ..Default::default() }
            }
        }
        let req = RunRequest::new(Path::new("/r"), "shfmt", (0..5).map(|n| format!("f{n}.sh")).collect(), Arc::new(Cut), mixdog_rt::testing::tokens().durability_io);
        let out = ListFormatter { id: "shfmt", list_args: &["-l"], write_args: &["-w"], listed: exited_zero }.check(&req).await;
        assert_eq!((out.changed_files.len(), out.files_checked, out.error, out.unprocessed.len()), (5, Some(5), None, 0));
    }
}
