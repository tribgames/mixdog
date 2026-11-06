//! `agent`: spawn, send, list, close, cancel, status, read and cleanup of delegated agents. The
//! orchestration (tags, workers, admission, resume of reaped tags) belongs to the agent runtime
//! behind [`AgentPort`]; this module owns the call guards and the result rendering. The port
//! reports typed facts (a worker row says whether it is active, a job whether it is finished);
//! no status wording is classified here.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_js::JsRegex;
use crate::orch::util::JsStr;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ports::CallerFacts;
use super::ports::HEARTBEAT_NO_HANDOFF;
use super::session::SessionPort;
use super::util::PortError;
use super::util::cancelled;
use super::util::clean;
use super::util::one_line;
use super::util::pretty;
use super::util::refused;
use super::util::spec_from_def;
use super::util::text;

const ROSTER_TAIL: usize = 5;
const ROSTER_MATCH_CAP: usize = 25;

#[derive(Clone, PartialEq, Debug, Default)]
pub struct WorkerRow {
    pub tag: String,
    pub status: Option<String>,
    /// The worker stage, `worker_stage` when the row has one.
    pub stage: Option<String>,
    pub last_progress: Option<String>,
    pub tool_silent_for: Option<String>,
    /// The "tool possibly hung" diagnostic, when that is what the row shows.
    pub hung_diagnostic: Option<String>,
    /// Working, or waiting on the user.
    pub active: bool,
    /// Sort stamp (ISO-8601) for the inactive tail.
    pub stamp: String,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct JobRow {
    pub task_id: String,
    pub kind: String,
    pub status: String,
    pub tag: Option<String>,
    pub error: Option<String>,
    /// Can never progress again.
    pub finished: bool,
    pub stamp: String,
}

/// A background task envelope (spawn/send/status/cancel ack, with or without a result).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct TaskView {
    pub task_id: String,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub reused: bool,
    pub respawned: bool,
    pub resumed: bool,
    pub note: Option<String>,
    pub tag: Option<String>,
    pub session_id: Option<String>,
    pub agent: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: Option<bool>,
    pub worker_status: Option<String>,
    pub stage: Option<String>,
    pub worker_stage: Option<String>,
    pub last_progress: Option<String>,
    pub silent_for_secs: Option<u64>,
    pub tool_silent_for: Option<String>,
    pub watchdog: Option<String>,
    pub queued_followups: Option<u64>,
    pub diagnostic: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// `3m12s`, with `(running)` while unfinished.
    pub elapsed: Option<String>,
    pub error: Option<String>,
    pub result: Option<TaskResult>,
}

#[derive(Clone, PartialEq, Debug)]
pub enum TaskResult {
    Content(String),
    Json(Value),
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct QueuedView {
    pub reused: bool,
    pub resumed: bool,
    pub tag: Option<String>,
    pub session_id: Option<String>,
    pub agent: Option<String>,
    pub queue_depth: Option<u64>,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct ClosedView {
    pub closed: bool,
    pub tag: Option<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub forgotten: bool,
}

#[derive(Clone, PartialEq, Debug, Default)]
pub struct ContentView {
    pub handoff_only: bool,
    pub respawned: bool,
    pub tag: Option<String>,
    pub agent: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub content: String,
}

#[derive(Clone, PartialEq, Debug)]
pub enum AgentReply {
    Roster { workers: Vec<WorkerRow>, jobs: Vec<JobRow> },
    Task { view: TaskView, diagnostics: bool },
    Queued(QueuedView),
    Closed(ClosedView),
    Content(ContentView),
    Text(String),
    Json(Value),
}

pub struct AgentRequest<'a> {
    pub thread: &'a ThreadId,
    pub call: &'a ToolCallId,
    /// The call's arguments without `attachments`, `attachmentParts` and `skillSelection`.
    pub args: Value,
    pub attachment_parts: Vec<Value>,
    pub cwd: &'a AbsPath,
    pub cancel: &'a CancellationToken,
}

#[async_trait]
pub trait AgentPort: Send + Sync {
    async fn execute(&self, request: AgentRequest<'_>) -> Result<AgentReply, PortError>;
}

fn strip_final_answer_wrapper(value: &str) -> String {
    let trimmed = value.js_trim();
    let re = JsRegex::new_static(r"^<final-answer\b[^>]*>(.*?)</final-answer>\s*$", "is");
    re.captures(trimmed).and_then(|c| c.get(1)).map_or_else(|| trimmed.to_owned(), |c| c.js_trim().to_owned())
}

/// `2026-11-06T01:38:16.222Z` → `2026-11-06 01:38:16Z`.
fn compact_iso(value: &str) -> String {
    let text = value.js_trim();
    if text.is_empty() {
        return String::new();
    }
    let replaced = text.replacen('T', " ", 1);
    JsRegex::new_static(r"\.\d+Z$", "").replace_all_with(&replaced, |_| "Z".to_owned())
}

fn worker_line(w: &WorkerRow) -> String {
    let status = w.status.as_deref().filter(|s| !s.is_empty()).unwrap_or("idle");
    let stage = w.stage.as_deref().filter(|s| !s.is_empty() && *s != status).map(|s| format!("/{s}")).unwrap_or_default();
    let progress = one_line(w.last_progress.as_deref().unwrap_or_default());
    let summary = if progress.js_len() > 60 {
        format!("{}…", mixdog_js::slice_utf16(&progress, 59))
    } else {
        progress
    };
    let summary = if summary.is_empty() { String::new() } else { format!("  {summary}") };
    let silence = one_line(w.tool_silent_for.as_deref().unwrap_or_default());
    let silence = if silence.is_empty() { String::new() } else { format!("  tool_silent_for: {silence}") };
    let hung = one_line(w.hung_diagnostic.as_deref().unwrap_or_default());
    let hung = if hung.is_empty() { String::new() } else { format!("  ! {hung}") };
    format!("- {}  {status}{stage}{summary}{silence}{hung}", w.tag)
}

fn job_line(j: &JobRow) -> String {
    let error = if j.status == "failed" { one_line(j.error.as_deref().unwrap_or_default()) } else { String::new() };
    let error = if error.is_empty() { String::new() } else { format!(" error={error}") };
    format!("- {}  {}  {}  {}{error}", j.task_id, j.kind, j.status, j.tag.as_deref().filter(|t| !t.is_empty()).unwrap_or("-"))
}

/// Inactive rows collapse to a count plus a short tail; a `tag` filter lists the matching
/// inactive rows (bounded) so a specific one can still be found.
fn inactive_section<T>(
    label: &str,
    rows: &[&T],
    render: fn(&T) -> String,
    tag_of: fn(&T) -> String,
    stamp_of: fn(&T) -> &str,
    filter: &str,
) -> Vec<String> {
    if rows.is_empty() {
        return Vec::new();
    }
    let needle = filter.to_lowercase();
    let matched: Option<Vec<&&T>> = (!needle.is_empty())
        .then(|| rows.iter().filter(|r| tag_of(r).to_lowercase().contains(&needle)).collect());
    let mut pool: Vec<&T> = match &matched {
        Some(m) => m.iter().map(|r| **r).collect(),
        None => rows.to_vec(),
    };
    pool.sort_by(|a, b| stamp_of(b).cmp(stamp_of(a)));
    let take = if matched.is_some() { ROSTER_MATCH_CAP } else { ROSTER_TAIL };
    let shown: Vec<&T> = pool.into_iter().take(take).collect();
    let shown_filter = mixdog_js::js_words(filter).collect::<Vec<_>>().join(" ");
    let head = match &matched {
        Some(m) => format!("{label}: {} ({} match tag \"{shown_filter}\", showing {})", rows.len(), m.len(), shown.len()),
        None => format!("{label}: {} (latest {}; pass tag=<text> to find one)", rows.len(), shown.len()),
    };
    let mut out = vec![format!("- {head}")];
    out.extend(shown.iter().map(|r| render(r)));
    out
}

/// The roster: active workers and running tasks in full; idle/closed workers and finished tasks
/// as counts with a bounded tail.
pub fn render_roster(workers: &[WorkerRow], jobs: &[JobRow], filter: &str) -> String {
    let mut lines = vec![format!("agents: {} · tasks: {}", workers.len(), jobs.len())];
    lines.extend(workers.iter().filter(|w| w.active).map(worker_line));
    lines.extend(jobs.iter().filter(|j| !j.finished).map(job_line));
    let idle: Vec<&WorkerRow> = workers.iter().filter(|w| !w.active).collect();
    lines.extend(inactive_section(
        "idle/closed agents",
        &idle,
        worker_line,
        |w| w.tag.clone(),
        |w| w.stamp.as_str(),
        filter,
    ));
    let done: Vec<&JobRow> = jobs.iter().filter(|j| j.finished).collect();
    lines.extend(inactive_section(
        "finished tasks",
        &done,
        job_line,
        |j| j.tag.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| j.task_id.clone()),
        |j| j.stamp.as_str(),
        filter,
    ));
    if workers.is_empty() && jobs.is_empty() {
        lines.push("(no agents or tasks)".to_owned());
    }
    lines.join("\n")
}

fn put(lines: &mut Vec<String>, label: &str, value: &Option<String>) {
    if let Some(value) = value.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("{label}: {value}"));
    }
}

fn task_diagnostic_lines(v: &TaskView) -> Vec<String> {
    let mut lines = Vec::new();
    put(&mut lines, "agent", &v.agent);
    if let (Some(p), Some(m)) = (v.provider.as_deref().filter(|s| !s.is_empty()), v.model.as_deref().filter(|s| !s.is_empty())) {
        lines.push(format!("model: {p}/{m}"));
    }
    put(&mut lines, "effort", &v.effort);
    if let Some(fast) = v.fast {
        lines.push(format!("fast: {}", if fast { "on" } else { "off" }));
    }
    if v.stage.as_deref().is_some_and(|s| !s.is_empty()) || v.worker_status.as_deref().is_some_and(|s| !s.is_empty()) {
        lines.push(format!(
            "worker: {}/{}",
            v.worker_status.as_deref().filter(|s| !s.is_empty()).unwrap_or("unknown"),
            v.stage.as_deref().filter(|s| !s.is_empty()).unwrap_or("unknown")
        ));
    }
    put(&mut lines, "worker_stage", &v.worker_stage);
    put(&mut lines, "last_progress", &v.last_progress);
    if let Some(s) = v.silent_for_secs {
        lines.push(format!("silent_for: {s}s"));
    }
    put(&mut lines, "tool_silent_for", &v.tool_silent_for);
    put(&mut lines, "watchdog", &v.watchdog);
    if let Some(n) = v.queued_followups {
        lines.push(format!("queued_followups: {n}"));
    }
    put(&mut lines, "diagnostic", &v.diagnostic);
    if let Some(s) = v.started_at.as_deref().map(compact_iso).filter(|s| !s.is_empty()) {
        lines.push(format!("started: {s}"));
    }
    if let Some(s) = v.finished_at.as_deref().map(compact_iso).filter(|s| !s.is_empty()) {
        lines.push(format!("finished: {s}"));
    }
    put(&mut lines, "elapsed", &v.elapsed);
    lines
}

pub fn render_task(v: &TaskView, include_diagnostics: bool) -> String {
    // A fresh spawn/send ack carries no diagnostics: they would all be "not started yet".
    let is_start_ack = !include_diagnostics
        && v.status.as_deref() == Some("running")
        && matches!(v.kind.as_deref(), Some("spawn" | "send"));
    let mut lines = vec![format!("agent task: {}", v.task_id)];
    if let Some(status) = v.status.as_deref().filter(|s| !s.js_trim().is_empty()) {
        lines.push(format!("status: {status}"));
    }
    if let Some(kind) = v.kind.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("type: {kind}"));
    }
    for (flag, label) in [(v.reused, "reused: true"), (v.respawned, "respawned: true"), (v.resumed, "resumed: true")] {
        if flag {
            lines.push(label.to_owned());
        }
    }
    if let Some(note) = v.note.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("note: {note}"));
    }
    if v.tag.as_deref().is_some_and(|s| !s.is_empty()) || v.session_id.as_deref().is_some_and(|s| !s.is_empty()) {
        lines.push(
            format!("target: {} {}", v.tag.as_deref().filter(|s| !s.is_empty()).unwrap_or("-"), v.session_id.as_deref().unwrap_or_default())
                .js_trim()
                .to_owned(),
        );
    }
    if !is_start_ack {
        lines.extend(task_diagnostic_lines(v));
    }
    if let Some(error) = v.error.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("error: {error}"));
    }
    if v.status.as_deref() == Some("running") {
        lines.push("notification: completion will be delivered; end the turn.".to_owned());
    }
    match &v.result {
        Some(TaskResult::Content(content)) if !content.is_empty() => {
            lines.push(String::new());
            lines.push(strip_final_answer_wrapper(content));
        }
        Some(TaskResult::Content(_)) => {
            lines.push(String::new());
            lines.push(pretty(&Value::String(String::new())));
        }
        Some(TaskResult::Json(value)) => {
            lines.push(String::new());
            lines.push(pretty(value));
        }
        None => {}
    }
    lines.join("\n")
}

pub fn render_queued(v: &QueuedView) -> String {
    let mut lines = vec!["agent message queued".to_owned()];
    if v.reused {
        lines.push("reused: true".to_owned());
    }
    if v.resumed {
        lines.push("resumed: true".to_owned());
    }
    lines.push(
        format!("target: {} {}", v.tag.as_deref().filter(|s| !s.is_empty()).unwrap_or("-"), v.session_id.as_deref().unwrap_or_default())
            .js_trim()
            .to_owned(),
    );
    if let Some(agent) = v.agent.as_deref().filter(|s| !s.is_empty()) {
        lines.push(format!("agent: {agent}"));
    }
    lines.push(format!("queueDepth: {}", v.queue_depth.unwrap_or(1)));
    lines.join("\n")
}

pub fn render_closed(v: &ClosedView) -> String {
    let mut lines = vec![format!("agent close: {}", if v.closed { "ok" } else { "not closed" })];
    for (label, value) in [("tag", &v.tag), ("sessionId", &v.session_id), ("task_id", &v.task_id)] {
        if let Some(value) = value.as_deref().filter(|s| !s.is_empty()) {
            lines.push(format!("{label}: {value}"));
        }
    }
    if v.forgotten {
        lines.push("forgotten: true".to_owned());
    }
    lines.join("\n")
}

pub fn render_content(v: &ContentView) -> String {
    if v.handoff_only {
        return strip_final_answer_wrapper(&v.content);
    }
    let mut header = vec![if v.respawned { "agent respawned".to_owned() } else { "agent result".to_owned() }];
    if let Some(tag) = v.tag.as_deref().filter(|s| !s.is_empty()) {
        header.push(format!("tag={tag}"));
    }
    if let Some(agent) = v.agent.as_deref().filter(|s| !s.is_empty()) {
        header.push(format!("agent={agent}"));
    }
    if let (Some(p), Some(m)) = (v.provider.as_deref().filter(|s| !s.is_empty()), v.model.as_deref().filter(|s| !s.is_empty())) {
        header.push(format!("{p}/{m}"));
    }
    format!("{}\n{}", header.join(" "), strip_final_answer_wrapper(&v.content))
}

pub fn render(reply: &AgentReply, list_filter: &str) -> String {
    match reply {
        AgentReply::Roster { workers, jobs } => render_roster(workers, jobs, list_filter),
        AgentReply::Task { view, diagnostics } => render_task(view, *diagnostics),
        AgentReply::Queued(v) => render_queued(v),
        AgentReply::Closed(v) => render_closed(v),
        AgentReply::Content(v) => render_content(v),
        AgentReply::Text(t) => t.clone(),
        AgentReply::Json(v) => pretty(v),
    }
}

pub struct AgentTool {
    spec: ToolSpec,
    port: Arc<dyn AgentPort>,
    sessions: Arc<dyn SessionPort>,
    facts: Arc<dyn CallerFacts>,
}

impl AgentTool {
    /// `sessions` resolves the call's `attachments` against the caller's conversation.
    pub fn new(port: Arc<dyn AgentPort>, sessions: Arc<dyn SessionPort>, facts: Arc<dyn CallerFacts>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/agent.json"), true, &[]), port, sessions, facts }
    }
}

#[async_trait]
impl Tool for AgentTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let kind = {
            let t = clean(args.get("type"));
            if t.is_empty() { "spawn".to_owned() } else { t.to_lowercase() }
        };
        if matches!(kind.as_str(), "spawn" | "send") && self.facts.is_heartbeat(&ctx.thread_id) {
            return Err(refused("heartbeat", format!("agent: {HEARTBEAT_NO_HANDOFF}")));
        }
        // `attachmentParts` and `skillSelection` are never the model's to set: only the resolved
        // `attachments` reach the agent's turn, and its skills are selected from its prompt.
        let mut rest = args.clone();
        let attachments = rest.as_object_mut().and_then(|o| {
            o.shift_remove("attachmentParts");
            o.shift_remove("skillSelection");
            o.shift_remove("attachments")
        });
        let attachment_parts = match &attachments {
            Some(names) => self.sessions.resolve_attachments(&ctx.thread_id, names, &ctx.cwd, "agent").await?,
            None => Vec::new(),
        };
        let request = AgentRequest {
            thread: &ctx.thread_id,
            call: &ctx.call_id,
            args: rest,
            attachment_parts,
            cwd: &ctx.cwd,
            cancel: &ctx.cancel,
        };
        let reply = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(cancelled()),
            r = self.port.execute(request) => r?,
        };
        text(render(&reply, &clean(args.get("tag"))))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn worker(tag: &str, status: &str, active: bool, stamp: &str) -> WorkerRow {
        WorkerRow { tag: tag.into(), status: Some(status.into()), active, stamp: stamp.into(), ..WorkerRow::default() }
    }

    #[test]
    fn roster_lists_active_in_full_and_inactive_as_a_tail() {
        let mut busy = worker("alpha", "running", true, "2");
        busy.stage = Some("tool_running".into());
        busy.last_progress = Some("reading   files".into());
        let workers = vec![busy, worker("beta", "idle", false, "1"), worker("gamma", "closed", false, "3")];
        let jobs = vec![
            JobRow { task_id: "t1".into(), kind: "spawn".into(), status: "running".into(), tag: Some("alpha".into()), ..JobRow::default() },
            JobRow { task_id: "t2".into(), kind: "spawn".into(), status: "failed".into(), error: Some("bad\nthing".into()), finished: true, ..JobRow::default() },
        ];
        assert_eq!(
            render_roster(&workers, &jobs, ""),
            "agents: 3 · tasks: 2\n- alpha  running/tool_running  reading files\n- t1  spawn  running  alpha\n- idle/closed agents: 2 (latest 2; pass tag=<text> to find one)\n- gamma  closed\n- beta  idle\n- finished tasks: 1 (latest 1; pass tag=<text> to find one)\n- t2  spawn  failed  - error=bad thing"
        );
        assert_eq!(render_roster(&[], &[], ""), "agents: 0 · tasks: 0\n(no agents or tasks)");
        assert!(render_roster(&workers, &jobs, "bet").contains("(1 match tag \"bet\", showing 1)"));
    }

    #[test]
    fn start_ack_is_minimal_and_result_is_unwrapped() {
        let ack = TaskView {
            task_id: "t9".into(),
            status: Some("running".into()),
            kind: Some("spawn".into()),
            tag: Some("w".into()),
            session_id: Some("s1".into()),
            agent: Some("coder".into()),
            ..TaskView::default()
        };
        assert_eq!(
            render_task(&ack, false),
            "agent task: t9\nstatus: running\ntype: spawn\ntarget: w s1\nnotification: completion will be delivered; end the turn."
        );
        assert!(render_task(&ack, true).contains("agent: coder"));
        let done = TaskView {
            task_id: "t9".into(),
            status: Some("completed".into()),
            result: Some(TaskResult::Content("<final-answer id=1>\n done \n</final-answer>".into())),
            ..TaskView::default()
        };
        assert_eq!(render_task(&done, false), "agent task: t9\nstatus: completed\n\ndone");
    }

    /// Golden twin: `golden/agent_render.json` is `renderResult` of today's Node product run on
    /// the same facts (recorded with the node render module, no live turn needed).
    #[test]
    fn renders_equal_the_recorded_node_output() {
        let golden: Value = serde_json::from_str(include_str!("golden/agent_render.json")).expect("golden");
        let g = |k: &str| golden[k].as_str().expect(k).to_owned();
        let mut busy = worker("alpha", "running", true, "");
        busy.stage = Some("tool_running".into());
        busy.last_progress = Some("reading   files".into());
        let workers = vec![busy, worker("beta", "idle", false, "1"), worker("gamma", "closed", false, "3")];
        let jobs = vec![
            JobRow { task_id: "t1".into(), kind: "spawn".into(), status: "running".into(), tag: Some("alpha".into()), ..JobRow::default() },
            JobRow { task_id: "t2".into(), kind: "spawn".into(), status: "failed".into(), error: Some("bad\nthing".into()), finished: true, ..JobRow::default() },
        ];
        assert_eq!(render(&AgentReply::Roster { workers, jobs }, ""), g("roster"));
        assert_eq!(render(&AgentReply::Roster { workers: vec![], jobs: vec![] }, ""), g("empty"));
        let ack = TaskView {
            task_id: "t9".into(),
            status: Some("running".into()),
            kind: Some("spawn".into()),
            tag: Some("w".into()),
            session_id: Some("s1".into()),
            agent: Some("coder".into()),
            ..TaskView::default()
        };
        assert_eq!(render(&AgentReply::Task { view: ack.clone(), diagnostics: false }, ""), g("start_ack"));
        assert_eq!(render(&AgentReply::Task { view: ack, diagnostics: true }, ""), g("start_ack_status"));
        let done = TaskView {
            task_id: "t9".into(),
            status: Some("completed".into()),
            result: Some(TaskResult::Content("<final-answer id=1>\n done \n</final-answer>".into())),
            ..TaskView::default()
        };
        assert_eq!(render(&AgentReply::Task { view: done, diagnostics: false }, ""), g("done"));
        let queued = QueuedView { tag: Some("w".into()), session_id: Some("s".into()), ..QueuedView::default() };
        assert_eq!(render(&AgentReply::Queued(queued), ""), g("queued"));
        let closed = ClosedView { closed: true, tag: Some("w".into()), task_id: Some("t1".into()), forgotten: true, ..ClosedView::default() };
        assert_eq!(render(&AgentReply::Closed(closed), ""), g("closed"));
        let content = ContentView { tag: Some("w".into()), provider: Some("p".into()), model: Some("m".into()), content: "hi".into(), ..ContentView::default() };
        assert_eq!(render(&AgentReply::Content(content), ""), g("content"));
    }

    #[test]
    fn other_envelopes_render_as_before() {
        assert_eq!(
            render_queued(&QueuedView { tag: Some("w".into()), session_id: Some("s".into()), ..QueuedView::default() }),
            "agent message queued\ntarget: w s\nqueueDepth: 1"
        );
        assert_eq!(
            render_closed(&ClosedView { closed: true, tag: Some("w".into()), forgotten: true, ..ClosedView::default() }),
            "agent close: ok\ntag: w\nforgotten: true"
        );
        let content = ContentView { tag: Some("w".into()), provider: Some("p".into()), model: Some("m".into()), content: "hi".into(), ..ContentView::default() };
        assert_eq!(render_content(&content), "agent result tag=w p/m\nhi");
        assert_eq!(render(&AgentReply::Json(json!({"a":1})), ""), "{\n  \"a\": 1\n}");
        assert_eq!(compact_iso("2026-11-06T01:38:16.222Z"), "2026-11-06 01:38:16Z");
    }
}
