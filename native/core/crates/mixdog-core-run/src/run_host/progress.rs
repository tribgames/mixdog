//! The run's progress snapshot, published into the session cell (Node `runtime-liveness.mjs`:
//! `updateSessionStage`, `markSession*`, `getSessionProgressSnapshot`, `getSessionRuntime`).
//!
//! The cell owns a `watch::channel(RunProgress::default())`; the run holds the
//! [`ProgressPublisher`] over its sender and every marker below stamps the shared value once.
//! `Workers::live` and `LiveSessions::runtime_stage` read the receiver: [`RunProgress::live`]
//! is a function of the stored stamps and the clock of the read, so nothing here runs a timer.
//! The watchdog fields of [`WorkerLive`] (`policy`, `watchdog_state`, `queued_followups`) are
//! not the run's: the reader leaves them at their defaults.

use std::sync::Arc;

use mixdog_agent::agent_tool::progress::RuntimeFacts;
use mixdog_agent::agent_tool::progress::SemanticKind;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::progress::ToolSilence;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::env::Clock;
use mixdog_core_api::domain::tool::ToolProgress;
use mixdog_protocol::ProcessHandle;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

/// `markSessionToolOutputTail`: the live output tail keeps this many trailing characters.
const TOOL_TAIL_CHARS: usize = 4000;

/// What the running tool reports about itself while it runs: the current output tail
/// (`toolOutputTail`), the last progress text (`onProgress`) and the process it started. A new
/// tool call invalidates all of it.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct ToolHint {
    text: Option<String>,
    process: Option<ProcessHandle>,
    tail: String,
}

impl ToolHint {
    /// The `progressHint` clients are shown, `None` while the tool has reported nothing.
    pub fn to_value(&self) -> Option<Value> {
        let mut hint = serde_json::Map::new();
        if let Some(text) = &self.text {
            hint.insert("text".to_owned(), json!(text));
        }
        if let Some(process) = &self.process {
            hint.insert("processHandle".to_owned(), json!(process));
        }
        if !self.tail.is_empty() {
            hint.insert("outputTail".to_owned(), json!(self.tail));
        }
        (!hint.is_empty()).then_some(Value::Object(hint))
    }
}

/// `DEFAULT_ACTIVITY_HEARTBEAT_MS` (`stall-policy.mjs`): while a tool runs, its progress stamp
/// advances on this cadence.
const ACTIVITY_HEARTBEAT_MS: i64 = 30_000;

/// `VALID_STAGES` of `updateSessionStage`: any other stage is ignored.
const VALID_STAGES: [&str; 9] =
    ["connecting", "requesting", "streaming", "tool_running", "resource_wait", "idle", "error", "done", "cancelling"];

fn terminal(stage: &str) -> bool {
    matches!(stage, "done" | "error")
}

/// `MODEL_THINKING_STAGE`: not a stage, the provider's note that the request is on the wire.
pub const MODEL_THINKING_STAGE: &str = "model_thinking";

/// What a model-stream event proves (`_normalizeModelProgressKind`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreamKind {
    /// Raw chunks: transport health only.
    Transport,
    Keepalive,
    /// A semantic event of no named kind.
    Semantic,
    Reasoning,
    Text,
    Tool,
}

/// The shell jobs a `task wait` is parked on, read at the moment of the status read.
pub trait WaitedJobs: Send + Sync {
    /// `waitedJobSilence(ids, { now })`: the quietest running shell job, or `None`.
    fn silence(&self, ids: &[String], now_ms: i64) -> Option<ToolSilence>;
}

#[derive(Clone, Default, PartialEq, Debug)]
struct Entry {
    stage: String,
    last_stream_delta_at: i64,
    last_transport_at: i64,
    first_semantic_at: i64,
    last_semantic_at: i64,
    last_reasoning_at: i64,
    last_visible_text_at: i64,
    last_tool_protocol_at: i64,
    last_semantic_kind: Option<SemanticKind>,
    request_sent_at: i64,
    last_tool_call: Option<String>,
    tool_started_at: i64,
    last_progress_at: i64,
    last_keepalive_at: i64,
    ask_started_at: i64,
    model_request_started_at: i64,
    request_transport_at: i64,
    request_first_semantic_at: i64,
    model_response_accepted: bool,
    approval_waits: u32,
    task_waits: u32,
    task_wait_jobs: Vec<String>,
    empty_final: bool,
    /// The controller was aborted (`closeSession`): late callbacks change nothing.
    aborted: bool,
    /// When the running tool's activity heartbeat began; it ticks every `ACTIVITY_HEARTBEAT_MS`
    /// from there until the stage leaves `tool_running` or a model event arrives.
    heartbeat_from: Option<i64>,
    tool_hint: ToolHint,
    /// The turn's model loop is running (Node's `_api_call_with_interrupt` window around
    /// `agentLoop`): an abort now ends the ask "during call", before it "before call".
    in_call: bool,
}

impl Entry {
    fn new() -> Self {
        Self { stage: "idle".to_owned(), ..Self::default() }
    }

    /// The common guard of the late markers: a settled or aborted turn is never revived.
    fn live(&self) -> bool {
        !self.aborted && !terminal(&self.stage)
    }

    fn set_logical_request(&mut self, started_at: i64) {
        self.model_request_started_at = started_at;
        self.request_transport_at = 0;
        self.request_first_semantic_at = 0;
        self.model_response_accepted = false;
    }
}

/// The published value: `None` until the first marker (Node: no runtime entry yet).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct RunProgress {
    entry: Option<Entry>,
}

impl RunProgress {
    fn touch(&mut self) -> &mut Entry {
        self.entry.get_or_insert_with(Entry::new)
    }

    /// `runtime.stage`.
    pub fn stage(&self) -> Option<String> {
        self.entry.as_ref().map(|e| e.stage.clone())
    }

    /// The turn's model loop entered (`true`) or returned (`false`).
    pub fn model_loop(&mut self, running: bool) {
        self.touch().in_call = running;
    }

    /// Whether the turn's model loop is running: the window in which Node's ask settles an
    /// abort as `aborted during call`.
    pub fn in_call(&self) -> bool {
        self.entry.as_ref().is_some_and(|e| e.in_call)
    }

    /// `markSessionAskStart`: a new ask clears the previous run's stamps.
    pub fn ask_start(&mut self, now: i64) {
        let e = self.touch();
        // An approval wait is the turn's own and outlives the stamps a new ask clears.
        // The keepalive stamp is the one a new ask keeps.
        *e = Entry { stage: "connecting".to_owned(), ask_started_at: now, last_progress_at: now, approval_waits: e.approval_waits, last_keepalive_at: e.last_keepalive_at, ..Entry::default() };
    }

    /// `updateSessionStage`: `model_thinking` records the send, other stages must be valid.
    pub fn stage_change(&mut self, stage: &str, now: i64) {
        if stage == MODEL_THINKING_STAGE {
            self.request_sent(now);
            return;
        }
        if !VALID_STAGES.contains(&stage) {
            return;
        }
        let e = self.touch();
        let prior = std::mem::replace(&mut e.stage, stage.to_owned());
        e.request_sent_at = 0;
        if stage == "requesting" && (e.model_request_started_at == 0 || e.model_response_accepted || terminal(&prior)) {
            e.set_logical_request(now);
        }
        e.last_progress_at = now;
        if stage != "tool_running" {
            e.heartbeat_from = None;
        }
    }

    /// `markSessionRequestSent`: not progress.
    fn request_sent(&mut self, now: i64) {
        if let Some(e) = self.entry.as_mut().filter(|e| !e.aborted && e.stage == "requesting") {
            e.request_sent_at = now;
        }
    }

    /// `markSessionTransportActivity`.
    fn transport(&mut self, now: i64) {
        if let Some(e) = self.entry.as_mut().filter(|e| e.live()) {
            e.last_transport_at = now;
            e.request_transport_at = now;
        }
    }

    /// `markSessionStreamDelta`.
    pub fn stream_delta(&mut self, kind: StreamKind, now: i64) {
        if !self.entry.as_ref().is_some_and(Entry::live) {
            return;
        }
        match kind {
            StreamKind::Transport => return self.transport(now),
            StreamKind::Keepalive => {
                self.transport(now);
                // Before the request's first semantic event a keepalive is the first-output
                // window's business and never progress.
                let e = self.touch();
                if e.request_first_semantic_at != 0 {
                    e.last_keepalive_at = now;
                }
                return;
            }
            _ => {}
        }
        let e = self.touch();
        e.heartbeat_from = None;
        e.last_transport_at = now;
        e.request_transport_at = now;
        if e.first_semantic_at == 0 {
            e.first_semantic_at = now;
        }
        if e.request_first_semantic_at == 0 {
            e.request_first_semantic_at = now;
        }
        e.last_semantic_at = now;
        e.last_semantic_kind = match kind {
            StreamKind::Tool => Some(SemanticKind::Tool),
            StreamKind::Text => Some(SemanticKind::Text),
            StreamKind::Reasoning => Some(SemanticKind::Reasoning),
            _ => None,
        };
        match kind {
            StreamKind::Reasoning => e.last_reasoning_at = now,
            StreamKind::Text => e.last_visible_text_at = now,
            StreamKind::Tool => e.last_tool_protocol_at = now,
            _ => {}
        }
        e.last_stream_delta_at = now;
        e.last_progress_at = now;
        if e.stage == "connecting" || e.stage == "requesting" {
            e.stage = "streaming".to_owned();
        }
    }

    /// `markSessionToolCall`.
    pub fn tool_call(&mut self, name: Option<&str>, now: i64) {
        let Some(e) = self.entry.as_mut().filter(|e| e.live()) else { return };
        e.stage = "tool_running".to_owned();
        e.last_tool_call = name.filter(|n| !n.is_empty()).map(str::to_owned);
        e.tool_started_at = now;
        e.last_transport_at = now;
        e.request_transport_at = now;
        if e.first_semantic_at == 0 {
            e.first_semantic_at = now;
        }
        if e.request_first_semantic_at == 0 {
            e.request_first_semantic_at = now;
        }
        // The response whose tool call runs now was accepted: the next request is a new one.
        e.model_response_accepted = true;
        e.last_semantic_at = now;
        e.last_semantic_kind = Some(SemanticKind::Tool);
        e.last_tool_protocol_at = now;
        e.last_progress_at = now;
        e.heartbeat_from = Some(now);
        // A new tool call invalidates the previous call's live output.
        e.tool_hint = ToolHint::default();
    }

    /// What the running tool reported (`onOutputTail`, `onProgress`); `Output` replaces the
    /// tail, as the tool's own timer hands over its current one. A settled or unknown turn
    /// ignores late writes and never gets an entry. Whether the hint changed.
    pub fn tool_progress(&mut self, progress: ToolProgress) -> bool {
        let Some(e) = self.entry.as_mut().filter(|e| e.live()) else { return false };
        let before = e.tool_hint.clone();
        match progress {
            ToolProgress::Stage(text) => e.tool_hint.text = Some(text),
            ToolProgress::ProcessStarted(handle) => e.tool_hint.process = Some(handle),
            ToolProgress::Output(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let skip = text.chars().count().saturating_sub(TOOL_TAIL_CHARS);
                e.tool_hint.tail = text.chars().skip(skip).collect();
            }
        }
        e.tool_hint != before
    }

    /// The running tool's hint. Only a turn in `tool_running` shows one: that is the only stage
    /// Node's readers take the tail in.
    pub fn tool_hint(&self) -> ToolHint {
        self.entry.as_ref().filter(|e| e.stage == "tool_running").map(|e| e.tool_hint.clone()).unwrap_or_default()
    }

    /// `beginSessionApprovalWait` / its release: a counted wait on the user; each edge is
    /// progress, so the hours spent waiting are never counted as silence.
    pub fn approval_wait(&mut self, begin: bool, now: i64) {
        let Some(e) = self.entry.as_mut() else { return };
        if begin {
            e.approval_waits += 1;
        } else {
            e.approval_waits = e.approval_waits.saturating_sub(1);
        }
        if e.live() {
            e.last_progress_at = now;
        }
    }

    /// `beginSessionTaskWait` / its release.
    pub fn task_wait(&mut self, begin: bool, task_id: Option<&str>) {
        let Some(e) = self.entry.as_mut() else { return };
        if begin {
            e.task_waits += 1;
            if let Some(id) = task_id.filter(|i| !i.is_empty()) {
                e.task_wait_jobs.push(id.to_owned());
            }
        } else {
            if let Some(at) = task_id.and_then(|id| e.task_wait_jobs.iter().position(|j| j == id)) {
                e.task_wait_jobs.remove(at);
            }
            e.task_waits = e.task_waits.saturating_sub(1);
        }
    }

    /// `_settleTerminalEntry` with `markSessionDone` / `markSessionError` /
    /// `markSessionCancelled`.
    pub fn settle(&mut self, stage: &str, now: i64, keep_empty_final: bool) {
        let e = self.touch();
        e.stage = stage.to_owned();
        e.ask_started_at = 0;
        e.tool_started_at = 0;
        e.last_progress_at = now;
        e.task_waits = 0;
        e.task_wait_jobs.clear();
        e.heartbeat_from = None;
        // A success after an empty final synthesis keeps the flag; every other end clears it.
        e.empty_final &= keep_empty_final;
    }

    /// `markSessionEmptyFinal`: a success whose final synthesis was empty.
    pub fn empty_final(&mut self) {
        self.touch().empty_final = true;
    }

    /// `closeSession` aborting the turn: the stage is `cancelling` and late callbacks stop.
    pub fn cancelling(&mut self) {
        let e = self.touch();
        e.stage = "cancelling".to_owned();
        e.aborted = true;
        e.heartbeat_from = None;
    }

    /// The tool activity heartbeat's last tick at `now`.
    fn heartbeat_tick(e: &Entry, now: i64) -> i64 {
        match e.heartbeat_from {
            Some(from) if e.live() && e.stage == "tool_running" && now - from >= ACTIVITY_HEARTBEAT_MS => {
                from + (now - from) / ACTIVITY_HEARTBEAT_MS * ACTIVITY_HEARTBEAT_MS
            }
            _ => 0,
        }
    }

    /// `getSessionProgressSnapshot` at `now`; `None` before the first marker.
    pub fn snapshot(&self, now: i64) -> Option<Snapshot> {
        let e = self.entry.as_ref()?;
        let active = matches!(e.stage.as_str(), "connecting" | "requesting" | "streaming");
        let in_ask = |at: i64| at != 0 && (e.ask_started_at == 0 || at >= e.ask_started_at);
        Some(Snapshot {
            stage: Some(e.stage.clone()),
            last_progress_at: e.last_progress_at.max(Self::heartbeat_tick(e, now)),
            last_stream_delta_at: e.last_stream_delta_at,
            tool_started_at: e.tool_started_at,
            ask_started_at: e.ask_started_at,
            first_activity_at: e.first_semantic_at,
            model_request_started_at: e.model_request_started_at,
            last_keepalive_at: e.last_keepalive_at,
            last_visible_text_at: e.last_visible_text_at,
            // `awaitingModelResponse`: sent, and no transport since.
            awaiting_model_response: e.stage == "requesting" && e.request_sent_at > 0 && e.last_transport_at < e.request_sent_at,
            waiting_for_transport: e.model_request_started_at != 0 && active && e.request_transport_at == 0,
            waiting_for_first_semantic: e.model_request_started_at != 0 && active && e.request_first_semantic_at == 0,
            has_first_semantic: in_ask(e.first_semantic_at),
            awaiting_user: e.approval_waits > 0,
            last_semantic_kind: e.last_semantic_kind,
        })
    }

    /// `getSessionRuntime` at `now`.
    pub fn facts(&self, now: i64) -> Option<RuntimeFacts> {
        let e = self.entry.as_ref()?;
        Some(RuntimeFacts {
            last_progress_at: e.last_progress_at.max(Self::heartbeat_tick(e, now)),
            last_stream_delta_at: e.last_stream_delta_at,
            tool_started_at: e.tool_started_at,
            ask_started_at: e.ask_started_at,
            empty_final: e.empty_final,
            last_tool_call: e.last_tool_call.clone(),
        })
    }

    /// The runtime state a progress read is a function of, without the watchdog's fields.
    /// `toolSilence` is read only while the turn sits in `task wait`.
    pub fn live(&self, now: i64, jobs: &dyn WaitedJobs) -> WorkerLive {
        let tool_silence = self.entry.as_ref().filter(|e| e.task_waits > 0).and_then(|e| jobs.silence(&e.task_wait_jobs, now));
        WorkerLive {
            runtime_stage: self.stage(),
            snapshot: self.snapshot(now),
            runtime: self.facts(now),
            tool_silence,
            ..WorkerLive::default()
        }
    }
}

/// The run's end of the cell's channel: every marker stamps the value once and wakes readers.
#[derive(Clone)]
pub struct ProgressPublisher {
    tx: watch::Sender<RunProgress>,
    clock: Arc<dyn Clock>,
}

impl ProgressPublisher {
    pub fn new(tx: watch::Sender<RunProgress>, clock: Arc<dyn Clock>) -> Self {
        Self { tx, clock }
    }

    fn apply(&self, change: impl FnOnce(&mut RunProgress, i64)) {
        let now = self.clock.now_ms();
        self.tx.send_modify(|p| change(p, now));
    }

    pub fn ask_start(&self) {
        self.apply(|p, now| p.ask_start(now));
    }

    pub fn stage(&self, stage: &str) {
        self.apply(|p, now| p.stage_change(stage, now));
    }

    pub fn stream_delta(&self, kind: StreamKind) {
        self.apply(|p, now| p.stream_delta(kind, now));
    }

    pub fn tool_call(&self, name: Option<&str>) {
        self.apply(|p, now| p.tool_call(name, now));
    }

    pub fn approval_wait(&self, begin: bool) {
        self.apply(|p, now| p.approval_wait(begin, now));
    }

    pub fn task_wait(&self, begin: bool, task_id: Option<&str>) {
        self.apply(|p, _| p.task_wait(begin, task_id));
    }

    /// `markSessionDone({ empty })` (and `markSessionCancelled`, which is `done` without the flag).
    pub fn done(&self, empty: bool) {
        self.apply(|p, now| p.settle("done", now, empty));
    }

    pub fn error(&self) {
        self.apply(|p, now| p.settle("error", now, false));
    }

    pub fn empty_final(&self) {
        self.apply(|p, _| p.empty_final());
    }

    pub fn cancelling(&self) {
        self.apply(|p, _| p.cancelling());
    }

    /// The model loop entered or returned (`RunProgress::model_loop`).
    pub fn model_loop(&self, running: bool) {
        self.apply(|p, _| p.model_loop(running));
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    struct NoJobs;
    impl WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<ToolSilence> {
            None
        }
    }

    type Row = (&'static str, Option<Snapshot>, Option<RuntimeFacts>);

    /// Node's getSessionProgressSnapshot / getSessionRuntime, recorded after each step of
    /// the same sequence on the real runtime-liveness.mjs with a fixed clock.
    fn golden() -> Vec<Row> {
        vec![
        (
            "none",
            None,
            None,
        ),
        (
            "ask",
            Some(Snapshot {
                stage: Some("connecting".to_owned()),
                last_progress_at: 1000,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 0,
                model_request_started_at: 0,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1000,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "requesting",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 0,
                model_request_started_at: 1100,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: true,
                waiting_for_first_semantic: true,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "thinking",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 0,
                model_request_started_at: 1100,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: true,
                waiting_for_transport: true,
                waiting_for_first_semantic: true,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "transport",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 0,
                model_request_started_at: 1100,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: true,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "keepalive-before-semantic",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 0,
                model_request_started_at: 1100,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: true,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "reasoning",
            Some(Snapshot {
                stage: Some("streaming".to_owned()),
                last_progress_at: 1500,
                last_stream_delta_at: 1500,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 0,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Reasoning),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1500,
                last_stream_delta_at: 1500,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "keepalive-after",
            Some(Snapshot {
                stage: Some("streaming".to_owned()),
                last_progress_at: 1500,
                last_stream_delta_at: 1500,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Reasoning),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1500,
                last_stream_delta_at: 1500,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "text",
            Some(Snapshot {
                stage: Some("streaming".to_owned()),
                last_progress_at: 1600,
                last_stream_delta_at: 1600,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Text),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1600,
                last_stream_delta_at: 1600,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "semantic",
            Some(Snapshot {
                stage: Some("streaming".to_owned()),
                last_progress_at: 1650,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 1650,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        (
            "tool",
            Some(Snapshot {
                stage: Some("tool_running".to_owned()),
                last_progress_at: 1700,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1700,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "approval",
            Some(Snapshot {
                stage: Some("tool_running".to_owned()),
                last_progress_at: 1800,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: true,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1800,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "approval-released",
            Some(Snapshot {
                stage: Some("tool_running".to_owned()),
                last_progress_at: 1900,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 1100,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 1900,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "requesting-2",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 2000,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 2000,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: true,
                waiting_for_first_semantic: true,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 2000,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "thinking-2",
            Some(Snapshot {
                stage: Some("requesting".to_owned()),
                last_progress_at: 2000,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                first_activity_at: 1500,
                model_request_started_at: 2000,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: true,
                waiting_for_transport: true,
                waiting_for_first_semantic: true,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 2000,
                last_stream_delta_at: 1650,
                tool_started_at: 1700,
                ask_started_at: 1000,
                empty_final: false,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "done-empty",
            Some(Snapshot {
                stage: Some("done".to_owned()),
                last_progress_at: 2200,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 0,
                first_activity_at: 1500,
                model_request_started_at: 2000,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 2200,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 0,
                empty_final: true,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "late-delta",
            Some(Snapshot {
                stage: Some("done".to_owned()),
                last_progress_at: 2200,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 0,
                first_activity_at: 1500,
                model_request_started_at: 2000,
                last_keepalive_at: 1550,
                last_visible_text_at: 1600,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: true,
                awaiting_user: false,
                last_semantic_kind: Some(SemanticKind::Tool),
            }),
            Some(RuntimeFacts {
                last_progress_at: 2200,
                last_stream_delta_at: 1650,
                tool_started_at: 0,
                ask_started_at: 0,
                empty_final: true,
                last_tool_call: Some("read".to_owned()),
            }),
        ),
        (
            "error",
            Some(Snapshot {
                stage: Some("error".to_owned()),
                last_progress_at: 3100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 0,
                first_activity_at: 0,
                model_request_started_at: 3000,
                last_keepalive_at: 1550,
                last_visible_text_at: 0,
                awaiting_model_response: false,
                waiting_for_transport: false,
                waiting_for_first_semantic: false,
                has_first_semantic: false,
                awaiting_user: false,
                last_semantic_kind: None,
            }),
            Some(RuntimeFacts {
                last_progress_at: 3100,
                last_stream_delta_at: 0,
                tool_started_at: 0,
                ask_started_at: 0,
                empty_final: false,
                last_tool_call: None,
            }),
        ),
        ]
    }

    #[test]
    fn the_snapshot_follows_node_through_a_turn() {
        let mut p = RunProgress::default();
        let mut seen: Vec<(&'static str, Option<Snapshot>, Option<RuntimeFacts>)> = Vec::new();
        let mut at;
        let mut mark = |label: &'static str, p: &RunProgress, now: i64| seen.push((label, p.snapshot(now), p.facts(now)));
        mark("none", &p, 0);
        at = 1000;
        p.ask_start(at);
        mark("ask", &p, at);
        at = 1100;
        p.stage_change("requesting", at);
        mark("requesting", &p, at);
        at = 1200;
        p.stage_change(MODEL_THINKING_STAGE, at);
        mark("thinking", &p, at);
        at = 1300;
        p.stream_delta(StreamKind::Transport, at);
        mark("transport", &p, at);
        at = 1400;
        p.stream_delta(StreamKind::Keepalive, at);
        mark("keepalive-before-semantic", &p, at);
        at = 1500;
        p.stream_delta(StreamKind::Reasoning, at);
        mark("reasoning", &p, at);
        at = 1550;
        p.stream_delta(StreamKind::Keepalive, at);
        mark("keepalive-after", &p, at);
        at = 1600;
        p.stream_delta(StreamKind::Text, at);
        mark("text", &p, at);
        at = 1650;
        p.stream_delta(StreamKind::Semantic, at);
        mark("semantic", &p, at);
        at = 1700;
        p.tool_call(Some("read"), at);
        mark("tool", &p, at);
        at = 1800;
        p.approval_wait(true, at);
        mark("approval", &p, at);
        at = 1900;
        p.approval_wait(false, at);
        mark("approval-released", &p, at);
        at = 2000;
        p.stage_change("bogus", at);
        p.stage_change("requesting", at);
        mark("requesting-2", &p, at);
        at = 2100;
        p.stage_change(MODEL_THINKING_STAGE, at);
        mark("thinking-2", &p, at);
        at = 2200;
        p.empty_final();
        p.settle("done", at, true);
        mark("done-empty", &p, at);
        at = 2300;
        p.stream_delta(StreamKind::Text, at);
        mark("late-delta", &p, at);
        at = 3000;
        p.ask_start(at);
        p.stage_change("requesting", at);
        at = 3100;
        p.settle("error", at, false);
        mark("error", &p, at);
        let want = golden();
        assert_eq!(seen.len(), want.len());
        for (got, want) in seen.iter().zip(&want) {
            assert_eq!(got, want, "{}", want.0);
        }
    }

    #[test]
    fn a_running_tool_keeps_its_progress_stamp_fresh_without_a_timer() {
        let mut p = RunProgress::default();
        p.ask_start(1000);
        p.stage_change("requesting", 1000);
        p.tool_call(Some("shell"), 2000);
        assert_eq!(p.snapshot(2000 + 29_999).unwrap().last_progress_at, 2000);
        assert_eq!(p.snapshot(2000 + 95_000).unwrap().last_progress_at, 2000 + 90_000);
        assert_eq!(p.facts(2000 + 95_000).unwrap().last_progress_at, 2000 + 90_000);
        // A model event stops the heartbeat; the stamp is the event's.
        p.stream_delta(StreamKind::Text, 50_000);
        assert_eq!(p.snapshot(500_000).unwrap().last_progress_at, 50_000);
    }

    struct Quiet;
    impl WaitedJobs for Quiet {
        fn silence(&self, ids: &[String], _: i64) -> Option<ToolSilence> {
            Some(ToolSilence { task_id: ids[0].clone(), silent_ms: 700_000, hung: true })
        }
    }

    #[test]
    fn tool_silence_is_read_only_while_the_turn_waits_on_a_task() {
        let mut p = RunProgress::default();
        p.ask_start(1000);
        p.tool_call(Some("task"), 1100);
        assert!(p.live(2000, &Quiet).tool_silence.is_none());
        p.task_wait(true, Some("task-1"));
        let live = p.live(2000, &Quiet);
        assert_eq!(live.tool_silence.unwrap().task_id, "task-1");
        assert_eq!(live.runtime_stage.as_deref(), Some("tool_running"));
        assert_eq!(live.policy, None);
        p.task_wait(false, Some("task-1"));
        assert!(p.live(2000, &Quiet).tool_silence.is_none());
        p.task_wait(true, Some("task-2"));
        p.settle("done", 3000, false);
        assert!(p.live(3000, &Quiet).tool_silence.is_none(), "a settled turn waits on nothing");
        assert!(RunProgress::default().live(0, &NoJobs).snapshot.is_none());
    }

    #[test]
    fn the_publisher_stamps_the_watch_value_once_per_marker() {
        struct Fixed(std::sync::atomic::AtomicI64);
        impl Clock for Fixed {
            fn now_ms(&self) -> i64 {
                self.0.load(std::sync::atomic::Ordering::SeqCst)
            }
        }
        let (tx, rx) = watch::channel(RunProgress::default());
        let clock = Arc::new(Fixed(std::sync::atomic::AtomicI64::new(500)));
        let publisher = ProgressPublisher::new(tx, clock);
        publisher.ask_start();
        publisher.stage("requesting");
        let seen = rx.borrow().snapshot(500).unwrap();
        assert_eq!((seen.ask_started_at, seen.model_request_started_at), (500, 500));
        assert_eq!(rx.borrow().stage().as_deref(), Some("requesting"));
    }
}

