//! What an agent's status card says about its progress (Node `session-runtime/services/
//! agent-task-status.mjs`): the stage, what it last did, how long it has been silent, the
//! watchdog's budgets and a one-line diagnosis. Everything here is *reported*: the stale
//! verdict is a sentence on the card (`stale: task stale (…)`), never an action. Nothing in
//! this module aborts, kills or fails a task, and no timer drives it; it is a function of the
//! runtime facts the host hands in and the clock at the read.

use mixdog_js::js_trim;
use mixdog_tools::exec::most_significant_duration;

/// The stages a worker is doing model or tool work in.
const ACTIVE_RUNTIME_STAGES: [&str; 7] =
    ["connecting", "requesting", "streaming", "tool_running", "resource_wait", "running", "cancelling"];

/// How far keepalives may extend liveness past the last real progress, as a multiple of the
/// idle budget (`KEEPALIVE_MAX_IDLE_MULTIPLIER`).
const KEEPALIVE_MAX_IDLE_MULTIPLIER: i64 = 3;

fn is_active_stage(stage: &str) -> bool {
    ACTIVE_RUNTIME_STAGES.contains(&stage)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SemanticKind {
    Tool,
    Text,
    Reasoning,
}

/// The session runtime's progress snapshot (`getSessionProgressSnapshot`). A clock of `0`
/// is "never".
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Snapshot {
    pub stage: Option<String>,
    pub last_progress_at: i64,
    pub last_stream_delta_at: i64,
    pub tool_started_at: i64,
    pub ask_started_at: i64,
    pub first_activity_at: i64,
    pub model_request_started_at: i64,
    pub last_keepalive_at: i64,
    pub last_visible_text_at: i64,
    pub awaiting_model_response: bool,
    pub waiting_for_transport: bool,
    pub waiting_for_first_semantic: bool,
    pub has_first_semantic: bool,
    pub awaiting_user: bool,
    pub last_semantic_kind: Option<SemanticKind>,
}

/// The session runtime record (`getSessionRuntime`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct RuntimeFacts {
    pub last_progress_at: i64,
    pub last_stream_delta_at: i64,
    pub tool_started_at: i64,
    pub ask_started_at: i64,
    pub empty_final: bool,
    pub last_tool_call: Option<String>,
}

/// The deadlines the agent's progress policy names, in milliseconds (`0` = off).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct WatchdogPolicy {
    pub first_transport_ms: i64,
    pub first_semantic_ms: i64,
    pub idle_stale_ms: i64,
}

impl WatchdogPolicy {
    pub fn active(&self) -> bool {
        self.first_transport_ms > 0 || self.first_semantic_ms > 0 || self.idle_stale_ms > 0
    }
}

/// Whether a progress watchdog is registered for the session, and why its last check failed.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct WatchdogState {
    pub registered: bool,
    pub error: Option<String>,
}

/// The quietest shell job a `task wait` is parked on (`waitedJobSilence`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolSilence {
    pub task_id: String,
    pub silent_ms: u64,
    pub hung: bool,
}

#[derive(Clone, Default, Debug)]
pub struct ProgressInput<'a> {
    pub now: i64,
    pub session_status: Option<&'a str>,
    pub runtime_stage: Option<&'a str>,
    pub snapshot: Option<&'a Snapshot>,
    pub runtime: Option<&'a RuntimeFacts>,
    pub policy: Option<WatchdogPolicy>,
    pub watchdog_state: Option<&'a WatchdogState>,
    pub queued_followups: Option<u64>,
    pub task_status: Option<&'a str>,
    pub last_tool_call: Option<&'a str>,
    pub tool_silence: Option<&'a ToolSilence>,
}

/// `{worker_stage, last_progress, diagnostic, silent_for?, watchdog?, tool_silent_for?,
/// queued_followups?}`.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct Progress {
    pub worker_stage: String,
    pub last_progress: String,
    pub diagnostic: String,
    pub silent_for_secs: Option<u64>,
    pub watchdog: Option<String>,
    pub tool_silent_for: Option<String>,
    pub queued_followups: Option<u64>,
}

fn clean_stage(value: Option<&str>) -> String {
    let text = js_trim(value.unwrap_or_default());
    if text.is_empty() { "unknown".to_owned() } else { text.to_owned() }
}

/// `positiveSeconds`: whole seconds since `ts`, `None` for a clock that never ran.
fn positive_seconds(now: i64, ts: i64) -> Option<u64> {
    (ts > 0).then(|| (now - ts).max(0) as u64 / 1000)
}

fn format_tool_silence(ms: u64) -> String {
    let text = most_significant_duration(ms);
    if text.is_empty() { "0s".to_owned() } else { text }
}

/// `Math.round(ms / 1000)` of a non-negative budget.
fn rounded_secs(ms: i64) -> i64 {
    (ms as f64 / 1000.0).round() as i64
}

fn watchdog_summary(policy: Option<WatchdogPolicy>, snapshot: Option<&Snapshot>, state: Option<&WatchdogState>) -> Option<String> {
    let policy = policy.filter(WatchdogPolicy::active)?;
    let state = state.filter(|s| s.registered);
    let Some(state) = state else { return Some("not armed (no registered progress watchdog)".to_owned()) };
    if let Some(error) = state.error.as_deref().filter(|e| !e.is_empty()) {
        return Some(format!("check failed: {error}"));
    }
    let (transport, semantic) = (policy.first_transport_ms, policy.first_semantic_ms);
    if let Some(snapshot) = snapshot {
        if snapshot.waiting_for_transport && transport > 0 {
            return Some(format!("armed transport={}s", rounded_secs(transport)));
        }
        if snapshot.waiting_for_first_semantic && semantic > 0 {
            return Some(format!("armed semantic={}s", rounded_secs(semantic)));
        }
        if policy.idle_stale_ms > 0 {
            return Some(format!("armed idle={}s", rounded_secs(policy.idle_stale_ms)));
        }
    }
    let mut parts = Vec::new();
    if transport > 0 {
        parts.push(format!("transport={}s", rounded_secs(transport)));
    }
    if semantic > 0 {
        parts.push(format!("semantic={}s", rounded_secs(semantic)));
    }
    if policy.idle_stale_ms > 0 {
        parts.push(format!("idle={}s", rounded_secs(policy.idle_stale_ms)));
    }
    (!parts.is_empty()).then(|| format!("armed {}", parts.join(" ")))
}

fn silent_for(now: i64, snapshot: Option<&Snapshot>, runtime: Option<&RuntimeFacts>) -> Option<u64> {
    let mut last = 0;
    if let Some(s) = snapshot {
        last = last.max(s.last_progress_at).max(s.last_stream_delta_at).max(s.tool_started_at).max(s.ask_started_at);
    }
    if let Some(r) = runtime {
        last = last.max(r.last_progress_at).max(r.last_stream_delta_at).max(r.tool_started_at).max(r.ask_started_at);
    }
    positive_seconds(now, last)
}

/// `evaluateAgentWatchdogAbort`, as a report: the sentence the policy would stop the agent
/// with, or `None`. Reading it stops nothing.
pub fn stale_report(snapshot: &Snapshot, now: i64, policy: &WatchdogPolicy) -> Option<String> {
    // A turn blocked on the user's approval is waiting on a person, not stalled.
    if snapshot.awaiting_user {
        return None;
    }
    let started = snapshot.model_request_started_at;
    // No request timestamp while connecting: the request is still queued for admission.
    if started == 0 && snapshot.stage.as_deref() == Some("connecting") {
        return None;
    }
    let (transport, semantic) = (policy.first_transport_ms, policy.first_semantic_ms);
    if snapshot.waiting_for_transport && transport > 0 && started != 0 && now - started > transport {
        return Some(format!("agent first transport stale ({transport}ms)"));
    }
    if snapshot.waiting_for_first_semantic && semantic > 0 && started != 0 && now - started > semantic {
        return Some(format!("agent first semantic response stale ({semantic}ms)"));
    }
    if snapshot.waiting_for_first_semantic {
        return None;
    }
    let last = if snapshot.last_progress_at != 0 { snapshot.last_progress_at } else { snapshot.first_activity_at };
    if policy.idle_stale_ms > 0 && last != 0 && now - last > policy.idle_stale_ms {
        let keepalive = snapshot.last_keepalive_at;
        let holds = keepalive > last
            && now - keepalive <= policy.idle_stale_ms
            && now - last <= policy.idle_stale_ms * KEEPALIVE_MAX_IDLE_MULTIPLIER;
        if holds {
            return None;
        }
        return Some(format!("agent task stale ({}ms without stream/tool progress)", policy.idle_stale_ms));
    }
    None
}

/// `message.replace(/^agent /i, '')`.
fn without_agent_prefix(message: &str) -> &str {
    match message.get(..6) {
        Some(head) if head.eq_ignore_ascii_case("agent ") => &message[6..],
        _ => message,
    }
}

fn describe_last_progress(stage: &str, input: &ProgressInput<'_>, silent: Option<u64>, last_tool_call: Option<&str>) -> String {
    let snapshot = input.snapshot;
    let flag = |f: fn(&Snapshot) -> bool| snapshot.is_some_and(f);
    if flag(|s| s.awaiting_model_response) {
        return "model thinking (request sent; awaiting response headers)".to_owned();
    }
    if flag(|s| s.waiting_for_transport) {
        return "awaiting model transport".to_owned();
    }
    if flag(|s| s.waiting_for_first_semantic) {
        return "transport active; awaiting first model event".to_owned();
    }
    match stage {
        "tool_running" => {
            let tool = clean_stage(last_tool_call);
            return if tool != "unknown" { format!("tool: {tool}") } else { "tool running".to_owned() };
        }
        "connecting" | "requesting" => return "connecting to model".to_owned(),
        "streaming" => {
            match snapshot.and_then(|s| s.last_semantic_kind) {
                Some(SemanticKind::Tool) => return "tool protocol progress".to_owned(),
                Some(SemanticKind::Text) => return "visible model text".to_owned(),
                Some(SemanticKind::Reasoning) => {
                    return if snapshot.is_some_and(|s| s.last_visible_text_at != 0) {
                        "model reasoning (hidden; visible output previously emitted)".to_owned()
                    } else {
                        "model reasoning (hidden; no visible output yet)".to_owned()
                    };
                }
                None => {}
            }
            if flag(|s| s.has_first_semantic) {
                return "model active (no visible output yet)".to_owned();
            }
            let delta = snapshot.map_or(0, |s| s.last_stream_delta_at);
            let delta = if delta != 0 { delta } else { input.runtime.map_or(0, |r| r.last_stream_delta_at) };
            return match positive_seconds(input.now, delta) {
                Some(secs) if secs >= 5 => format!("streaming (no stream delta for {secs}s)"),
                _ => "streaming".to_owned(),
            };
        }
        "cancelling" => return "cancelling".to_owned(),
        "resource_wait" => return "waiting for execution capacity".to_owned(),
        "done" | "idle" => {
            return if input.runtime.is_some_and(|r| r.empty_final) { "finished empty".to_owned() } else { "idle".to_owned() };
        }
        "error" => return "error".to_owned(),
        "closed" => return "closed".to_owned(),
        _ => {}
    }
    match silent {
        Some(secs) if is_active_stage(stage) => format!("active ({secs}s since last progress)"),
        _ => stage.to_owned(),
    }
}

fn describe_diagnostic(stage: &str, input: &ProgressInput<'_>, silent: Option<u64>, queued: Option<u64>) -> String {
    let task = clean_stage(input.task_status).to_lowercase();
    match task.as_str() {
        "cancelled" | "canceled" => return "task cancelled".to_owned(),
        "failed" | "error" => return "task failed".to_owned(),
        "completed" => {
            return if input.session_status == Some("error") {
                "task completed (worker error)".to_owned()
            } else {
                "task completed; worker idle".to_owned()
            };
        }
        _ => {}
    }
    // Reported to the owner, never acted on: a quiet job can be a legitimate build.
    if let Some(quiet) = input.tool_silence.filter(|q| q.hung && stage == "tool_running") {
        return format!(
            "tool possibly hung: shell job {} no output for {}; inspect or cancel it",
            quiet.task_id,
            format_tool_silence(quiet.silent_ms)
        );
    }
    if let Some(queued) = queued {
        let plural = if queued == 1 { "" } else { "s" };
        return if is_active_stage(stage) {
            format!("{stage}, {queued} follow-up{plural} queued")
        } else {
            format!("idle, {queued} follow-up{plural} queued")
        };
    }
    if let (Some(policy), Some(snapshot)) = (input.policy.as_ref(), input.snapshot) {
        if let Some(stale) = stale_report(snapshot, input.now, policy) {
            return format!("stale: {}", without_agent_prefix(&stale));
        }
    }
    let snapshot = input.snapshot;
    let flag = |f: fn(&Snapshot) -> bool| snapshot.is_some_and(f);
    if flag(|s| s.awaiting_model_response) {
        return "model thinking; request sent, response headers pending".to_owned();
    }
    if flag(|s| s.waiting_for_transport) {
        return "waiting for model transport".to_owned();
    }
    if flag(|s| s.waiting_for_first_semantic) {
        return "transport healthy; waiting for first semantic model event".to_owned();
    }
    if stage == "streaming" {
        match snapshot.and_then(|s| s.last_semantic_kind) {
            Some(SemanticKind::Tool) => return "tool protocol active".to_owned(),
            Some(SemanticKind::Text) => return "visible text streaming".to_owned(),
            Some(SemanticKind::Reasoning) => {
                return if snapshot.is_some_and(|s| s.last_visible_text_at != 0) {
                    "hidden reasoning active; visible output previously emitted".to_owned()
                } else {
                    "hidden reasoning active; no visible output yet".to_owned()
                };
            }
            None => {}
        }
        if flag(|s| s.has_first_semantic) {
            return "model active; no visible output yet".to_owned();
        }
        return match positive_seconds(input.now, snapshot.map_or(0, |s| s.last_stream_delta_at)) {
            Some(secs) if secs >= 5 => format!("streaming, no visible output yet ({secs}s)"),
            _ => "streaming".to_owned(),
        };
    }
    match stage {
        "tool_running" => return "tool running".to_owned(),
        "resource_wait" => return "waiting to reacquire execution capacity".to_owned(),
        "connecting" | "requesting" => return "waiting for first response".to_owned(),
        _ => {}
    }
    if let (Some(silent), Some(policy)) = (silent, input.policy.as_ref())
        && is_active_stage(stage)
    {
        let probe = Snapshot { stage: Some(stage.to_owned()), last_progress_at: input.now - silent as i64 * 1000, ..Snapshot::default() };
        let used = input.snapshot.unwrap_or(&probe);
        if let Some(stale) = stale_report(used, input.now, policy) {
            return format!("stale: {}", without_agent_prefix(&stale));
        }
    }
    if task == "running" && (stage == "idle" || stage == "done") {
        return "task running; worker turn finished, awaiting job reconciliation".to_owned();
    }
    match stage {
        "idle" | "done" => "idle".to_owned(),
        "cancelling" => "cancelling".to_owned(),
        "error" => "worker error".to_owned(),
        "closed" => "closed".to_owned(),
        _ => stage.to_owned(),
    }
}

/// `buildAgentTaskProgressFields`.
pub fn progress_fields(input: &ProgressInput<'_>) -> Progress {
    // `runtimeStage || snapshot?.stage || sessionStatus || 'unknown'`: an empty string is skipped.
    let stage = clean_stage(
        [input.runtime_stage, input.snapshot.and_then(|s| s.stage.as_deref()), input.session_status].into_iter().flatten().find(|s| !s.is_empty()),
    );
    let silent = silent_for(input.now, input.snapshot, input.runtime);
    let watchdog = watchdog_summary(input.policy, input.snapshot, input.watchdog_state);
    let queued = input.queued_followups.filter(|n| *n > 0);
    let last_tool_call = input.last_tool_call.or(input.runtime.and_then(|r| r.last_tool_call.as_deref()));
    let tool_silent_for = input
        .tool_silence
        .filter(|_| stage == "tool_running")
        .map(|q| format!("{} (shell job {} no output)", format_tool_silence(q.silent_ms), q.task_id));
    Progress {
        last_progress: describe_last_progress(&stage, input, silent, last_tool_call),
        diagnostic: describe_diagnostic(&stage, input, silent, queued),
        silent_for_secs: silent.filter(|_| is_active_stage(&stage)),
        watchdog,
        tool_silent_for,
        queued_followups: queued,
        worker_stage: stage,
    }
}

/// `terminalJobFrozenFields`: a finished task reports only its own status; no live worker
/// is read for it (its tag may by now belong to another job).
pub fn frozen_progress(task_status: &str) -> Progress {
    let stage = {
        let lowered = js_trim(task_status).to_lowercase();
        if lowered.is_empty() { "unknown".to_owned() } else { lowered }
    };
    progress_fields(&ProgressInput { runtime_stage: Some(&stage), task_status: Some(&stage), ..ProgressInput::default() })
}
