//! Running git for the tool and rendering what it printed: the child's environment, lock-file
//! retry, the line/character caps with their markers, and the exit-signal outcomes.

use std::path::Path;
use std::time::Duration;

use mixdog_rt::MaintenanceIo;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::exec::Exec;
use mixdog_scm::exec::ExecSpec;
use mixdog_scm::repo::on_lane;
use regex::Regex;
use tokio_util::sync::CancellationToken;

use super::argv::Plan;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CAPTURE_BYTES: u64 = 128 * 1024 * 1024;
pub(super) const OUTPUT_LIMIT_MAX: usize = 1000;
pub(super) const OUTPUT_LINES_DEFAULT: usize = 500;
pub(super) const LOG_LINES_DEFAULT: usize = 100;
pub(super) const COMMAND_CHAR_BUDGET: usize = 40_000;
pub(super) const ARRAY_CHAR_BUDGET: usize = 60_000;
pub(super) const MIN_COMMAND_CHARS: usize = 1_000;
const LARGE_DIFF_HINT: &str = "hint: large diff - run with --stat first for per-file sizes, add -U1 for less context, and page by file with -- <path>";
const LOCK_RETRY_DELAYS_MS: [u64; 5] = [100, 200, 400, 800, 1600];
const LOCK_WAIT_REPORT_MS: u64 = 1000;
const DIFF_EXIT_SIGNAL_FLAGS: [&str; 3] = ["--exit-code", "--quiet", "--check"];
const PATCH_OPERATIONS: [&str; 6] = ["diff", "diff-files", "diff-index", "diff-tree", "show", "log"];

pub(super) enum RunError {
    NotFound,
    Spawn(String),
    Aborted,
    TimedOut,
    Overflow,
}

pub(super) struct GitRun {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub error: Option<RunError>,
    pub retries: usize,
    pub retry_ms: u64,
    pub not_utf8: bool,
}

impl GitRun {
    fn failed(error: RunError) -> Self {
        Self { code: None, stdout: Vec::new(), stderr: Vec::new(), error: Some(error), retries: 0, retry_ms: 0, not_utf8: false }
    }

    pub fn succeeded(&self) -> bool {
        self.code == Some(0) && self.error.is_none()
    }

    pub fn out(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

pub(super) struct Runner<'a> {
    pub exec: &'a Exec,
    pub cancel: &'a CancellationToken,
    pub lane: MaintenanceIo,
}

fn lock_contention(stderr: &str) -> bool {
    Regex::new(r"Unable to create '[^'\n]*\.lock': File exists|could not lock config file [^\n]*: File exists")
        .is_ok_and(|re| re.is_match(stderr))
}

impl Runner<'_> {
    /// Blocking filesystem work as a maintenance-lane job; `None` when the call was cancelled
    /// or the lane refused it.
    pub async fn blocking<R: Send + 'static>(&self, job: impl FnOnce() -> R + Send + 'static) -> Option<R> {
        on_lane(self.lane, self.cancel, job).await.ok()
    }

    /// Like [`Self::blocking`] but for cleanup that must still run after a cancellation.
    pub async fn blocking_cleanup<R: Send + 'static>(&self, job: impl FnOnce() -> R + Send + 'static) -> Option<R> {
        on_lane(self.lane, &CancellationToken::new(), job).await.ok()
    }

    /// One git child. Reads pin `GIT_OPTIONAL_LOCKS=0` so a status never takes `index.lock`.
    pub async fn run(&self, plan: &Plan, argv: &[String], read_only: bool) -> GitRun {
        self.run_in(&plan.cwd, &plan.global_args, argv, read_only).await
    }

    pub async fn run_in(&self, cwd: &Path, global_args: &[String], argv: &[String], read_only: bool) -> GitRun {
        let mut spec = ExecSpec::new("git", cwd);
        // File names print as they are, not as quoted octal escapes (`core.quotepath=false`); a `-c` of the command's own comes after
        // and wins.
        spec.args = ["-c", "core.quotepath=false"].into_iter().map(str::to_owned).chain(global_args.iter().chain(argv).cloned()).collect();
        spec.env_set = vec![
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GIT_PAGER".into(), "cat".into()),
            ("GIT_EDITOR".into(), "true".into()),
            ("GIT_SEQUENCE_EDITOR".into(), "true".into()),
            ("LC_ALL".into(), "C".into()),
        ];
        if read_only {
            spec.env_set.push(("GIT_OPTIONAL_LOCKS".into(), "0".into()));
        }
        spec.time_limit = Some(DEFAULT_TIMEOUT);
        spec.max_output = MAX_CAPTURE_BYTES;
        // `runGit`: `startGit(env, ...)`, the git PATH resolves to with its launcher's environment.
        match mixdog_scm::git::start_git(self.exec, self.lane, spec, self.cancel).await {
            Ok(out) => GitRun {
                code: out.code,
                stdout: out.stdout,
                stderr: out.stderr,
                error: None,
                retries: 0,
                retry_ms: 0,
                not_utf8: false,
            },
            Err(ScmFailure::Unavailable { .. }) => GitRun::failed(RunError::NotFound),
            Err(ScmFailure::Cancelled) => GitRun::failed(RunError::Aborted),
            Err(ScmFailure::TimedOut { .. }) => GitRun::failed(RunError::TimedOut),
            Err(ScmFailure::OutputTooLarge { .. }) => GitRun::failed(RunError::Overflow),
            // `result.error.code || result.error.message`: a refused start is named by its code alone.
            Err(ScmFailure::Spawn { code: "ENOENT", .. }) => GitRun::failed(RunError::NotFound),
            Err(ScmFailure::Spawn { code, .. }) => GitRun::failed(RunError::Spawn(code.to_owned())),
            Err(other) => GitRun::failed(RunError::Spawn(other.to_string())),
        }
    }

    /// A write: another process holding one of git's lock files turns into a short bounded
    /// wait (3.1 s in all) instead of a failure.
    pub async fn run_write(&self, plan: &Plan, argv: &[String]) -> GitRun {
        let mut retry_ms = 0;
        let mut retries = 0;
        loop {
            let mut run = self.run(plan, argv, false).await;
            run.retries = retries;
            run.retry_ms = retry_ms;
            let Some(delay) = LOCK_RETRY_DELAYS_MS.get(retries).copied() else { return run };
            if run.succeeded() || !lock_contention(&run.err()) {
                return run;
            }
            tokio::select! {
                _ = mixdog_rt::time::sleep(Duration::from_millis(delay)) => {}
                _ = self.cancel.cancelled() => return run,
            }
            retry_ms += delay;
            retries += 1;
        }
    }
}

/// Waiting is reported once it exceeds a second, so a slow answer is never mistaken for slow
/// git work.
pub(super) fn lock_wait_note(waited_ms: u64, run: Option<&GitRun>) -> String {
    let total = waited_ms + run.map_or(0, |r| r.retry_ms);
    if total <= LOCK_WAIT_REPORT_MS {
        return String::new();
    }
    let retried = match run {
        Some(r) if r.retries > 0 => format!(" (git lock file busy; retried {}x)", r.retries),
        _ => String::new(),
    };
    format!("note: waited {:.1}s for concurrent git writes{retried}", total as f64 / 1000.0)
}

pub(super) fn fail(message: &str) -> String {
    format!("error: {message}")
}

pub(super) fn append_text(left: &str, right: &str) -> String {
    if right.is_empty() {
        return left.to_owned();
    }
    let sep = if !left.is_empty() && !left.ends_with('\n') { "\n" } else { "" };
    format!("{left}{sep}{right}")
}

fn output_lines(value: &str) -> Vec<&str> {
    value.split_inclusive('\n').collect()
}

pub(super) fn u16len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn cap_marker(limit: &str, shown: &str, narrow: &str) -> String {
    let mut parts = vec![format!("output capped at {limit}")];
    if !shown.is_empty() {
        parts.push(shown.to_owned());
    }
    parts.push(format!("narrow: {narrow}"));
    format!("[{}]", parts.join("; "))
}

#[derive(Clone, Copy)]
pub(super) struct Cap {
    pub lines: usize,
    pub chars: usize,
}

struct Capped {
    text: String,
    truncated: bool,
    total_lines: usize,
}

fn cap_output(text: &str, cap: Cap) -> Capped {
    let lines = output_lines(text);
    let line_cut = lines.len() > cap.lines;
    let kept = if line_cut { lines[..cap.lines].concat() } else { text.to_owned() };
    if u16len(&kept) <= cap.chars {
        let text = if line_cut {
            append_text(
                &kept,
                &cap_marker(
                    &format!("{} lines", cap.lines),
                    &format!("{} more lines omitted", lines.len() - cap.lines),
                    &format!("raise output_limit (max {OUTPUT_LIMIT_MAX}) or narrow the command (-- <path>, -n/--skip)"),
                ),
            )
        } else {
            text.to_owned()
        };
        return Capped { text, truncated: line_cut, total_lines: lines.len() };
    }
    let units: Vec<u16> = kept.encode_utf16().collect();
    let from = (cap.chars.saturating_sub(1)).min(units.len().saturating_sub(1));
    let newline = units[..=from].iter().rposition(|u| *u == u16::from(b'\n'));
    let cut = match newline {
        Some(n) if n > 0 => n + 1,
        _ => cap.chars.min(units.len()),
    };
    let head = String::from_utf16_lossy(&units[..cut]);
    let shown = output_lines(&head).len();
    let omitted_chars = u16len(text) - cut;
    Capped {
        text: append_text(
            &head,
            &cap_marker(
                &format!("{} chars", cap.chars),
                &format!("{} more lines ({omitted_chars} chars) omitted", lines.len() - shown),
                "narrow the command (-- <path>, -n/--skip) to page",
            ),
        ),
        truncated: true,
        total_lines: lines.len(),
    }
}

pub(super) struct Rendered {
    pub text: String,
    pub failed: bool,
}

fn visible_stderr(value: &str) -> String {
    Regex::new(r"(?m)^warning: in the working copy of .* (?:CRLF|LF) will be replaced[^\n]*(?:\n|$)")
        .map_or_else(|_| value.to_owned(), |re| re.replace_all(value, "").into_owned())
}

fn has_diff_header(text: &str) -> bool {
    Regex::new(r"(?m)^diff --git ").is_ok_and(|re| re.is_match(text))
}

fn present_stdout(plan: &Plan, stdout: &str) -> String {
    if plan.operation == "merge-tree" {
        return Regex::new(r"(?m)^Auto-merging .*(?:\r?\n|$)")
            .map_or_else(|_| stdout.to_owned(), |re| re.replace_all(stdout, "").into_owned());
    }
    if PATCH_OPERATIONS.contains(&plan.operation.as_str()) && has_diff_header(stdout) {
        return Regex::new(r"(?m)^index [0-9a-f,]+\.\.[0-9a-f]+(?: [0-7]+)?\r?(?:\n|$)")
            .map_or_else(|_| stdout.to_owned(), |re| re.replace_all(stdout, "").into_owned());
    }
    stdout.to_owned()
}

/// `git grep` exits 1 for no match, `git diff --exit-code/--quiet/--check` exits 1 to report a
/// difference, and a conflicted `git merge-tree` exits 1 with its report on stdout.
fn exit_signal(plan: &Plan, run: &GitRun) -> Option<&'static str> {
    if run.code != Some(1) || !visible_stderr(&run.err()).trim().is_empty() {
        return None;
    }
    match plan.operation.as_str() {
        "grep" => Some("no-match"),
        "merge-tree" => (!run.out().trim().is_empty()).then_some("conflicts"),
        "diff" => {
            let end = plan.args.iter().position(|a| a == "--").unwrap_or(plan.args.len());
            plan.args[..end]
                .iter()
                .any(|a| DIFF_EXIT_SIGNAL_FLAGS.contains(&a.as_str()))
                .then_some("no-match")
        }
        _ => None,
    }
}

fn failure_reason(plan: &Plan, run: &GitRun) -> String {
    match &run.error {
        Some(RunError::NotFound) => "git executable not found in this environment".to_owned(),
        Some(RunError::Spawn(message)) => format!("git process failed ({message})"),
        Some(RunError::Aborted) => "git command aborted".to_owned(),
        Some(RunError::TimedOut) => "git command timed out".to_owned(),
        Some(RunError::Overflow) => "git output exceeded 128 MiB".to_owned(),
        None => format!(
            "git {} exited {}",
            plan.operation,
            run.code.map_or("null".to_owned(), |c| c.to_string())
        ),
    }
}

pub(super) fn command_result(plan: &Plan, run: &GitRun, cap: Cap) -> Rendered {
    let stdout = present_stdout(plan, &run.out());
    let capped = cap_output(&append_text(&stdout, &visible_stderr(&run.err())), cap);
    let mut output = capped.text;
    if (capped.truncated || capped.total_lines > OUTPUT_LINES_DEFAULT) && has_diff_header(&stdout) {
        output = append_text(&output, LARGE_DIFF_HINT);
    }
    if run.succeeded() {
        return Rendered { text: output, failed: false };
    }
    if run.error.is_some() || run.code.is_none() {
        return Rendered { text: append_text(&fail(&failure_reason(plan, run)), &output), failed: true };
    }
    let code = run.code.unwrap_or_default();
    let signal = exit_signal(plan, run);
    if signal == Some("conflicts") {
        return Rendered {
            text: append_text(
                &format!("exit {code}\n[outcome: conflicts]\nmerge has conflicts (see the CONFLICT lines); this is a result, not a command failure"),
                &output,
            ),
            failed: false,
        };
    }
    let head = match signal {
        Some(outcome) => format!("exit {code}\n[outcome: {outcome}]"),
        None => format!("exit {code}"),
    };
    Rendered { text: append_text(&head, &output), failed: true }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_by_lines_then_characters() {
        let text = "a\nb\nc\nd\n";
        let capped = cap_output(text, Cap { lines: 2, chars: 100 });
        assert!(capped.text.starts_with("a\nb\n[output capped at 2 lines; 2 more lines omitted; narrow: raise output_limit"));
        assert!(capped.truncated && capped.total_lines == 4);
        let capped = cap_output("aaaa\nbbbb\ncccc\n", Cap { lines: 10, chars: 7 });
        assert!(capped.text.starts_with("aaaa\n[output capped at 7 chars; 2 more lines (10 chars) omitted;"));
    }

    /// A process manager whose every start the system refuses for access (libuv's EPERM on Windows, EACCES elsewhere).
    struct Refused;

    use mixdog_core_api::domain::process as p;

    #[async_trait::async_trait]
    impl p::ProcessManager for Refused {
        async fn spawn(&self, _request: p::SpawnRequest) -> Result<p::SpawnedProcess, p::ProcessError> {
            Err(p::ProcessError::PermissionDenied)
        }
        fn subscribe(&self, _handle: &mixdog_protocol::ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn mixdog_core_api::domain::common::EventSource<p::ProcessEvent>>, p::ProcessError> {
            Err(p::ProcessError::UnknownHandle)
        }
        async fn write_stdin(&self, _handle: &mixdog_protocol::ProcessHandle, _bytes: Vec<u8>) -> Result<(), p::ProcessError> {
            Err(p::ProcessError::UnknownHandle)
        }
        fn close_stdin(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), p::ProcessError> {
            Err(p::ProcessError::UnknownHandle)
        }
        fn resize_pty(&self, _handle: &mixdog_protocol::ProcessHandle, _size: p::PtySize) -> Result<(), p::ProcessError> {
            Err(p::ProcessError::UnknownHandle)
        }
        fn kill(&self, _handle: &mixdog_protocol::ProcessHandle) -> Result<(), p::ProcessError> {
            Err(p::ProcessError::UnknownHandle)
        }
        fn list(&self) -> Vec<p::ProcessInfo> {
            Vec::new()
        }
    }

    /// `runGit`'s `result.error.code || result.error.message`: the git tool names a refused start by its code alone,
    /// `git process failed (EPERM)`.
    #[tokio::test]
    async fn a_refused_git_start_is_named_by_its_code_alone() {
        let exec = Exec::new(std::sync::Arc::new(Refused));
        let cancel = CancellationToken::new();
        let runner = Runner { exec: &exec, cancel: &cancel, lane: mixdog_rt::testing::tokens().maintenance_io };
        let run = runner.run_in(&std::env::temp_dir(), &[], &["status".to_owned()], true).await;
        let code = if cfg!(windows) { "EPERM" } else { "EACCES" };
        assert!(matches!(&run.error, Some(RunError::Spawn(text)) if text == code), "the start is named {code}");
    }

    #[test]
    fn append_text_joins_on_a_line_break() {
        assert_eq!(append_text("a", "b"), "a\nb");
        assert_eq!(append_text("a\n", "b"), "a\nb");
        assert_eq!(append_text("a", ""), "a");
    }
}
