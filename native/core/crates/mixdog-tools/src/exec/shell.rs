//! The `shell` tool: policy preflight, environment, then the process through the process
//! manager. The call holds for the shell hold (default 60 s, `wait_ms`, or until new user input);
//! work still running then moves to a tracked background task whose completion is pushed to the
//! owner. Result texts follow `bash-tool/*.mjs` byte for byte.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolProgress;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;
use serde::Deserialize;

use super::archive;
use super::benign::is_benign_search_exit_one;
use super::compact::Outcome;
use super::compact::Plan;
use super::compact::Recovery;
use super::compact::body_with_hint;
use super::compact::plan;
use super::compact::recovery_hint;
use super::compact::still_worthwhile;
use super::delivery::Piece;
use super::delivery::delivery_full_chars;
use super::delivery::parse_int_prefix;
use super::text::strip_ansi;
use super::delivery::fit_pieces;
use super::delivery::render_shell_output_body;
use super::delivery::shell_text_piece;
use super::env::ShellEnv;
use super::env::env_flag;
use crate::orch::util::spec_from_def;
use super::env::session_scratch_dir;
use super::env::shell_env;
use super::jobs::ExecRuntime;
use super::jobs::Job;
use super::jobs::ReadOptions;
use super::jobs::shown_path;
use super::jobs::signal_name;
use super::shell_choice::chosen_shell;
use super::shell_choice::default_program;
use super::psfix::powershell_bashism_hint;
use super::psfix::rewrite_wmic_process;
use super::bashism::rewrite_powershell_bashisms;
use super::direct::plan_direct_exe;
use super::guard::Guarded;
use super::guard::guard_call;
use super::hoist::plan_hoist;
use super::hygiene::preflight_powershell_hygiene;
use super::invocation::EVAL_SCRIPT;
use super::invocation::POWERSHELL_BOOTSTRAP;
use super::invocation::build_powershell_filter_tee_plan;
use super::invocation::filter_rescue_note;
use super::invocation::frame_powershell_script;
use super::invocation::prefix_powershell_skill_function;
use super::invocation::prefix_powershell_utf8;
use super::invocation::wrap_with_snapshot;
use super::snapshot::SnapshotRequest;
use super::spill;
use super::wake::WakeReason;
use super::warning::place_warnings_after_status;
use crate::policy::ExecVerdict;
use super::warning::prepend_warning;

const SHELL_HOLD_DEFAULT_MS: u64 = 60_000;
const SHELL_HOLD_MIN_MS: u64 = 1_000;
const SHELL_HOLD_MAX_MS: u64 = 600_000;
/// The hold of an explicit background start: long enough for the child to be spawned and
/// promoted, short enough to return at once.
const BACKGROUND_START_HOLD_MS: u64 = 1;
const TIMER_MAX_MS: u64 = 2_147_483_647;
/// A command that detaches work is never detected from its text: after the shell exits, the runner
/// observes whether its process tree still holds live processes.
pub(crate) const SURVIVING_DESCENDANTS_WARNING: &str =
    "⚠️ the command finished but left descendants running: they are tracked as the task below, and `task cancel` terminates them.";
pub(crate) const SURVIVING_DESCENDANTS_UNREACHABLE_WARNING: &str =
    "⚠️ the command finished but left a descendant running that this process can no longer signal (its parent exited and Windows keeps no live link to it). It stays tracked as the task below and its completion is reported, but `task cancel` may not be able to terminate it.";
const BACKGROUND_GUIDANCE: &str =
    "Its result is delivered automatically when it finishes; use task wait only if you need it now.";

/// Why the command left the foreground (`promotion-results.mjs` `backgroundVerb`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum PromotionReason {
    /// `background: true`.
    Background,
    /// The hold ran out.
    Threshold,
    /// The foreground window of a longer run limit ran out.
    Timeout,
    /// New user input.
    Input,
    /// A notification arrived.
    Notification,
}

fn background_message(reason: PromotionReason, elapsed_ms: u64) -> String {
    let secs = (elapsed_ms as f64 / 1000.0).round() as u64;
    let verb = match reason {
        PromotionReason::Timeout => format!("moved to background at timeout after {secs}s"),
        PromotionReason::Input => format!("moved to background on new user input after {secs}s"),
        PromotionReason::Notification => {
            format!("moved to background after {secs}s because a notification arrived (delivered to you now)")
        }
        PromotionReason::Background => "started in the background".to_owned(),
        PromotionReason::Threshold => format!("moved to background after the {secs}s hold"),
    };
    format!("{verb}; still running. {BACKGROUND_GUIDANCE}")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    wait_ms: Option<u64>,
    background: Option<bool>,
}

pub struct ShellTool {
    spec: ToolSpec,
    runtime: Arc<ExecRuntime>,
}

/// The definitions Node sends (`buildShellDescription` / `buildShellCommandDescription`, written for
/// the shell kind) with background tasks on, and with `MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS`
/// (foreground only, the hold text gone).
const POSIX: &str = include_str!("specs/shell.posix.json");
const POWERSHELL: &str = include_str!("specs/shell.powershell.json");
const POSIX_FOREGROUND: &str = include_str!("specs/shell.posix.foreground.json");
const POWERSHELL_FOREGROUND: &str = include_str!("specs/shell.powershell.foreground.json");

/// The kind of shell the tool text is written for (`shellType`).
///
/// Node binds the text where a session's tool list is assembled, from the kind of the shell it
/// resolves (`resolveShellFor('default').shellType`) at that moment. That kind is the platform's
/// whatever the "system shell" setting or `MIXDOG_SHELL` holds: a PowerShell program is the choice
/// on Windows only, a POSIX shell is never the choice there, and off Windows the default is
/// used (`chosen_shell`; the recorded `shell_choice.json` has the platform's kind in all 124 cases).
/// So the live setting cannot change the text, and the kind is read from the platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShellKind {
    Posix,
    PowerShell,
}

impl ShellKind {
    pub(crate) fn of(windows: bool) -> Self {
        if windows { Self::PowerShell } else { Self::Posix }
    }
}

/// The one builder of the `shell` definition: Node's text for `kind`, with background tasks
/// `background` or not.
pub(crate) fn shell_spec(kind: ShellKind, background: bool) -> ToolSpec {
    let def = match (kind, background) {
        (ShellKind::Posix, true) => POSIX,
        (ShellKind::PowerShell, true) => POWERSHELL,
        (ShellKind::Posix, false) => POSIX_FOREGROUND,
        (ShellKind::PowerShell, false) => POWERSHELL_FOREGROUND,
    };
    spec_from_def(def, false, &[])
}

impl ShellTool {
    /// The text is written for the platform's shell kind and fixed when the tool is built.
    pub fn new(runtime: Arc<ExecRuntime>) -> Self {
        Self::with_background(runtime, !env_flag("MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS", false))
    }

    /// The tool with its text written for background tasks `enabled` or not (`new` reads
    /// `MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS`).
    pub fn with_background(runtime: Arc<ExecRuntime>, enabled: bool) -> Self {
        Self { spec: shell_spec(ShellKind::of(runtime.config.windows), enabled), runtime }
    }
}

/// `formatShellToolFailure`.
pub(crate) fn tool_failure(message: &str) -> String {
    let trimmed = mixdog_js::js_trim(message);
    let stripped = trimmed
        .get(..6)
        .filter(|head| head.eq_ignore_ascii_case("error:"))
        .map_or(trimmed, |_| mixdog_js::js_trim(&trimmed[6..]));
    let text = if stripped.is_empty() { "shell tool failed" } else { stripped };
    format!("Error: [shell-tool-failed] {text}")
}

fn failed(code: ToolErrorCode, text: String) -> ToolError {
    ToolError::new(code, text)
}

fn text_output(text: String) -> ToolOutput {
    ToolOutput { parts: vec![ToolPart::Text(text)], ..ToolOutput::default() }
}

/// How long the call holds (`planShellDeadlines`); 0 means it never moves to the background.
fn hold_ms(args: &Args, timeout_ms: u64, background_enabled: bool) -> u64 {
    if !background_enabled {
        return 0;
    }
    let hold = if args.background == Some(true) {
        BACKGROUND_START_HOLD_MS
    } else if let Some(wait) = args.wait_ms.filter(|w| *w > 0) {
        wait.clamp(SHELL_HOLD_MIN_MS, SHELL_HOLD_MAX_MS)
    } else {
        std::env::var("MIXDOG_SHELL_AUTO_BACKGROUND_MS")
            .ok()
            .filter(|raw| !mixdog_js::js_trim(raw).is_empty())
            .map(|raw| mixdog_js::string_to_number(&raw))
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map_or(SHELL_HOLD_DEFAULT_MS, |n| n.floor() as u64)
    };
    if hold == 0 {
        0
    } else if timeout_ms > 0 {
        hold.min(timeout_ms)
    } else {
        hold
    }
}

/// The foreground window a run limit longer than it is cut to (`BASH_MAX_TIMEOUT_MS`, else 120 s),
/// never shorter than the hold.
fn foreground_cap_ms(hold: u64) -> u64 {
    let configured = std::env::var("BASH_MAX_TIMEOUT_MS")
        .ok()
        .and_then(|raw| parse_int_prefix(&raw))
        .filter(|n| *n > 0)
        .map_or(120_000, |n| n as u64);
    configured.max(hold)
}

/// The run limit: an explicit `timeout_ms`, else the background safety net
/// `MIXDOG_SHELL_BACKGROUND_MAX_MS`, else none.
fn time_limit_ms(args: &Args, background_enabled: bool) -> u64 {
    if let Some(t) = args.timeout_ms.filter(|t| *t > 0) {
        return t.min(TIMER_MAX_MS);
    }
    if !background_enabled {
        return 0;
    }
    std::env::var("MIXDOG_SHELL_BACKGROUND_MAX_MS")
        .ok()
        .map(|raw| mixdog_js::string_to_number(&raw))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(0, |n| (n.floor() as u64).min(TIMER_MAX_MS))
}

/// `shellCwdError` and `effectiveShellCwd`: the requested directory against the session cwd.
async fn resolve_cwd(ctx: &ToolContext, requested: Option<String>) -> Result<AbsPath, ToolError> {
    let Some(requested) = requested.filter(|c| !mixdog_js::js_trim(c).is_empty()) else {
        return Ok(ctx.cwd.clone());
    };
    let path = if requested == "~" || requested.starts_with("~/") || requested.starts_with("~\\") {
        let home = dirs::home_dir().ok_or_else(|| {
            failed(ToolErrorCode::NotFound { target: requested.clone() }, tool_failure("no home directory"))
        })?;
        home.join(requested[1..].trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(&requested)
    };
    let abs = AbsPath::new(path.clone()).unwrap_or_else(|| ctx.cwd.join(path));
    let shown = abs.as_path().display().to_string();
    match ctx.files.stat(ctx.io.interactive, abs.clone()).await {
        Ok(stat) if stat.kind == EntryKind::Dir => Ok(abs),
        Ok(_) => Err(failed(
            ToolErrorCode::InvalidArgs { field: "cwd".into(), reason: "not a directory".into() },
            tool_failure(&format!("shell cwd \"{shown}\" is not a directory")),
        )),
        Err(error) if error.kind == FsErrorKind::NotFound => Err(failed(
            ToolErrorCode::NotFound { target: requested },
            tool_failure(&format!("shell cwd \"{shown}\" does not exist")),
        )),
        Err(_) => Err(failed(
            ToolErrorCode::NotFound { target: requested },
            tool_failure(&format!("shell cwd \"{shown}\" does not exist")),
        )),
    }
}

fn spawn_failure(error: ProcessError) -> ToolError {
    let (code, detail) = match error {
        ProcessError::PermissionDenied => (ToolErrorCode::PermissionDenied, "permission denied".to_owned()),
        ProcessError::LimitReached { limit } => (
            ToolErrorCode::Unavailable {
                capability: "shell".into(),
                reason: format!("process limit {limit} reached"),
            },
            format!("too many running processes (limit {limit}); wait for one to finish"),
        ),
        ProcessError::ProgramNotFound { program } => (
            ToolErrorCode::Unavailable {
                capability: "shell".into(),
                reason: format!("program not found: {program}"),
            },
            format!("shell program not found: {program}"),
        ),
        ProcessError::Io { os_code } => (ToolErrorCode::Io { os_code }, "failed to start the command".to_owned()),
        other => (
            ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("{other:?}") },
            "failed to start the command".to_owned(),
        ),
    };
    failed(code, format!("Error: [shell-tool-failed] [spawn failed]\n\n{detail}"))
}

/// The shell was ended by its run limit (the answer is the timeout's, as in Node, whose limit runs from the hand-off).
fn ended_by_run_limit(job: &Job) -> bool {
    matches!(job.exit(), Some(ProcessExit { killed: Some(KillReason::TimeLimit), .. }))
}

/// The command could not be handed to the shell whole, so it was ended unrun. Node b6f10295a discards the helper's write
/// result (`stdinWrite`, `let _ = write_all`) and closed the input after a part, which its bootstrap ran
/// (`node-fix-partial-script.patch` fixes both); here the call fails instead.
fn input_failure(error: ProcessError) -> ToolError {
    let code = match error {
        ProcessError::Io { os_code } => ToolErrorCode::Io { os_code },
        other => ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("{other:?}") },
    };
    failed(
        code,
        "Error: [shell-tool-failed] [stdin write failed]\n\nthe command could not be passed whole to the shell, so it was not run".to_owned(),
    )
}

/// `_exitClassDiagnostic`.
fn exit_class_diagnostic(code: i32) -> String {
    if code == 126 {
        return " — 126: command found but not executable (permission or format)".to_owned();
    }
    if code > 128 && code < 165 {
        if let Some(name) = signal_name(code - 128) {
            return format!(" — 128+{}: terminated by {name}", code - 128);
        }
    }
    String::new()
}

/// The streams of a finished foreground command in one delivery within the shared budget; each
/// stream's marker names its own log unless compaction archived the full capture elsewhere.
fn foreground_payload(job: &Job, compaction: Option<&Compaction>) -> String {
    let (stdout, stderr) = job.captured();
    let own = |log: &std::path::Path| shown_path(log);
    let piece = |stream: &str, text: &str, log: &std::path::Path, compacted: Option<&String>| match (compacted, compaction) {
        (Some(compacted), Some(c)) => {
            if compacted.is_empty() {
                Piece::empty()
            } else {
                let path = c.recovery.iter().find(|r| r.stream == stream).map_or_else(|| own(log), |r| r.path.clone());
                shell_text_piece(compacted, &path)
            }
        }
        _ => shell_text_piece(text, &own(log)),
    };
    let pieces = [
        piece("stdout", &stdout, &job.stdout_log, compaction.map(|c| &c.plan.stdout)),
        piece("stderr", &stderr, &job.stderr_log, compaction.map(|c| &c.plan.stderr)),
    ];
    let bodies = fit_pieces(&pieces, delivery_full_chars() - 1.0);
    match compaction {
        Some(c) => body_with_hint(&bodies[0], &bodies[1], &recovery_hint(c.plan.kind, &c.recovery)),
        None => render_shell_output_body(&bodies[0], &bodies[1]),
    }
}

struct Compaction {
    plan: Plan,
    recovery: Vec<Recovery>,
}

/// `compactShellOutputLosslessly`: a plan that saves enough, with the full captures archived.
async fn compaction_of(
    runtime: &ExecRuntime,
    ctx: &ToolContext,
    job: &Job,
    command: &str,
    exit_code: i32,
) -> Option<Compaction> {
    let (raw_out, raw_err) = job.captured();
    let (out, err) = (strip_ansi(&raw_out), strip_ansi(&raw_err));
    let cap = std::env::var("MIXDOG_TOOL_OUTPUT_MAX_BYTES")
        .ok()
        .and_then(|raw| parse_int_prefix(&raw))
        .filter(|n| *n > 0)
        .map_or(50 * 1024, |n| n as usize);
    let plan = plan(
        command,
        &out,
        &err,
        &Outcome {
            exit_code: Some(exit_code),
            signal: false,
            timed_out: false,
            has_existing_recovery: raw_out.len() + raw_err.len() > cap,
        },
    )?;
    let data_dir = runtime.config.data_dir.as_deref()?;
    let lane = runtime.config.lanes.durability;
    let mut recovery = Vec::new();
    for (stream, raw) in [("stdout", &raw_out), ("stderr", &raw_err)] {
        if raw.is_empty() {
            continue;
        }
        recovery.push(archive::persist(lane, &ctx.cancel, data_dir, ctx.thread_id.as_str(), stream, raw).await?);
    }
    if recovery.is_empty() {
        return None;
    }
    let hint = recovery_hint(plan.kind, &recovery);
    still_worthwhile(&out, &err, &plan, &hint).then_some(Compaction { plan, recovery })
}

/// Result of a finished foreground command (`renderCompletedResult`).
async fn completed(
    runtime: &Arc<ExecRuntime>,
    ctx: &ToolContext,
    job: &Job,
    command: &str,
    analysis_command: &str,
    tee_path: Option<&Path>,
    rewrite_note: &str,
    timeout_ms: u64,
) -> ToolOutcome {
    let compaction = match job.exit() {
        Some(ProcessExit { killed: None, status: ExitStatus::Code(0) }) => {
            compaction_of(runtime, ctx, job, command, 0).await
        }
        _ => None,
    };
    let mut payload = foreground_payload(job, compaction.as_ref());
    // The result points at the logs: say when one of them lacks part of the output.
    if let Some(note) = job.log_note() {
        payload.push_str(&format!("\n\n{note}"));
    }
    // The tee file is always consumed (deleted); its tail is attached only when the run failed
    // with an empty visible capture — the `(no output)` shape that cost extra diagnostic turns.
    if let Some(tee) = tee_path {
        let lanes = runtime.config.lanes;
        let tail = spill::read_tee_tail(lanes.interactive, &ctx.cancel, tee, 16_384).await;
        spill::remove_file(lanes.durability, &ctx.cancel, tee).await;
        let (raw_out, raw_err) = job.captured();
        let visible_empty = mixdog_js::js_trim(&strip_ansi(&raw_out)).is_empty()
            && mixdog_js::js_trim(&strip_ansi(&raw_err)).is_empty();
        let failed_run = match job.exit() {
            Some(ProcessExit { killed: None, status: ExitStatus::Code(code) }) => {
                code != 0 && !is_benign_search_exit_one(analysis_command, code, false, &raw_err)
            }
            _ => true,
        };
        if let (true, true, Some(tail)) = (failed_run, visible_empty, tail) {
            payload.push_str(&filter_rescue_note(&tail));
        }
    }
    // The shell is gone but the runner saw live processes in its tree: they become a tracked task
    // so the caller leaves with a task_id that reads, completes on its own and cancels the set.
    let survivor_warning = runtime.track_survivors(job).map_or_else(String::new, |(tracked, survivors)| {
        let heading = if survivors.reachable { SURVIVING_DESCENDANTS_WARNING } else { SURVIVING_DESCENDANTS_UNREACHABLE_WARNING };
        format!("{heading}\n{}", tracked.render(true, None))
    });
    let warning_block = [survivor_warning.as_str(), rewrite_note]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let hint = if runtime.config.windows {
        powershell_bashism_hint(analysis_command, &strip_ansi(&job.captured().1))
    } else {
        String::new()
    };
    // `_composeShellFailure`: the rewrite note rides the status; the PowerShell hint follows the
    // payload of a command that failed.
    let compose = |marker: String, error: bool, failed_command: bool| {
        let prefix = if error { "Error: " } else { "" };
        let notes = if warning_block.is_empty() { String::new() } else { format!("\n{warning_block}") };
        let shown = if (error || failed_command) && !hint.is_empty() { format!("{payload}\n{hint}") } else { payload.clone() };
        place_warnings_after_status(command, format!("{prefix}{marker}{notes}\n\n{shown}"))
    };
    let Some(exit) = job.exit() else {
        let text = compose("[shell-run-failed] [missing exit status]".into(), true, false);
        return Err(failed(
            ToolErrorCode::Unavailable { capability: "shell".into(), reason: "missing exit status".into() },
            text,
        ));
    };
    let signal_of = |status: ExitStatus| match status {
        ExitStatus::Signal(n) => Some(signal_name(n).map_or_else(|| n.to_string(), str::to_owned)),
        ExitStatus::Code(_) => exit.killed.map(|_| "SIGKILL".to_owned()),
    };
    match (exit.killed, exit.status) {
        (Some(KillReason::TimeLimit), status) => {
            let signal = signal_of(status).map_or(" signal: unknown".to_owned(), |s| format!(" signal: {s}"));
            let text = compose(
                format!("[shell-run-failed] [timeout: {timeout_ms}ms{signal} cause: timeout] — command killed; partial effects may remain"),
                true,
                false,
            );
            let mut error = failed(ToolErrorCode::DeadlineExceeded { partial: true }, text);
            error.outcome_unknown = true;
            error.partial = Some(text_output(payload));
            Err(error)
        }
        (Some(_), status) => {
            let signal = signal_of(status).unwrap_or_default();
            let text = compose(format!("[shell-run-failed] [signal: {signal} cause: cancellation]"), true, false);
            let mut error = failed(ToolErrorCode::Cancelled, text);
            error.outcome_unknown = true;
            error.partial = Some(text_output(payload));
            Err(error)
        }
        (None, ExitStatus::Signal(n)) => {
            let signal = signal_name(n).map_or_else(|| n.to_string(), str::to_owned);
            let text = compose(format!("[shell-run-failed] [signal: {signal}]"), true, false);
            Err(failed(
                ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("signal {signal}") },
                text,
            ))
        }
        (None, ExitStatus::Code(code)) => {
            let (_, raw_err) = job.captured();
            let benign = is_benign_search_exit_one(analysis_command, code, false, &raw_err);
            let marker = format!(
                "[exit code: {code}]{}{}",
                if code != 0 { exit_class_diagnostic(code) } else { String::new() },
                if benign { "\n[outcome: no-match]" } else { "" }
            );
            Ok(text_output(compose(marker, false, code != 0 && !benign)))
        }
    }
}

/// The result of a command that outlived the hold (`renderBackgroundedResult`).
fn backgrounded(job: &Job, command: &str, guard_note: &str, message: &str) -> ToolOutcome {
    let block = job.render(true, None);
    let partial = job.read_output(ReadOptions { digest: true, ..ReadOptions::default() });
    let mut lines = Vec::new();
    if !guard_note.is_empty() {
        lines.push(guard_note.to_owned());
    }
    lines.push(block);
    lines.push(message.to_owned());
    if !partial.is_empty() {
        lines.push(format!("\n{partial}"));
    }
    Ok(text_output(prepend_warning(command, lines.join("\n"))))
}

#[async_trait]
impl Tool for ShellTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // Whatever the outcome or classification, a finished command is a turn boundary for the
        // review of the folder it ran in (`tool-exec.mjs`); the folder is the raw `cwd` argument
        // resolved against the session cwd, checked or not.
        let requested = args.get("cwd").and_then(JsonValue::as_str).map(str::to_owned);
        let cwd = super::settle::effective_shell_cwd(ctx.cwd.as_path(), requested.as_deref());
        let _settled = super::settle::SettleGuard::new(ctx.review.clone(), cwd);
        self.run(ctx, args).await
    }
}

impl ShellTool {
    async fn run(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let args: Args = serde_json::from_value(args).map_err(|e| {
            failed(
                ToolErrorCode::InvalidArgs { field: "arguments".into(), reason: e.to_string() },
                tool_failure(&format!("invalid arguments: {e}")),
            )
        })?;
        let runtime = &self.runtime;
        if args.command.is_empty() {
            return Err(failed(
                ToolErrorCode::InvalidArgs { field: "command".into(), reason: "required".into() },
                tool_failure("command is required"),
            ));
        }
        let check_policy = |text: &str| -> Result<(), ToolError> {
            let verdict = runtime.config.policy.evaluate(text);
            let elevation_approved =
                matches!(verdict, ExecVerdict::Ask(_)) && runtime.config.elevation.approved(ctx, text);
            match verdict.refusal(elevation_approved) {
                Some(block) => Err(failed(ToolErrorCode::PermissionDenied, tool_failure(&block))),
                None => Ok(()),
            }
        };
        // The misuse guards run first: a leading sleep, a leading `cd` (moved into `cwd`), a
        // shell file read (a note) and `git … worktree add`.
        let (guarded, guarded_cwd, guard_notes) = match guard_call(ctx, &args.command, args.cwd.as_deref(), args.background == Some(true), runtime.config.powershell).await {
            Guarded::Refused(text) => return Err(failed(ToolErrorCode::PermissionDenied, text)),
            Guarded::Run { command, cwd, notes } => (command, cwd, notes),
        };
        let cwd = resolve_cwd(ctx, guarded_cwd).await?;
        check_policy(&guarded)?;
        // wmic → Get-CimInstance (PowerShell only): the text that runs is not the text the caller
        // sent, so the note rides the result and the rewrite's deadline is a hard one.
        let mut command = guarded;
        // The shell of this spawn: the setting is read now, as Node does on every spawn.
        let configured = runtime.config.shell.configured();
        let default_shell =
            default_program(&runtime.config.shell, runtime.config.lanes.spawn, &ctx.cancel, &configured)
                .await
                .map_err(|reason| {
                    failed(
                        ToolErrorCode::Unavailable { capability: "shell".into(), reason: reason.clone() },
                        tool_failure(&reason),
                    )
                })?;
        let shell_program = chosen_shell(
            runtime.config.windows,
            &configured,
            std::env::var("MIXDOG_SHELL").ok().as_deref(),
            &default_shell,
        );
        let (mut rewrite_notes, mut hard_cap) = (Vec::<String>::new(), 0u64);
        if runtime.config.powershell {
            match rewrite_wmic_process(&command) {
                Some(Err(message)) => {
                    return Err(failed(
                        ToolErrorCode::InvalidArgs { field: "command".into(), reason: message.clone() },
                        tool_failure(&message),
                    ));
                }
                Some(Ok(rewrite)) => {
                    command = rewrite.command;
                    rewrite_notes.push(rewrite.note);
                    hard_cap = rewrite.timeout_ms;
                }
                None => {}
            }
            // Invalid PowerShell syntax is rejected; MSYS `/x/…` drive paths become `X:\…`.
            let (text, block) = preflight_powershell_hygiene(&command, true, &shell_program);
            if let Some(block) = block {
                return Err(failed(ToolErrorCode::PermissionDenied, tool_failure(&block)));
            }
            command = text;
        }
        // Effects and results are read from the command as the caller meant it.
        let analysis_command = command.clone();
        // Bash-isms that always fail in Windows PowerShell are rewritten before the first run.
        if runtime.config.windows && runtime.config.powershell && hard_cap == 0 {
            if let Some((text, note)) = rewrite_powershell_bashisms(&command) {
                command = text;
                rewrite_notes.push(note);
            }
        }
        check_policy(&command)?;
        rewrite_notes.extend(guard_notes.iter().cloned());
        let rewrite_note = rewrite_notes.into_iter().filter(|n| !n.is_empty()).collect::<Vec<_>>().join("\n");
        let guard_note = guard_notes.join("\n");
        // Inline scripts and oversized commands run from a file, so the host shell never has to
        // carry them through its quoting layer.
        let mut hoist_path = None;
        let planned = plan_hoist(
            &command,
            runtime.config.windows,
            runtime.config.powershell,
            runtime.config.script_syntax.as_ref(),
            &ctx.thread_id,
        )
        .await
        .map_err(|error| {
            // The exact `await` check could not be made: the call fails rather than guessing.
            let reason = format!("{error:?}");
            failed(
                ToolErrorCode::Unavailable { capability: "syntax.check".into(), reason: reason.clone() },
                tool_failure(&format!("script syntax check unavailable: {reason}")),
            )
        })?;
        if let Some(plan) = planned {
            if let Some(path) = spill::write_hoist_file(
                runtime.config.lanes.spawn,
                &ctx.cancel,
                plan.extension,
                &plan.body,
            )
            .await
            {
                command = plan.replace(&path.to_string_lossy().replace('\\', "/"));
                hoist_path = Some(path);
            }
        }
        let background_enabled = !env_flag("MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS", false);
        let mut time_limit = time_limit_ms(&args, background_enabled);
        if hard_cap > 0 {
            time_limit = args.timeout_ms.filter(|t| *t > 0).map_or(hard_cap, |t| t.min(hard_cap));
        }
        let hold = hold_ms(&args, time_limit, background_enabled);

        let scratch = runtime
            .config
            .data_dir
            .as_deref()
            .and_then(|data| session_scratch_dir(data, ctx.thread_id.as_str()));
        if let Some(dir) = &scratch {
            spill::create_dir(runtime.config.lanes.spawn, &ctx.cancel, dir).await;
        }
        let vars: Vec<(String, String)> = std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        // The skill launchers: files written for this installation, their directory first on PATH.
        let launcher_dir: Option<PathBuf> = match (&runtime.config.skill_runtime, runtime.config.data_dir.as_deref()) {
            (Some(rt), Some(data)) => {
                Some(spill::ensure_launchers(runtime.config.lanes.spawn, &ctx.cancel, &runtime.launchers, rt, data).await)
            }
            _ => runtime.config.skill_launcher_dir.clone(),
        };
        let mut env = shell_env(
            &vars,
            &ShellEnv {
                cwd: &cwd.as_path().to_string_lossy(),
                windows: runtime.config.windows,
                scratch_dir: scratch.as_deref(),
                skill_launcher_dir: launcher_dir.as_deref(),
            },
        );

        // A simple native `.exe` skips the PowerShell startup (Windows + PowerShell only).
        let path_value = env
            .set
            .iter()
            .chain(vars.iter())
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        let direct = plan_direct_exe(
            runtime.config.lanes.spawn,
            &ctx.cancel,
            &command,
            runtime.config.windows,
            runtime.config.powershell,
            cwd.as_path(),
            &path_value,
        )
        .await;
        let mut tee_path: Option<PathBuf> = None;
        // A PowerShell script is fed on stdin to `POWERSHELL_BOOTSTRAP` (Node's fresh pwsh spawn,
        // `shell-run-spawn.mjs`).
        let mut fed_script: Option<String> = None;
        let spec = match direct {
            Some(direct) => CommandSpec::Argv {
                program: direct.exe.to_string_lossy().into_owned(),
                args: direct.argv,
            },
            None => {
                let skill = runtime.config.skill_runtime.as_ref();
                if runtime.config.windows && runtime.config.powershell {
                    // Filter-swallow rescue: tee the unfiltered producer stream of an
                    // exactly-recognised filter pipeline, so a failing run can attach the
                    // original tail in this call. Then the UTF-8 console preamble.
                    let tmp = std::env::temp_dir().to_string_lossy().into_owned();
                    let tee = build_powershell_filter_tee_plan(&command, &spill::fresh_token(), &tmp, '\\');
                    let body = tee.as_ref().map_or_else(|| command.clone(), |t| t.command.clone());
                    tee_path = tee.map(|t| PathBuf::from(t.tee_path));
                    fed_script = Some(prefix_powershell_utf8(&body, skill));
                    CommandSpec::Shell { script: POWERSHELL_BOOTSTRAP.to_owned(), shell: Some(shell_program) }
                } else if runtime.config.powershell {
                    fed_script = Some(prefix_powershell_skill_function(&command, skill));
                    CommandSpec::Shell { script: POWERSHELL_BOOTSTRAP.to_owned(), shell: Some(shell_program) }
                } else if !runtime.config.windows && (shell_program.contains("bash") || shell_program.contains("zsh")) {
                    // The command travels in the environment, not argv, behind a snapshot of the
                    // user's shell state when one can be made.
                    let mut wrapped = command.clone();
                    if std::env::var("MIXDOG_BASH_SNAPSHOT").as_deref() != Ok("off") {
                        if let (Some(data), Some(dir)) = (runtime.config.data_dir.as_deref(), launcher_dir.as_deref()) {
                            let snapshot = runtime
                                .snapshots
                                .get(SnapshotRequest {
                                    processes: &ctx.processes,
                                    lane: runtime.config.lanes.spawn,
                                    cancel: &ctx.cancel,
                                    shell_path: &shell_program,
                                    data_dir: data,
                                    launcher_dir: &dir.to_string_lossy(),
                                    cwd: cwd.clone(),
                                    thread: ctx.thread_id.clone(),
                                    call: ctx.call_id.clone(),
                                })
                                .await;
                            if let Some(snapshot) = snapshot {
                                wrapped = wrap_with_snapshot(&snapshot.to_string_lossy(), &command);
                            }
                        }
                    }
                    env.set.push(("MIXDOG_SHELL_SCRIPT".to_owned(), wrapped));
                    CommandSpec::Shell {
                        script: EVAL_SCRIPT.to_owned(),
                        shell: Some(shell_program),
                    }
                } else {
                    CommandSpec::Shell { script: command.clone(), shell: None }
                }
            }
        };

        let task_id = format!("task-{}", ctx.call_id);
        let request = SpawnRequest {
            handle: ProcessHandle(task_id.clone()),
            command: spec,
            cwd,
            env,
            pty: None,
            stdin_piped: fed_script.is_some(),
            output: OutputMode::Separate,
            owner: ProcessOwner::Tool {
                thread_id: ctx.thread_id.clone(),
                tool_call_id: ctx.call_id.clone(),
            },
            time_limit: (time_limit > 0).then(|| Duration::from_millis(time_limit)),
        };
        // A PowerShell script runs in the parked warm standby when it matches (`takeStandby`, `shell-run-spawn.mjs`),
        // fed what the hand-off sets first; any miss spawns.
        let fresh = request.handle.clone();
        let standby = match (&fed_script, &request.command) {
            (Some(_), CommandSpec::Shell { shell: Some(program), .. }) if runtime.config.warm_standby => {
                runtime.standby.take(&ctx.processes, program, &request.env)
            }
            _ => None,
        };
        let hand_off = super::standby::hand_off_prelude(&request.env, &request.cwd.as_path().to_string_lossy());
        let started = runtime
            .start(&ctx.processes, request, standby, task_id, command.clone(), ctx.thread_id.clone(), time_limit, ctx.review.clone(), ctx.options.notify.clone())
            .await;
        let job = match started {
            Ok(job) => job,
            Err(error) => {
                if let Some(path) = &hoist_path {
                    spill::remove_file(runtime.config.lanes.durability, &ctx.cancel, path).await;
                }
                return Err(spawn_failure(error));
            }
        };
        // The whole script, of any size, then end of input, written while the call holds: Node hands the helper the
        // whole string in one `stdinWrite` and starts its hold and run limit at once (`shell-run-spawn.mjs`), so they cover
        // a shell that does not read its input. The bootstrap runs the script only when the length its first line declares
        // arrived (`frame_powershell_script`), and the input is closed only once all of it was written; a write that failed
        // ends the tree (the process manager ends it before it lets go of the input) and the call fails, unless the run
        // limit had ended the shell already.
        let mut input_failed = None;
        if let Some(mut script) = fed_script {
            if job.handle != fresh {
                script.insert_str(0, &hand_off);
            }
            let framed = frame_powershell_script(&script);
            drop(script);
            let (failed, failure) = tokio::sync::oneshot::channel();
            let (processes, handle) = (Arc::clone(&ctx.processes), job.handle.clone());
            drop(mixdog_rt::spawn("shell-stdin", mixdog_rt::TaskClass::Work, async move {
                match processes.write_stdin_whole(&handle, framed.into_bytes()).await {
                    Ok(()) => {
                        let _ = processes.close_stdin(&handle);
                    }
                    Err(error) => {
                        // The failure is published before the kill: the kill settles the job, and a caller that sees the
                        // settle must already find the failure, so a script that was not written whole always answers
                        // with the input failure and never with the cancellation the kill looks like.
                        let _ = failed.send(error);
                        // A kill of a process that already exited is not an error.
                        let _ = processes.kill(&handle);
                    }
                }
            }));
            input_failed = Some(failure);
        }
        let write_failed = async {
            match input_failed {
                Some(failure) => match failure.await {
                    Ok(error) => error,
                    Err(_) => std::future::pending().await,
                },
                None => std::future::pending().await,
            }
        };
        let mut write_failed = std::pin::pin!(write_failed);
        ctx.progress.progress(ToolProgress::ProcessStarted(job.handle.clone()));
        // The hoisted file goes when the command has settled (a promoted or killed tree may still
        // be running from it until then).
        if let Some(path) = hoist_path {
            runtime.remove_when_settled(&job, path, ctx.cancel.clone());
        }

        let reason: PromotionReason;
        if hold > 0 {
            // New user input or a notification ends the hold, the same wake `task wait` uses.
            let wait = runtime.config.wake.begin(&ctx.thread_id);
            // A run limit at or below the hold has no budget left to hand to a background task:
            // the limit is enforced instead of promoting.
            let enforce_limit = time_limit > 0 && time_limit <= hold;
            let hold_timer = async {
                if enforce_limit {
                    std::future::pending::<()>().await;
                } else {
                    mixdog_rt::time::sleep(Duration::from_millis(hold)).await;
                }
            };
            tokio::select! {
                biased;
                error = &mut write_failed => {
                    let _ = mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await;
                    runtime.release(&job.id);
                    if ended_by_run_limit(&job) {
                        return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
                    }
                    return Err(input_failure(error));
                }
                () = job.settled() => {
                    runtime.release(&job.id);
                    return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
                }
                // Ahead of the two promotions below: a cancelled call that is also due for the background is killed, never left
                // running behind a call that was cancelled.
                () = ctx.cancel.cancelled() => {
                    // A kill of a process that just exited is not an error.
                    let _ = ctx.processes.kill(&job.handle);
                    let _ = mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await;
                    runtime.release(&job.id);
                    return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
                }
                () = hold_timer => {
                    reason = if args.background == Some(true) {
                        PromotionReason::Background
                    } else if time_limit > foreground_cap_ms(hold) && hold == foreground_cap_ms(hold) {
                        PromotionReason::Timeout
                    } else {
                        PromotionReason::Threshold
                    };
                }
                () = wait.released() => {
                    reason = match wait.wake().map(|w| w.reason) {
                        Some(WakeReason::Notification) => PromotionReason::Notification,
                        _ => PromotionReason::Input,
                    };
                }
            }
        } else {
            tokio::select! {
                biased;
                error = &mut write_failed => {
                    let _ = mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await;
                    if !ended_by_run_limit(&job) {
                        runtime.release(&job.id);
                        return Err(input_failure(error));
                    }
                }
                () = job.settled() => {}
                () = ctx.cancel.cancelled() => {
                    let _ = ctx.processes.kill(&job.handle);
                    let _ = mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await;
                }
            }
            runtime.release(&job.id);
            return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
        }
        if job.detach(runtime.now_ms(), runtime.cycle_of(&job.owner)) {
            runtime.promote(&job.id);
            // A promoted command's tee file is consumed (deleted) when it settles.
            if let Some(tee) = tee_path.clone() {
                runtime.remove_when_settled(&job, tee, ctx.cancel.clone());
            }
            backgrounded(&job, &command, &guard_note, &background_message(reason, runtime.now_ms().saturating_sub(job.started_ms)))
        } else {
            runtime.release(&job.id);
            completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `_exitClassDiagnostic` for 15 exit codes, recorded on Windows (its signal table).
    #[cfg(windows)]
    #[test]
    fn exit_class_diagnostics_equal_nodes() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("testdata/psfix_node_vectors.json")).unwrap();
        let cases = vectors["diagnostics"].as_array().unwrap();
        assert_eq!(cases.len(), 15);
        for case in cases {
            let code = case["code"].as_i64().unwrap() as i32;
            assert_eq!(exit_class_diagnostic(code), case["text"].as_str().unwrap(), "{code}");
        }
    }

    #[test]
    fn the_unix_signal_table_names_the_linux_signals() {
        use super::super::jobs::unix_signal_name;
        assert_eq!(unix_signal_name(6), Some("SIGABRT"));
        assert_eq!(unix_signal_name(9), Some("SIGKILL"));
        assert_eq!(unix_signal_name(15), Some("SIGTERM"));
        assert_eq!(unix_signal_name(32), None);
    }
}
