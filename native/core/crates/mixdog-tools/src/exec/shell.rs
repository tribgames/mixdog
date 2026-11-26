//! Result texts follow `bash-tool/*.mjs` byte for byte.

use std::borrow::Cow;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
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
use super::bashism::rewrite_powershell_bashisms;
use super::benign::is_benign_search_exit_one;
use super::compact::Outcome;
use super::compact::Plan;
use super::compact::Recovery;
use super::compact::body_with_hint;
use super::compact::plan;
use super::compact::recovery_hint;
use super::compact::still_worthwhile;
use super::delivery::Piece;
use super::delivery::ansi_stripped;
use super::delivery::delivery_full_chars;
use super::delivery::fit_pieces;
use super::delivery::parse_int_prefix;
use super::delivery::render_shell_output_body;
use super::delivery::shell_text_piece;
use super::delivery::stripped_shell_piece;
use super::describe_type;
use super::direct::plan_direct_exe;
use super::env::ShellEnv;
use super::env::env_flag;
use super::env::session_scratch_dir;
use super::env::shell_env;
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
use super::jobs::ExecRuntime;
use super::jobs::Job;
use super::jobs::ReadOptions;
use super::jobs::shown_path;
use super::jobs::signal_name;
use super::normalize_string_list_args;
use super::psfix::powershell_bashism_hint;
use super::psfix::rewrite_wmic_process;
use super::shell_choice::chosen_shell;
use super::shell_choice::default_program;
use super::snapshot::SnapshotRequest;
use super::spill;
use super::wake::WakeReason;
use super::warning::place_warnings_after_status;
use super::warning::prepend_warning;
use crate::orch::util::spec_from_def;
use crate::policy::ExecVerdict;

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
pub(crate) const SURVIVING_DESCENDANTS_UNREACHABLE_WARNING: &str = "⚠️ the command finished but left a descendant running that this process can no longer signal (its parent exited and Windows keeps no live link to it). It stays tracked as the task below and its completion is reported, but `task cancel` may not be able to terminate it.";
const BACKGROUND_GUIDANCE: &str = "Its result is delivered automatically when it finishes; use task wait only if no other work remains.";

/// Why the command left the foreground (`promotion-results.mjs` `backgroundVerb`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PromotionReason {
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
pub(super) struct Args {
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    wait_ms: Option<u64>,
    background: Option<bool>,
}

/// `validateBuiltinArgs('shell', args)` (`arg-guard.mjs`): the null drops and list normalisation that come first, then
/// `guardShell`. The arguments the tool then runs with (an over-long `wait_ms` cut to the maximum), or the refusal
/// text Node answers with.
pub(super) fn guard_shell_args(args: JsonValue) -> Result<JsonValue, String> {
    let JsonValue::Object(mut a) = args else {
        return Err(if args.is_null() {
            "Error: shell requires arguments object (got null)".to_owned()
        } else {
            format!("Error: shell arguments must be an object (got {})", describe_type(&args))
        });
    };
    a.retain(|_, v| !v.is_null());
    normalize_string_list_args(&mut a);
    if let Some(key) = a.keys().find(|k| !matches!(k.as_str(), "command" | "cwd" | "timeout_ms" | "wait_ms" | "background")) {
        return Err(format!("Error: shell arg \"{key}\" is unsupported; use only command, cwd, timeout_ms, wait_ms, and background"));
    }
    if let Some(cwd) = a.get("cwd")
        && !cwd.as_str().is_some_and(|s| !mixdog_js::js_trim(s).is_empty())
    {
        return Err(format!("Error: shell arg \"cwd\" must be a non-empty string (got {})", describe_type(cwd)));
    }
    if let Some(background) = a.get("background")
        && !background.is_boolean()
    {
        return Err(format!("Error: shell arg \"background\" must be a boolean (got {})", describe_type(background)));
    }
    let whole = |v: &JsonValue| v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0);
    if let Some(wait) = a.get("wait_ms") {
        let over = whole(wait).filter(|n| *n > SHELL_HOLD_MAX_MS as f64);
        if over.is_some() {
            a.insert("wait_ms".to_owned(), JsonValue::from(SHELL_HOLD_MAX_MS));
        } else if !whole(wait).is_some_and(|n| n >= SHELL_HOLD_MIN_MS as f64) {
            return Err(format!(
                "Error: shell arg \"wait_ms\" must be an integer from {SHELL_HOLD_MIN_MS} to {SHELL_HOLD_MAX_MS}, e.g. wait_ms:120000 (got {})",
                serde_json::to_string(wait).unwrap_or_default()
            ));
        }
    }
    match a.get("command") {
        None => return Err("Error: shell requires \"command\"".to_owned()),
        Some(JsonValue::String(command)) if command.is_empty() => {
            return Err("Error: shell arg \"command\" must be a non-empty string".to_owned());
        }
        Some(JsonValue::String(_)) => {}
        Some(other) => {
            return Err(format!("Error: shell arg \"command\" must be a string (got {})", describe_type(other)));
        }
    }
    if let Some(timeout) = a.get("timeout_ms")
        && whole(timeout).filter(|n| *n >= 0.0).is_none()
    {
        return Err(format!("Error: shell arg \"timeout_ms\" must be a non-negative integer (got {})", describe_type(timeout)));
    }
    // JavaScript has one number type: `90000.0` and `9e4` are the integer 90000. Every integer argument that passed
    // above is handed on as one, so the typed arguments below read it.
    for key in ["wait_ms", "timeout_ms"] {
        if let Some(n) = a.get(key).and_then(whole) {
            a.insert(key.to_owned(), JsonValue::from(n as u64));
        }
    }
    Ok(JsonValue::Object(a))
}

/// The command tools of other agent CLIs (`external-tool-adapters.mjs` `BASH_SHELL_KIND_NAMES` and `BASH_DEFAULT_NAMES`):
/// `bash`, which asks for the POSIX shell, and `run`, `runcommand`, `terminal` and `run_terminal_cmd`, which take the default
/// one. They are in no tool list; a call by one of those names (in any case) runs `shell`.
pub struct ForeignShellTool {
    shell: Arc<ShellTool>,
    spec: ToolSpec,
    posix: bool,
}

impl ForeignShellTool {
    /// The two tools that stand for the foreign names of `shell`.
    pub fn of(shell: &Arc<ShellTool>) -> Vec<Arc<dyn Tool>> {
        let tool = |name: &str, aliases: &[&str], posix: bool| -> Arc<dyn Tool> {
            let mut spec = shell.spec.clone();
            spec.name = name.to_owned();
            spec.title = None;
            spec.public = false;
            spec.aliases = aliases.iter().map(|alias| (*alias).to_owned()).collect();
            Arc::new(Self { shell: shell.clone(), spec, posix })
        };
        vec![tool("bash", &[], true), tool("run", &["runcommand", "terminal", "run_terminal_cmd"], false)]
    }
}

impl ForeignShellTool {
    /// The refusal of a call that is not a command: worded by the name the model called, as Node's fallback is.
    fn refusal(&self, ctx: &ToolContext) -> String {
        crate::foreign::refusal(ctx.options.called_as.as_deref().unwrap_or(&self.spec.name))
    }
}

#[async_trait]
impl Tool for ForeignShellTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    /// `adaptBash`: only the command is required, and the keys `shell` takes are the ones passed on (the other CLI's own
    /// extras, a description or a timeout in its unit, are not the command's).
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let JsonValue::Object(given) = args else {
            return Err(failed(ToolErrorCode::InvalidArgs { field: "command".into(), reason: "required".into() }, self.refusal(ctx)));
        };
        if !given.get("command").and_then(JsonValue::as_str).is_some_and(|command| !command.is_empty()) {
            return Err(failed(ToolErrorCode::InvalidArgs { field: "command".into(), reason: "required".into() }, self.refusal(ctx)));
        }
        let kept: serde_json::Map<String, JsonValue> =
            given.into_iter().filter(|(key, _)| matches!(key.as_str(), "command" | "cwd" | "timeout_ms" | "wait_ms" | "background")).collect();
        self.shell.call_as(ctx, JsonValue::Object(kept), self.posix).await
    }
}

pub struct ShellTool {
    spec: ToolSpec,
    runtime: Arc<ExecRuntime>,
    background_enabled: bool,
}

/// The definitions Node sends (`buildShellDescription` / `buildShellCommandDescription`, written for
/// the shell kind) with background tasks on, and with `MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS`
/// (foreground only, the hold text gone).
const POSIX: &str = include_str!("specs/shell.posix.json");
const POWERSHELL: &str = include_str!("specs/shell.powershell.json");
const POSIX_FOREGROUND: &str = include_str!("specs/shell.posix.foreground.json");
const POWERSHELL_FOREGROUND: &str = include_str!("specs/shell.powershell.foreground.json");

/// The kind of shell the tool text is written for (`shellType`).
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
        Self { spec: shell_spec(ShellKind::of(runtime.config.windows), enabled), runtime, background_enabled: enabled }
    }
}

/// `formatShellToolFailure`.
pub(crate) fn tool_failure(message: &str) -> String {
    let trimmed = mixdog_js::js_trim(message);
    let stripped = trimmed.get(..6).filter(|head| head.eq_ignore_ascii_case("error:")).map_or(trimmed, |_| mixdog_js::js_trim(&trimmed[6..]));
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
pub(super) fn hold_ms(args: &Args, timeout_ms: u64, background_enabled: bool, env: &dyn Fn(&str) -> Option<String>) -> u64 {
    if !background_enabled {
        return 0;
    }
    let hold = if args.background == Some(true) {
        BACKGROUND_START_HOLD_MS
    } else if let Some(wait) = args.wait_ms.filter(|w| *w > 0) {
        wait.clamp(SHELL_HOLD_MIN_MS, SHELL_HOLD_MAX_MS)
    } else {
        env("MIXDOG_SHELL_AUTO_BACKGROUND_MS")
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
pub(super) fn foreground_cap_ms(hold: u64, env: &dyn Fn(&str) -> Option<String>) -> u64 {
    let configured = env("BASH_MAX_TIMEOUT_MS").and_then(|raw| parse_int_prefix(&raw)).filter(|n| *n > 0).map_or(120_000, |n| n as u64);
    configured.max(hold)
}

/// Whether the foreground run is promoted when the foreground window ends (`promoteAtTimeout`): with no run limit, or one
/// longer than the window, there is budget left to hand to a background task.
pub(super) fn promotes_at_timeout(background_enabled: bool, time_limit: u64, hold: u64, env: &dyn Fn(&str) -> Option<String>) -> bool {
    background_enabled && (time_limit == 0 || time_limit > foreground_cap_ms(hold, env))
}

/// What the end of the hold does, the one decision both the wait and the promotion message follow: `None` enforces the
/// run limit (a limit at or below the hold has no budget left to hand to a background task; Node does not arm its
/// threshold timer then, `armDeadlines`), `Some(reason)` promotes the run for that reason.
pub(super) fn hold_end(background: bool, time_limit: u64, hold: u64, env: &dyn Fn(&str) -> Option<String>) -> Option<PromotionReason> {
    if time_limit > 0 && time_limit <= hold {
        None
    } else if background {
        Some(PromotionReason::Background)
    } else if time_limit > 0 && promotes_at_timeout(true, time_limit, hold, env) && hold == foreground_cap_ms(hold, env) {
        Some(PromotionReason::Timeout)
    } else {
        Some(PromotionReason::Threshold)
    }
}

/// The caller or rewrite can set a hard run limit. The safety net only arms on promotion,
/// but counts elapsed foreground time toward the background deadline.
pub(super) fn run_limits_ms(args: &Args, hard_cap: u64, env: &dyn Fn(&str) -> Option<String>) -> (u64, u64) {
    let explicit = args.timeout_ms.filter(|t| *t > 0).map_or(0, |t| t.min(TIMER_MAX_MS));
    let hard = match (explicit, hard_cap) {
        (0, cap) => cap,
        (limit, 0) => limit,
        (limit, cap) => limit.min(cap),
    };
    if hard > 0 {
        return (hard, 0);
    }
    let background = env("MIXDOG_SHELL_BACKGROUND_MAX_MS")
        .map(|raw| mixdog_js::string_to_number(&raw))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(0, |n| (n.floor() as u64).min(TIMER_MAX_MS));
    (0, background)
}

/// `shellCwdError` and `effectiveShellCwd`: the requested directory against the session cwd.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn resolve_cwd(ctx: &ToolContext, requested: Option<String>) -> Result<AbsPath, ToolError> {
    let Some(requested) = requested.filter(|c| !mixdog_js::js_trim(c).is_empty()) else {
        return Ok(ctx.cwd.clone());
    };
    // The one folded form (`resolve(sessionCwd, expandHome(cwd))`): the process, the job record and every
    // "is something running in this folder" test see the same spelling.
    let resolved = super::settle::resolved_shell_cwd(ctx.cwd.as_path(), Some(&requested))
        .ok_or_else(|| failed(ToolErrorCode::NotFound { target: requested.clone() }, tool_failure("no home directory")))?;
    let abs = AbsPath::new(PathBuf::from(&resolved)).unwrap_or_else(|| ctx.cwd.join(&resolved));
    let shown = abs.as_path().display().to_string();
    match ctx.files.stat(ctx.io.interactive, abs.clone()).await {
        Ok(stat) if stat.kind == EntryKind::Dir => Ok(abs),
        Ok(_) => Err(failed(
            ToolErrorCode::InvalidArgs { field: "cwd".into(), reason: "not a directory".into() },
            tool_failure(&format!("shell cwd \"{shown}\" is not a directory")),
        )),
        Err(error) if error.kind == FsErrorKind::NotFound => {
            Err(failed(ToolErrorCode::NotFound { target: requested }, tool_failure(&format!("shell cwd \"{shown}\" does not exist"))))
        }
        Err(_) => Err(failed(ToolErrorCode::NotFound { target: requested }, tool_failure(&format!("shell cwd \"{shown}\" does not exist")))),
    }
}

fn spawn_failure(error: ProcessError) -> ToolError {
    let (code, detail) = match error {
        ProcessError::PermissionDenied => (ToolErrorCode::PermissionDenied, "permission denied".to_owned()),
        ProcessError::LimitReached { limit } => (
            ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("process limit {limit} reached") },
            format!("too many running processes (limit {limit}); wait for one to finish"),
        ),
        ProcessError::ProgramNotFound { program } => (
            ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("program not found: {program}") },
            format!("shell program not found: {program}"),
        ),
        ProcessError::Io { os_code } => (ToolErrorCode::Io { os_code }, "failed to start the command".to_owned()),
        other => (ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("{other:?}") }, "failed to start the command".to_owned()),
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
    failed(code, "Error: [shell-tool-failed] [stdin write failed]\n\nthe command could not be passed whole to the shell, so it was not run".to_owned())
}

/// `_exitClassDiagnostic`.
fn exit_class_diagnostic(code: i32) -> String {
    if code == 126 {
        return " — 126: command found but not executable (permission or format)".to_owned();
    }
    if code > 128
        && code < 165
        && let Some(name) = signal_name(code - 128)
    {
        return format!(" — 128+{}: terminated by {name}", code - 128);
    }
    String::new()
}

fn compacted_payload(job: &Job, compaction: &Compaction) -> String {
    let pieces = [("stdout", compaction.plan.stdout.as_str(), &job.stdout_log), ("stderr", compaction.plan.stderr.as_str(), &job.stderr_log)].map(
        |(stream, compacted, log)| {
            let path = compaction.recovery.iter().find(|r| r.stream == stream);
            match path {
                Some(r) => shell_text_piece(compacted, &r.path),
                None => shell_text_piece(compacted, &shown_path(log)),
            }
        },
    );
    let bodies = fit_pieces(&pieces, delivery_full_chars() - 1.0);
    body_with_hint(&bodies[0], &bodies[1], &recovery_hint(compaction.plan.kind, &compaction.recovery))
}

#[derive(Default)]
struct ForegroundOutput {
    payload: String,
    exit: Option<ProcessExit>,
    benign_search: bool,
    hint: String,
    attach_rescue: bool,
}

impl ForegroundOutput {
    fn recheck_exit(&mut self, read_exit: impl FnOnce() -> Option<ProcessExit>, settled_no_match: impl FnOnce() -> bool) {
        if self.exit.is_none() {
            self.exit = read_exit();
            self.benign_search = clean_exit_code(self.exit) == Some(1) && settled_no_match();
        }
    }
}

fn clean_exit_code(exit: Option<ProcessExit>) -> Option<i32> {
    match exit {
        Some(ProcessExit { killed: None, status: ExitStatus::Code(code) }) => Some(code),
        _ => None,
    }
}

/// Share each stream's decoded capture between ordinary delivery and any diagnostics. Spilled
/// delivery uses its bounded edges; only diagnostics can ask for the retained text of that stream.
fn foreground_payload(
    job: &Job,
    cached: Option<[&str; 2]>,
    exit: Option<ProcessExit>,
    analysis_command: &str,
    windows: bool,
    rescue: bool,
) -> ForegroundOutput {
    job.foreground_streams(|[out, err]| {
        let clean_exit = clean_exit_code(exit);
        let check_benign = clean_exit == Some(1);
        let err_edge = err.spilled_piece();
        let benign_search = check_benign && !err.has_non_whitespace() && is_benign_search_exit_one(analysis_command, 1, false, "");
        let may_have_failed = clean_exit != Some(0) && !benign_search;
        let err_raw = (cached.is_none() && (err_edge.is_none() || (windows && may_have_failed))).then(|| err.capture());
        let err_text = cached.map_or_else(|| ansi_stripped(err_raw.as_deref().unwrap_or("")), |text| text[1].into());
        let hint = if windows && may_have_failed { powershell_bashism_hint(analysis_command, &err_text) } else { String::new() };
        let err_empty = if err_edge.is_some() { !err.has_non_whitespace() } else { mixdog_js::js_trim(&err_text).is_empty() };
        let check_stdout = rescue && may_have_failed && err_empty;
        let out_edge = out.spilled_piece();
        let out_raw = (cached.is_none() && out_edge.is_none()).then(|| out.capture());
        let out_text = cached.map_or_else(|| ansi_stripped(out_raw.as_deref().unwrap_or("")), |text| text[0].into());
        let out_empty = if out_edge.is_some() { !out.has_non_whitespace() } else { mixdog_js::js_trim(&out_text).is_empty() };
        let attach_rescue = check_stdout && out_empty;
        let pieces: [Piece<'_>; 2] = [
            out_edge.unwrap_or_else(|| stripped_shell_piece(out_text, &shown_path(out.log))),
            err_edge.unwrap_or_else(|| stripped_shell_piece(err_text, &shown_path(err.log))),
        ];
        let bodies = fit_pieces(&pieces, delivery_full_chars() - 1.0);
        ForegroundOutput { payload: render_shell_output_body(&bodies[0], &bodies[1]), exit, benign_search, hint, attach_rescue }
    })
}

struct Compaction {
    plan: Plan,
    recovery: Vec<Recovery>,
}

/// Keep the prepared memory capture only when the plan was rejected and ordinary
/// delivery can reuse it. A spilled stream always uses its own edge delivery.
async fn try_compaction(runtime: &ExecRuntime, ctx: &ToolContext, job: &Job, command: &str) -> (Option<Compaction>, Option<[String; 2]>) {
    let Some((raw, spilled)) = compaction_input(runtime, ctx, job).await else { return (None, None) };
    let stripped = raw.each_ref().map(|text| ansi_stripped(text));
    let compacted = compaction_of(runtime, ctx, command, &raw, stripped.each_ref().map(|s| s.as_ref())).await;
    if compacted.is_some() || spilled {
        return (compacted, None);
    }
    let [out_stripped, err_stripped] = stripped.map(|text| match text {
        Cow::Borrowed(_) => None,
        Cow::Owned(text) => Some(text),
    });
    let [out, err] = raw;
    (None, Some([out_stripped.unwrap_or(out), err_stripped.unwrap_or(err)]))
}

async fn compaction_input(runtime: &ExecRuntime, ctx: &ToolContext, job: &Job) -> Option<([String; 2], bool)> {
    if job.captured_bytes() > crate::fs::common::output_max_bytes() || runtime.config.data_dir.is_none() || !env_flag("MIXDOG_SHELL_LOSSLESS_COMPACT", true) {
        return None;
    }
    // A configured cap above the memory limit can admit a spilled capture. Only its logs
    // have the whole output. If either log is incomplete, keep the ordinary delivery instead.
    let spilled = job.spilled();
    let (out, err) = if spilled { job.captured_from_logs(runtime.config.lanes.interactive, &ctx.cancel).await? } else { job.captured() };
    Some(([out, err], spilled))
}

/// `compactShellOutputLosslessly`: a plan that saves enough, with the full captures archived.
async fn compaction_of(runtime: &ExecRuntime, ctx: &ToolContext, command: &str, raw: &[String; 2], [out, err]: [&str; 2]) -> Option<Compaction> {
    let plan = plan(command, out, err, &Outcome { exit_code: Some(0), signal: false, timed_out: false, has_existing_recovery: false })?;
    let data_dir = runtime.config.data_dir.as_deref()?;
    let lane = runtime.config.lanes.durability;
    let mut recovery = Vec::new();
    for (stream, raw) in ["stdout", "stderr"].into_iter().zip(raw) {
        if raw.is_empty() {
            continue;
        }
        recovery.push(archive::persist(lane, &ctx.cancel, data_dir, ctx.thread_id.as_str(), stream, raw).await?);
    }
    if recovery.is_empty() {
        return None;
    }
    let hint = recovery_hint(plan.kind, &recovery);
    still_worthwhile(out, err, &plan, &hint).then_some(Compaction { plan, recovery })
}

/// Result of a finished foreground command (`renderCompletedResult`).
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
#[allow(clippy::too_many_arguments, reason = "Preserve the existing process ownership and result-rendering boundary and its explicit call arguments.")]
async fn completed(
    runtime: &Arc<ExecRuntime>,
    ctx: &ToolContext,
    job: &Arc<Job>,
    command: &str,
    analysis_command: &str,
    tee_path: Option<&Path>,
    rewrite_note: &str,
    timeout_ms: u64,
) -> ToolOutcome {
    let (compaction, cached) = match job.exit() {
        Some(ProcessExit { killed: None, status: ExitStatus::Code(0) }) => try_compaction(runtime, ctx, job, command).await,
        _ => (None, None),
    };
    // The tee file is always consumed (deleted); its tail is attached only when the run failed
    // with an empty visible capture — the `(no output)` shape that cost extra diagnostic turns.
    let tee_tail = if let Some(tee) = tee_path {
        let lanes = runtime.config.lanes;
        let tail = spill::read_tee_tail(lanes.interactive, &ctx.cancel, tee, 16_384).await;
        // A killed command whose exit was not confirmed may still hold the file: it goes when the job settles.
        runtime.remove_when_settled(job, tee.to_owned()).await;
        tail
    } else {
        None
    };
    // The shell is gone but the runner saw live processes in its tree: they become a tracked task
    // so the caller leaves with a task_id that reads, completes on its own and cancels the set.
    let survivor_warning = runtime.track_survivors(job).map_or_else(String::new, |(tracked, survivors)| {
        let heading = if survivors.reachable { SURVIVING_DESCENDANTS_WARNING } else { SURVIVING_DESCENDANTS_UNREACHABLE_WARNING };
        format!("{heading}\n{}", tracked.render(true, None))
    });
    let warning_block = [survivor_warning.as_str(), rewrite_note].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    let exit = job.exit();
    let mut output = match compaction {
        Some(c) => ForegroundOutput { payload: compacted_payload(job, &c), exit, ..ForegroundOutput::default() },
        None => foreground_payload(
            job,
            cached.as_ref().map(|text| text.each_ref().map(String::as_str)),
            exit,
            analysis_command,
            runtime.config.windows,
            tee_tail.is_some(),
        ),
    };
    // The result points at the logs: say when one of them lacks part of the output.
    if let Some(note) = job.log_note() {
        output.payload.push_str(&format!("\n\n{note}"));
    }
    output.recheck_exit(
        || job.exit(),
        || {
            // Only read stderr again after the collector has published a clean exit 1.
            job.foreground_streams(|[_, err]| !err.has_non_whitespace() && is_benign_search_exit_one(analysis_command, 1, false, ""))
        },
    );
    render_foreground_result(output, command, &warning_block, timeout_ms, &ctx.cancel, tee_tail.as_deref())
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn render_foreground_result(
    output: ForegroundOutput,
    command: &str,
    warning_block: &str,
    timeout_ms: u64,
    cancel: &tokio_util::sync::CancellationToken,
    tee_tail: Option<&str>,
) -> ToolOutcome {
    let ForegroundOutput { mut payload, exit, benign_search, hint, attach_rescue } = output;
    let clean_exit = clean_exit_code(exit);
    let benign = clean_exit == Some(1) && benign_search;
    if attach_rescue
        && clean_exit != Some(0)
        && !benign
        && let Some(tail) = tee_tail
    {
        payload.push_str(&filter_rescue_note(tail));
    }
    // `_composeShellFailure`: the rewrite note rides the status; the PowerShell hint follows the
    // payload of a command that failed.
    let compose = |marker: String, error: bool, failed_command: bool| {
        let prefix = if error { "Error: " } else { "" };
        let notes = if warning_block.is_empty() { String::new() } else { format!("\n{warning_block}") };
        let shown = if (error || failed_command) && !hint.is_empty() { format!("{payload}\n{hint}") } else { payload.clone() };
        place_warnings_after_status(command, format!("{prefix}{marker}{notes}\n\n{shown}"))
    };
    let Some(exit) = exit else {
        if cancel.is_cancelled() {
            let text = compose("[shell-run-failed] [cause: cancellation; process exit not confirmed]".into(), true, false);
            let mut error = failed(ToolErrorCode::Cancelled, text);
            error.outcome_unknown = true;
            error.partial = Some(Box::new(text_output(payload)));
            return Err(error);
        }
        let text = compose("[shell-run-failed] [missing exit status]".into(), true, false);
        return Err(failed(ToolErrorCode::Unavailable { capability: "shell".into(), reason: "missing exit status".into() }, text));
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
            error.partial = Some(Box::new(text_output(payload)));
            Err(error)
        }
        (Some(_), status) => {
            let signal = signal_of(status).unwrap_or_default();
            let text = compose(format!("[shell-run-failed] [signal: {signal} cause: cancellation]"), true, false);
            let mut error = failed(ToolErrorCode::Cancelled, text);
            error.outcome_unknown = true;
            error.partial = Some(Box::new(text_output(payload)));
            Err(error)
        }
        (None, ExitStatus::Signal(n)) => {
            let signal = signal_name(n).map_or_else(|| n.to_string(), str::to_owned);
            let text = compose(format!("[shell-run-failed] [signal: {signal}]"), true, false);
            Err(failed(ToolErrorCode::Unavailable { capability: "shell".into(), reason: format!("signal {signal}") }, text))
        }
        (None, ExitStatus::Code(code)) => {
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
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
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
        self.call_as(ctx, args, false).await
    }
}

impl ShellTool {
    /// The call, its misuse guards reading the command as POSIX syntax when `posix` and a bash resolves (`requestedShellType`: a call a foreign
    /// CLI's `bash` name makes asks for the POSIX shell) and as the default shell's otherwise.
    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    async fn call_as(&self, ctx: &ToolContext, args: JsonValue, posix: bool) -> ToolOutcome {
        // Whatever the outcome or classification, a finished command is a turn boundary for the
        // review of the folder it ran in (`tool-exec.mjs`); the folder is the raw `cwd` argument
        // resolved against the session cwd, checked or not.
        let requested = args.get("cwd").and_then(JsonValue::as_str).map(str::to_owned);
        let cwd = super::settle::effective_shell_cwd(ctx.cwd.as_path(), requested.as_deref());
        let _settled = super::settle::SettleGuard::new(ctx.review.clone(), cwd);
        self.run(ctx, args, posix, &process_env).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_reports_an_exit_confirmed_during_rendering() {
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let mut output = ForegroundOutput { payload: "partial output".into(), ..ForegroundOutput::default() };
        output.recheck_exit(|| Some(ProcessExit { status: ExitStatus::Code(137), killed: Some(KillReason::Requested) }), || false);
        let error = render_foreground_result(output, "run", "", 0, &cancel, None).unwrap_err();
        assert!(matches!(error.code, ToolErrorCode::Cancelled));
        assert_eq!(error.message_for_model, "Error: [shell-run-failed] [signal: SIGKILL cause: cancellation]\n\npartial output",);
        assert!(error.partial.is_some());
    }

    #[test]
    fn late_search_exit_one_uses_settled_stderr_for_no_match() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let command = "grep x f";
        for (stderr, expected) in [("", "[exit code: 1]\n[outcome: no-match]\n\n(no output)"), ("grep: read error\n", "[exit code: 1]\n\n(no output)")] {
            let mut output = ForegroundOutput { payload: "(no output)".into(), ..ForegroundOutput::default() };
            output.recheck_exit(|| Some(ProcessExit { status: ExitStatus::Code(1), killed: None }), || is_benign_search_exit_one(command, 1, false, stderr));
            let result = render_foreground_result(output, command, "", 0, &cancel, None).unwrap();
            assert!(matches!(result.parts.as_slice(), [ToolPart::Text(text)] if text == expected), "{stderr:?}");
        }
    }

    #[test]
    fn spilled_stderr_error_followed_by_whitespace_is_not_benign_no_match() {
        let cancel = tokio_util::sync::CancellationToken::new();
        let exit_one = Some(ProcessExit { status: ExitStatus::Code(1), killed: None });
        let pad = vec![b' '; 200 * 1024];

        let mut err_then_ws = b"grep: permission denied\n".to_vec();
        err_then_ws.extend_from_slice(&pad);
        let failed_job = Job::test_with_output(b"", &err_then_ws);
        failed_job.foreground_streams(|[_, err]| {
            assert!(err.capture().trim().is_empty(), "retained tail must be pure whitespace");
            assert!(err.has_non_whitespace(), "dropped error must still register as non-whitespace");
        });
        let failed = foreground_payload(&failed_job, None, exit_one, "grep x f", false, true);
        assert!(!failed.benign_search, "error followed by >FINISHED_KEEP whitespace must not be benign no-match");
        assert!(!failed.attach_rescue, "non-empty spilled stderr must not trigger empty-output rescue");
        let rendered = render_foreground_result(failed, "grep x f", "", 0, &cancel, None).unwrap();
        let text = match rendered.parts.as_slice() {
            [ToolPart::Text(text)] => text.as_str(),
            other => panic!("unexpected parts: {other:?}"),
        };
        assert!(!text.contains("[outcome: no-match]"), "{text}");

        let ws_only_job = Job::test_with_output(b"", &pad);
        ws_only_job.foreground_streams(|[_, err]| {
            assert!(!err.has_non_whitespace(), "spilled whitespace-only stderr stays empty");
        });
        let benign = foreground_payload(&ws_only_job, None, exit_one, "grep x f", false, false);
        assert!(benign.benign_search, "spilled whitespace-only stderr still classifies as benign no-match");
    }

    /// An integral number is an integer whatever its spelling (`90000.0`, `9e4`): both integer arguments reach the typed
    /// arguments as integers, and an over-long hold is still cut to the maximum.
    #[test]
    fn integral_floats_are_integer_arguments() {
        let guarded = guard_shell_args(serde_json::json!({"command": "x", "wait_ms": 90000.0, "timeout_ms": 1e4})).unwrap();
        let args: Args = serde_json::from_value(guarded).unwrap();
        assert_eq!((args.wait_ms, args.timeout_ms), (Some(90_000), Some(10_000)));
        let guarded = guard_shell_args(serde_json::json!({"command": "x", "wait_ms": 9e6})).unwrap();
        assert_eq!(serde_json::from_value::<Args>(guarded).unwrap().wait_ms, Some(SHELL_HOLD_MAX_MS));
        assert!(guard_shell_args(serde_json::json!({"command": "x", "wait_ms": 1500.5})).is_err());
    }

    /// `planShellDeadlines` (`deadline-plan.mjs`): `MIXDOG_SHELL_BACKGROUND_MAX_MS` is the planned background deadline of a call with no
    /// `timeout_ms`, and `wait_ms` below the minimum is refused by the guard (`arg-guard.mjs:811`) as it is in Node.
    #[test]
    fn the_background_max_is_planned_without_a_timeout_and_a_short_wait_is_refused() {
        let env = |name: &str| (name == "MIXDOG_SHELL_BACKGROUND_MAX_MS").then(|| "5000".to_owned());
        let plain: Args = serde_json::from_value(serde_json::json!({"command": "x", "wait_ms": 10_000})).unwrap();
        let (hard, background) = run_limits_ms(&plain, 0, &env);
        assert_eq!((hard, background), (0, 5000));
        let hold = hold_ms(&plain, hard, true, &env);
        assert_eq!(hold, 10_000);
        assert!(hold_end(false, hard, hold, &env) == Some(PromotionReason::Threshold));
        let explicit: Args = serde_json::from_value(serde_json::json!({"command": "x", "timeout_ms": 9000})).unwrap();
        assert_eq!(run_limits_ms(&explicit, 0, &env), (9000, 0));
        assert_eq!(run_limits_ms(&plain, 3000, &env), (3000, 0));
        assert!(guard_shell_args(serde_json::json!({"command": "x", "wait_ms": 999})).is_err());
    }

    #[test]
    fn the_unix_signal_table_names_the_linux_signals() {
        use super::super::jobs::unix_signal_name;
        assert_eq!(unix_signal_name(6), Some("SIGABRT"));
        assert_eq!(unix_signal_name(9), Some("SIGKILL"));
        assert_eq!(unix_signal_name(15), Some("SIGTERM"));
        assert_eq!(unix_signal_name(32), None);
    }

    /// An exit status above 128 names its signal and 126 names a non-executable; the Windows signal table has no
    /// entry for the other codes (134, 160 and above included).
    #[cfg(windows)]
    #[test]
    fn an_exit_status_is_explained_by_the_signal_or_the_refusal_behind_it() {
        for (code, text) in [
            (126, " — 126: command found but not executable (permission or format)"),
            (129, " — 128+1: terminated by SIGHUP"),
            (130, " — 128+2: terminated by SIGINT"),
            (137, " — 128+9: terminated by SIGKILL"),
            (139, " — 128+11: terminated by SIGSEGV"),
            (143, " — 128+15: terminated by SIGTERM"),
        ] {
            assert_eq!(exit_class_diagnostic(code), text, "{code}");
        }
        for code in [0, 1, 2, 127, 134, 160, 164, 165, 200] {
            assert_eq!(exit_class_diagnostic(code), "", "{code}");
        }
    }
}

/// The spec, the filter-rescue tee file and the PowerShell script fed on stdin to `POWERSHELL_BOOTSTRAP` (Node's fresh
/// pwsh spawn, `shell-run-spawn.mjs`).
async fn shell_command_spec(
    runtime: &ExecRuntime,
    ctx: &ToolContext,
    command: &str,
    shell_program: String,
    cwd: &AbsPath,
    launcher_dir: Option<&Path>,
    env: &mut EnvSpec,
) -> (CommandSpec, Option<PathBuf>, Option<String>) {
    let skill = runtime.config.skill_runtime.as_ref();
    if runtime.config.windows && runtime.config.powershell {
        // Filter-swallow rescue: tee the unfiltered producer stream of an exactly-recognised filter pipeline, so a
        // failing run can attach the original tail in this call. Then the UTF-8 console preamble.
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        let tee = build_powershell_filter_tee_plan(command, &spill::fresh_token(), &tmp, std::path::MAIN_SEPARATOR);
        let body = tee.as_ref().map_or_else(|| command.to_owned(), |t| t.command.clone());
        let tee_path = tee.map(|t| PathBuf::from(t.tee_path));
        let spec = CommandSpec::Shell { script: POWERSHELL_BOOTSTRAP.to_owned(), shell: Some(shell_program) };
        (spec, tee_path, Some(prefix_powershell_utf8(&body, skill)))
    } else if runtime.config.powershell {
        let spec = CommandSpec::Shell { script: POWERSHELL_BOOTSTRAP.to_owned(), shell: Some(shell_program) };
        (spec, None, Some(prefix_powershell_skill_function(command, skill)))
    } else if !runtime.config.windows && (shell_program.contains("bash") || shell_program.contains("zsh")) {
        // The command travels in the environment, not argv, behind a snapshot of the user's shell state when one can
        // be made.
        let mut wrapped = command.to_owned();
        if std::env::var("MIXDOG_BASH_SNAPSHOT").as_deref() != Ok("off")
            && let (Some(data), Some(dir)) = (runtime.config.data_dir.as_deref(), launcher_dir)
        {
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
                wrapped = wrap_with_snapshot(&snapshot.to_string_lossy(), command);
            }
        }
        env.set.push(("MIXDOG_SHELL_SCRIPT".to_owned(), wrapped));
        (CommandSpec::Shell { script: EVAL_SCRIPT.to_owned(), shell: Some(shell_program) }, None, None)
    } else {
        (CommandSpec::Shell { script: command.to_owned(), shell: None }, None, None)
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}
async fn cancel_foreground(runtime: &Arc<ExecRuntime>, ctx: &ToolContext, job: &Arc<Job>) {
    // A kill of a process that just exited is not an error.
    let _ = ctx.processes.kill(&job.handle);
    if mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await.is_ok() {
        runtime.release(&job.id);
        return;
    }
    runtime.hold_unconfirmed(job);
    let (runtime, job) = (runtime.clone(), job.clone());
    mixdog_rt::spawn("shell-unconfirmed-exit", mixdog_rt::TaskClass::Work, async move {
        job.settled().await;
        runtime.release(&job.id);
    });
}
/// The command a call runs, as the guards, policy, rewrites and hoisting leave it.
struct PreparedCommand {
    command: String,
    analysis_command: String,
    rewrite_note: String,
    guard_note: String,
    hoist_path: Option<PathBuf>,
    hard_cap: u64,
    cwd: AbsPath,
    shell_program: String,
}

impl ShellTool {
    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    async fn prepare_command(&self, ctx: &ToolContext, args: &Args, posix: bool) -> Result<PreparedCommand, ToolError> {
        let runtime = &self.runtime;
        let background_enabled = self.background_enabled;
        if !background_enabled && let Some(field) = args.background.map(|_| "background").or(args.wait_ms.map(|_| "wait_ms")) {
            let reason = "background shell tasks are disabled";
            return Err(failed(
                ToolErrorCode::InvalidArgs { field: field.into(), reason: reason.into() },
                tool_failure(&format!("{field} is unavailable: {reason}")),
            ));
        }
        if args.command.is_empty() {
            return Err(failed(ToolErrorCode::InvalidArgs { field: "command".into(), reason: "required".into() }, tool_failure("command is required")));
        }
        // A call that asks for the bash shell is read as POSIX syntax where one resolves (`requestedShellType`).
        // Reject the invalid empty command before lane admission, so a full lane cannot replace that argument error.
        let bash_requested = posix
            && super::shell_choice::bash_request_is_posix_on(runtime.config.windows, runtime.config.lanes.spawn, &ctx.cancel)
                .await
                .map_err(|reason| failed(ToolErrorCode::Unavailable { capability: "shell".into(), reason: reason.clone() }, tool_failure(&reason)))?;
        let check_policy = |text: &str| -> Result<(), ToolError> {
            let verdict = runtime.config.policy.evaluate(text);
            let elevation_approved = matches!(verdict, ExecVerdict::Ask(_)) && runtime.config.elevation.approved(ctx, text);
            match verdict.refusal(elevation_approved) {
                Some(block) => Err(failed(ToolErrorCode::PermissionDenied, tool_failure(&block))),
                None => Ok(()),
            }
        };
        // The misuse guards run first: a leading sleep, a leading `cd` (moved into `cwd`), a
        // shell file read (a note) and `git … worktree add`.
        let (guarded, guarded_cwd, guard_notes) =
            match guard_call(ctx, &args.command, args.cwd.as_deref(), args.background == Some(true), runtime.config.powershell && !bash_requested).await {
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
        let default_shell = default_program(&runtime.config.shell, runtime.config.lanes.spawn, &ctx.cancel, &configured)
            .await
            .map_err(|reason| failed(ToolErrorCode::Unavailable { capability: "shell".into(), reason: reason.clone() }, tool_failure(&reason)))?;
        let shell_program = chosen_shell(runtime.config.windows, &configured, std::env::var("MIXDOG_SHELL").ok().as_deref(), &default_shell);
        let (mut rewrite_notes, mut hard_cap) = (Vec::<String>::new(), 0u64);
        if runtime.config.powershell {
            match rewrite_wmic_process(&command) {
                Some(Err(message)) => {
                    return Err(failed(ToolErrorCode::InvalidArgs { field: "command".into(), reason: message.clone() }, tool_failure(&message)));
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
        if runtime.config.windows
            && runtime.config.powershell
            && hard_cap == 0
            && let Some((text, note)) = rewrite_powershell_bashisms(&command)
        {
            command = text;
            rewrite_notes.push(note);
        }
        check_policy(&command)?;
        rewrite_notes.extend(guard_notes.iter().cloned());
        let rewrite_note = rewrite_notes.into_iter().filter(|n| !n.is_empty()).collect::<Vec<_>>().join("\n");
        let guard_note = guard_notes.join("\n");
        // Inline scripts and oversized commands run from a file, so the host shell never has to
        // carry them through its quoting layer.
        let mut hoist_path = None;
        let planned = plan_hoist(&command, runtime.config.windows, runtime.config.powershell, runtime.config.script_syntax.as_ref(), &ctx.thread_id)
            .await
            .map_err(|error| {
                // The exact `await` check could not be made: the call fails rather than guessing.
                let reason = format!("{error:?}");
                failed(
                    ToolErrorCode::Unavailable { capability: "syntax.check".into(), reason: reason.clone() },
                    tool_failure(&format!("script syntax check unavailable: {reason}")),
                )
            })?;
        if let Some(plan) = planned
            && let Some(path) = spill::write_hoist_file(runtime.config.lanes.spawn, &ctx.cancel, plan.extension, &plan.body).await
        {
            command = plan.replace(&path.to_string_lossy().replace('\\', "/"));
            hoist_path = Some(path);
        }
        Ok(PreparedCommand { command, analysis_command, rewrite_note, guard_note, hoist_path, hard_cap, cwd, shell_program })
    }
}
/// Writes the framed script to the job's input on its own task; the receiver yields the failure of a write that did not
/// complete.
fn feed_script(ctx: &ToolContext, job: &Job, mut script: String, fresh: &ProcessHandle, hand_off: &str) -> tokio::sync::oneshot::Receiver<ProcessError> {
    if job.handle != *fresh {
        script.insert_str(0, hand_off);
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
    failure
}

impl ShellTool {
    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    pub(super) async fn run(&self, ctx: &ToolContext, args: JsonValue, posix: bool, env: &(dyn Fn(&str) -> Option<String> + Sync)) -> ToolOutcome {
        let args = guard_shell_args(args).map_err(|text| failed(ToolErrorCode::InvalidArgs { field: "arguments".into(), reason: text.clone() }, text))?;
        let args: Args = serde_json::from_value(args).map_err(|e| {
            failed(ToolErrorCode::InvalidArgs { field: "arguments".into(), reason: e.to_string() }, tool_failure(&format!("invalid arguments: {e}")))
        })?;
        let runtime = &self.runtime;
        let background_enabled = self.background_enabled;
        let PreparedCommand { command, analysis_command, rewrite_note, guard_note, hoist_path, hard_cap, cwd, shell_program } =
            self.prepare_command(ctx, &args, posix).await?;
        let (time_limit, background_limit) = run_limits_ms(&args, hard_cap, env);
        let hold = hold_ms(&args, time_limit, background_enabled, env);
        let at_hold_end = hold_end(args.background == Some(true), time_limit, hold, env);

        let scratch = runtime.config.data_dir.as_deref().and_then(|data| session_scratch_dir(data, ctx.thread_id.as_str()));
        if let Some(dir) = &scratch {
            spill::create_dir(runtime.config.lanes.spawn, &ctx.cancel, dir).await;
        }
        let vars: Vec<(String, String)> = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect();
        // The skill launchers: files written for this installation, their directory first on PATH.
        let launcher_dir: Option<PathBuf> = match (&runtime.config.skill_runtime, runtime.config.data_dir.as_deref()) {
            (Some(rt), Some(data)) => Some(spill::ensure_launchers(runtime.config.lanes.spawn, &ctx.cancel, &runtime.launchers, rt, data).await),
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
        let path_value = env.set.iter().chain(vars.iter()).find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()).unwrap_or_default();
        let direct =
            plan_direct_exe(runtime.config.lanes.spawn, &ctx.cancel, &command, runtime.config.windows, runtime.config.powershell, cwd.as_path(), &path_value)
                .await;
        let (spec, tee_path, fed_script) = match direct {
            Some(direct) => (CommandSpec::Argv { program: direct.exe.to_string_lossy().into_owned(), args: direct.argv }, None, None),
            None => shell_command_spec(runtime, ctx, &command, shell_program, &cwd, launcher_dir.as_deref(), &mut env).await,
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
            owner: ProcessOwner::Tool { thread_id: ctx.thread_id.clone(), tool_call_id: ctx.call_id.clone() },
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
            .start(
                &ctx.processes,
                request,
                standby,
                task_id,
                command.clone(),
                ctx.thread_id.clone(),
                time_limit.max(background_limit),
                ctx.review.clone(),
                ctx.options.notify.clone(),
            )
            .await;
        let job = match started {
            Ok(job) => job,
            Err(error) => {
                for path in hoist_path.iter().chain(tee_path.iter()) {
                    runtime.remove_unused(path.clone()).await;
                }
                return Err(spawn_failure(error));
            }
        };
        let input_failed = fed_script.map(|script| feed_script(ctx, &job, script, &fresh, &hand_off));
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
            runtime.remove_when_settled(&job, path).await;
        }

        let reason: PromotionReason;
        if hold > 0 {
            // New user input or a notification ends the hold, the same wake `task wait` uses.
            let wait = runtime.config.wake.begin(&ctx.thread_id);
            // A caller that must have the answer sooner gets it when the hold would end then: the command moves to the
            // background as at the end of its hold, whatever the hold or a run limit within it would do.
            let own_end = at_hold_end.map(|reason| (std::time::Instant::now() + Duration::from_millis(hold), reason));
            let ends = match (own_end, ctx.options.answer_by) {
                (Some((at, reason)), Some(by)) if at <= by => Some((at, reason)),
                (_, Some(by)) => Some((by, PromotionReason::Threshold)),
                (own, None) => own,
            };
            let hold_timer = async {
                match ends {
                    Some((at, _)) => mixdog_rt::time::sleep(at.saturating_duration_since(std::time::Instant::now())).await,
                    None => std::future::pending::<()>().await,
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
                    if let Some(tee) = tee_path.clone() {
                        runtime.remove_when_settled(&job, tee).await;
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
                    cancel_foreground(runtime, ctx, &job).await;
                    return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
                }
                () = hold_timer => {
                    reason = ends.map_or(PromotionReason::Threshold, |(_, reason)| reason);
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
                    runtime.release(&job.id);
                    if !ended_by_run_limit(&job) {
                        if let Some(tee) = tee_path.clone() {
                            runtime.remove_when_settled(&job, tee).await;
                        }
                        return Err(input_failure(error));
                    }
                }
                () = job.settled() => runtime.release(&job.id),
                () = ctx.cancel.cancelled() => cancel_foreground(runtime, ctx, &job).await,
            }
            return completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await;
        }
        let promoted = runtime.now_ms();
        if job.detach(promoted) {
            if background_limit > 0 {
                let remaining = job.remaining_time_limit_ms(promoted);
                // The process may exit between detach and arming the limit.
                let _ = ctx.processes.arm_time_limit(&job.handle, Duration::from_millis(remaining));
            }
            runtime.promote(&job.id);
            // A promoted command's tee file is consumed (deleted) when it settles.
            if let Some(tee) = tee_path.clone() {
                runtime.remove_when_settled(&job, tee).await;
            }
            backgrounded(&job, &command, &guard_note, &background_message(reason, runtime.now_ms().saturating_sub(job.started_ms)))
        } else {
            runtime.release(&job.id);
            completed(runtime, ctx, &job, &command, &analysis_command, tee_path.as_deref(), &rewrite_note, time_limit).await
        }
    }
}
