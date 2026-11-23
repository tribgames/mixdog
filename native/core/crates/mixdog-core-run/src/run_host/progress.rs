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
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Boundary;
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
const VALID_STAGES: [&str; 9] = ["connecting", "requesting", "streaming", "tool_running", "resource_wait", "idle", "error", "done", "cancelling"];

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
    /// The submission the send loop is in (`RunEvent::SubmissionStarted`), and within it the active attempt (`SendIdentity`'s attempt
    /// clock): its id and phase, `None` once it ended. Set only by the current submission's own boundaries.
    submission: u64,
    attempt: u64,
    phase: Option<AttemptPhase>,
    /// When the scheduled retry of the failed request runs; `0` once the next submission or attempt began.
    retry_at: i64,
    local_wait: Option<&'static str>,
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
        self.entry.as_ref().map(|e| e.local_wait.unwrap_or(&e.stage).to_owned())
    }

    /// `_evictTerminalSessionRuntime`: askSession drops a settled (`done` / `error`) entry once its turn has unwound, so a
    /// finished turn leaves no entry for status surfaces to read.
    pub fn evict_terminal(&mut self) {
        if self.entry.as_ref().is_some_and(|e| terminal(&e.stage)) {
            self.entry = None;
        }
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
        *e = Entry {
            stage: "connecting".to_owned(),
            ask_started_at: now,
            last_progress_at: now,
            approval_waits: e.approval_waits,
            last_keepalive_at: e.last_keepalive_at,
            ..Entry::default()
        };
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

    /// The send loop began a unit of provider work (`RunEvent::SubmissionStarted`): a logical request, a route's first work or one
    /// exchange with the provider, for every provider whether or not it goes through the driver. What an earlier submission owned is
    /// no longer current, so no attempt of it exempts the watchdog and none of its late boundaries is accepted; the new submission's
    /// own wait is timed from here, by the driven attempt it begins or, for a provider outside the driver, by the watchdog.
    pub fn submission_started(&mut self, id: u64, now: i64) {
        let Some(e) = self.entry.as_mut().filter(|e| e.live()) else { return };
        e.submission = id;
        e.attempt = 0;
        e.phase = None;
        e.retry_at = 0;
        e.local_wait = None;
        e.set_logical_request(now);
    }

    /// The failed request's retry was scheduled to run at `retry_at` (epoch ms): until then the turn waits on the retry
    /// schedule, which no watchdog reads as silence, and its status says when the retry runs.
    pub fn retry_scheduled(&mut self, retry_at: i64, now: i64) {
        let Some(e) = self.entry.as_mut().filter(|e| e.live()) else { return };
        e.retry_at = retry_at;
        e.phase = None;
        e.last_progress_at = now;
    }

    /// A boundary of an attempt's response, observed at `now` (`RunEvent::Boundary`). It counts only if it carries the current
    /// submission: the late event of an older one, its attempt's start included, changes nothing. An attempt's start gives it fresh
    /// state, and every later boundary moves the phase of that attempt only. The phase is the *active* attempt: a failed or ended
    /// attempt leaves none (the next wait begins when the next submission or attempt does). Transport, metadata and keepalives are
    /// not boundaries and never restart a deadline.
    pub fn boundary(&mut self, submission: u64, attempt: u64, boundary: Boundary, now: i64) {
        let Some(e) = self.entry.as_mut().filter(|e| e.live()) else { return };
        if e.submission != submission {
            return;
        }
        match boundary {
            Boundary::AttemptStarted => {
                e.attempt = attempt;
                e.retry_at = 0;
                e.local_wait = None;
                e.set_logical_request(now);
                e.phase = Some(AttemptPhase::Head);
            }
            _ if e.attempt != attempt || e.phase.is_none() => {}
            // Connecting and awaiting the head are one wait for this record: both are waits for transport.
            Boundary::Connected => {}
            Boundary::HeadReceived => e.phase = Some(AttemptPhase::Payload),
            Boundary::FirstProtocolPayload => e.phase = Some(AttemptPhase::FirstOutput),
            Boundary::FirstSemanticOutput => e.phase = Some(AttemptPhase::Idle),
            Boundary::AttemptFailed | Boundary::AttemptEnded => {
                e.phase = None;
                // The wait of the attempt that ended is over: a retry's back-off is not part of it.
                e.model_request_started_at = now;
            }
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
        e.local_wait = None;
        e.retry_at = 0;
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
        e.local_wait = None;
        e.retry_at = 0;
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
        let active = e.local_wait.is_none() && matches!(e.stage.as_str(), "connecting" | "requesting" | "streaming");
        let in_ask = |at: i64| at != 0 && (e.ask_started_at == 0 || at >= e.ask_started_at);
        Some(Snapshot {
            stage: self.stage(),
            last_progress_at: e.last_progress_at.max(Self::heartbeat_tick(e, now)),
            last_stream_delta_at: e.last_stream_delta_at,
            tool_started_at: e.tool_started_at,
            ask_started_at: e.ask_started_at,
            first_activity_at: e.first_semantic_at,
            model_request_started_at: e.model_request_started_at,
            attempt_phase: e.phase,
            retry_at: e.retry_at,
            last_keepalive_at: e.last_keepalive_at,
            last_visible_text_at: e.last_visible_text_at,
            // `awaitingModelResponse`: sent, and no transport since.
            awaiting_model_response: active && e.stage == "requesting" && e.request_sent_at > 0 && e.last_transport_at < e.request_sent_at,
            // With an attempt clock the phase says it; without one (a provider that published no boundary) the stamps do.
            waiting_for_transport: match e.phase {
                Some(phase) => active && matches!(phase, AttemptPhase::Connect | AttemptPhase::Head | AttemptPhase::Recovery),
                None => e.model_request_started_at != 0 && active && e.request_transport_at == 0,
            },
            waiting_for_first_semantic: match e.phase {
                Some(phase) => {
                    active
                        && matches!(
                            phase,
                            AttemptPhase::Connect | AttemptPhase::Head | AttemptPhase::Payload | AttemptPhase::FirstOutput | AttemptPhase::Recovery
                        )
                }
                None => e.model_request_started_at != 0 && active && e.request_first_semantic_at == 0,
            },
            has_first_semantic: in_ask(e.first_semantic_at),
            awaiting_user: e.approval_waits > 0,
            last_semantic_kind: e.last_semantic_kind,
            current_tool: e.last_tool_call.clone(),
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
            task_waiting: self.entry.as_ref().is_some_and(|e| e.task_waits > 0),
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

    pub fn boundary(&self, submission: u64, attempt: u64, boundary: Boundary) {
        self.apply(|p, now| p.boundary(submission, attempt, boundary, now));
    }

    pub fn submission_started(&self, id: u64) {
        self.apply(|p, now| p.submission_started(id, now));
    }

    pub fn retry_scheduled(&self, retry_at: i64) {
        self.apply(|p, now| p.retry_scheduled(retry_at, now));
    }

    pub fn local_wait(&self, phase: Option<&'static str>) {
        self.apply(|p, now| {
            if let Some(e) = p.entry.as_mut().filter(|e| e.live()) {
                e.local_wait = phase;
                e.last_progress_at = now;
            }
        });
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
            ("none", None, None),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: true,
                    waiting_for_first_semantic: true,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: true,
                    waiting_for_transport: true,
                    waiting_for_first_semantic: true,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: true,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: true,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 0,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Reasoning),
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Reasoning),
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Text),
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: true,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: true,
                    waiting_for_first_semantic: true,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: true,
                    waiting_for_transport: true,
                    waiting_for_first_semantic: true,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 1600,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: true,
                    awaiting_user: false,
                    last_semantic_kind: Some(SemanticKind::Tool),
                    current_tool: Some("read".to_owned()),
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
                    attempt_phase: None,
                    retry_at: 0,
                    last_keepalive_at: 1550,
                    last_visible_text_at: 0,
                    awaiting_model_response: false,
                    waiting_for_transport: false,
                    waiting_for_first_semantic: false,
                    has_first_semantic: false,
                    awaiting_user: false,
                    last_semantic_kind: None,
                    current_tool: None,
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

    /// What the run's watchdog sees of the send loop and its attempts: the boundaries published on the `SendIdentity`, observed at the
    /// fake time `at`, as the send future delivers them.
    fn deliver(p: &mut RunProgress, identity: &mixdog_core_api::domain::provider::SendIdentity, at: i64) {
        for (submission, attempt, boundary) in identity.take_published() {
            p.boundary(submission, attempt, boundary, at);
        }
    }

    /// The send loop begins a submission at `at`: the identity's and the run's record of it.
    fn submit(p: &mut RunProgress, identity: &mixdog_core_api::domain::provider::SendIdentity, at: i64) -> u64 {
        let id = identity.begin_submission();
        p.submission_started(id, at);
        id
    }

    fn agent_120() -> mixdog_agent::agent_tool::progress::WatchdogPolicy {
        mixdog_agent::agent_tool::progress::WatchdogPolicy { first_transport_ms: 120_000, first_semantic_ms: 120_000, idle_stale_ms: 120_000 }
    }

    fn watched() -> (RunProgress, mixdog_core_api::domain::provider::SendIdentity, mixdog_agent::agent_tool::progress::WatchdogPolicy) {
        let mut p = RunProgress::default();
        p.ask_start(0);
        p.stage_change("requesting", 0);
        // A Gemini-like provider: it declared a 285 s window, so the watchdog's first-transport deadline is that plus a tick.
        let policy = mixdog_agent::agent_tool::progress::WatchdogPolicy { first_transport_ms: 300_000, first_semantic_ms: 600_000, idle_stale_ms: 300_000 };
        (p, mixdog_core_api::domain::provider::SendIdentity::default(), policy)
    }

    fn stale(p: &RunProgress, now: i64, policy: &mixdog_agent::agent_tool::progress::WatchdogPolicy) -> Option<String> {
        mixdog_agent::agent_tool::progress::stale_report(&p.snapshot(now).unwrap(), now, policy)
    }

    /// A provider whose requests do not pass through the driver publishes no attempt: its waits are still timed from the
    /// request's start by the watchdog.
    #[test]
    fn a_provider_without_a_driven_attempt_keeps_the_request_start_deadlines() {
        let mut p = RunProgress::default();
        p.ask_start(1_000);
        p.stage_change("requesting", 1_000);
        let policy = mixdog_agent::agent_tool::progress::WatchdogPolicy { first_transport_ms: 300_000, first_semantic_ms: 600_000, idle_stale_ms: 300_000 };
        assert_eq!(stale(&p, 1_000 + 299_999, &policy), None);
        assert!(stale(&p, 1_000 + 300_001, &policy).is_some_and(|s| s.contains("first transport stale")));
    }

    /// A driven provider fails and the fallback runs outside the driver: the retirement exempts nothing, and the fallback's stall is
    /// timed from its own submission, whatever the failed attempt had used.
    #[test]
    fn a_stalled_fallback_outside_the_driver_is_supervised_from_its_own_submission() {
        use mixdog_core_api::domain::provider::Boundary;
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let attempt = identity.begin_attempt(Default::default(), false);
        deliver(&mut p, &identity, 1_000);
        attempt.observe(Boundary::AttemptFailed);
        deliver(&mut p, &identity, 100_000);
        assert_eq!(p.snapshot(100_000).unwrap().attempt_phase, None, "a retired attempt is no active one");
        assert_eq!(stale(&p, 100_000 + 119_999, &agent), None);
        assert!(stale(&p, 100_000 + 120_001, &agent).is_some_and(|s| s.contains("first transport stale")), "no exemption after retirement");
        // The route switches: a new submission that makes no attempt at all.
        submit(&mut p, &identity, 400_000);
        assert_eq!(stale(&p, 400_000 + 119_999, &agent), None);
        assert!(stale(&p, 400_000 + 120_001, &agent).is_some_and(|s| s.contains("first transport stale")), "timed from the new submission");
    }

    /// Retirement, then the preparation of the next exchange: no stale exemption until a driven attempt of the new submission begins.
    #[test]
    fn retirement_then_preparation_grants_no_exemption_before_the_next_driven_attempt() {
        use mixdog_core_api::domain::provider::Boundary;
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let first = identity.begin_attempt(Default::default(), false);
        first.observe(Boundary::AttemptFailed);
        deliver(&mut p, &identity, 50_000);
        submit(&mut p, &identity, 60_000);
        assert!(stale(&p, 60_000 + 120_001, &agent).is_some(), "preparing the next exchange is supervised");
        let _second = identity.begin_attempt(Default::default(), false);
        deliver(&mut p, &identity, 100_000);
        assert_eq!(stale(&p, 100_000 + 500_000, &agent), None, "the new attempt is live and exempt");
    }

    /// A new logical request clears what the previous one owned.
    #[test]
    fn a_new_logical_request_clears_ownership() {
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let _attempt = identity.begin_attempt(Default::default(), false);
        deliver(&mut p, &identity, 1_000);
        assert_eq!(stale(&p, 1_000 + 500_000, &agent), None);
        p.submission_started(mixdog_core_api::domain::provider::next_submission_id(), 600_000);
        assert_eq!(p.snapshot(600_000).unwrap().attempt_phase, None);
        assert!(stale(&p, 600_000 + 120_001, &agent).is_some(), "the old attempt exempts nothing of the new request");
    }

    /// The late start, output and end of an older submission change nothing: its start included.
    #[test]
    fn late_events_of_an_old_submission_change_nothing() {
        use mixdog_core_api::domain::provider::Boundary;
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let old = identity.begin_attempt(Default::default(), false);
        // The new submission begins before the old attempt's events were delivered.
        let newer = mixdog_core_api::domain::provider::next_submission_id();
        p.submission_started(newer, 2_000);
        deliver(&mut p, &identity, 3_000);
        assert_eq!(p.snapshot(3_000).unwrap().attempt_phase, None, "a late start restores nothing");
        old.observe(Boundary::FirstSemanticOutput);
        deliver(&mut p, &identity, 4_000);
        old.observe(Boundary::AttemptEnded);
        deliver(&mut p, &identity, 5_000);
        assert_eq!(p.snapshot(5_000).unwrap().attempt_phase, None, "late output and end change nothing");
        assert!(stale(&p, 2_000 + 120_001, &agent).is_some(), "the thresholds apply from the newer submission");
    }

    /// A live attempt of the current submission stays exempt, and ordinary `requesting` notifications do not reset it.
    #[test]
    fn a_live_attempt_stays_exempt_and_requesting_notifications_do_not_reset_it() {
        use mixdog_core_api::domain::provider::AttemptPhase;
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let _attempt = identity.begin_attempt(Default::default(), false);
        deliver(&mut p, &identity, 1_000);
        p.stage_change("requesting", 400_000);
        p.stage_change("requesting", 800_000);
        assert_eq!(p.snapshot(800_000).unwrap().attempt_phase, Some(AttemptPhase::Head));
        assert_eq!(stale(&p, 1_000 + 900_000, &agent), None);
    }

    /// A payload that carries output makes both transitions at once; a role-only one is a payload and not output.
    #[test]
    fn output_makes_both_transitions_and_a_role_only_payload_is_not_output() {
        use mixdog_core_api::domain::provider::{AttemptPhase, Boundary};
        let (mut p, identity, _) = watched();
        let attempt = identity.begin_attempt(Default::default(), false);
        attempt.observe(Boundary::FirstProtocolPayload);
        deliver(&mut p, &identity, 10_000);
        assert_eq!(p.snapshot(10_000).unwrap().attempt_phase, Some(AttemptPhase::FirstOutput));
        attempt.observe(Boundary::FirstSemanticOutput);
        deliver(&mut p, &identity, 20_000);
        assert_eq!(p.snapshot(20_000).unwrap().attempt_phase, Some(AttemptPhase::Idle));
        let (_, identity, _) = watched();
        let attempt = identity.begin_attempt(Default::default(), false);
        attempt.observe(Boundary::FirstSemanticOutput);
        let published: Vec<Boundary> = identity.take_boundaries().into_iter().map(|(_, b)| b).collect();
        assert_eq!(published, [Boundary::AttemptStarted, Boundary::HeadReceived, Boundary::FirstProtocolPayload, Boundary::FirstSemanticOutput]);
    }

    /// The late event of a replaced attempt changes nothing of its successor: not at the adapter's handle, not at the progress
    /// record.
    #[test]
    fn a_stale_attempts_events_move_nothing() {
        use mixdog_core_api::domain::provider::{AttemptPhase, Boundary};
        let (mut p, identity, _) = watched();
        let old = identity.begin_attempt(Default::default(), false);
        let new = identity.begin_attempt(Default::default(), false);
        deliver(&mut p, &identity, 5_000);
        old.observe(Boundary::FirstSemanticOutput);
        assert!(identity.take_boundaries().is_empty(), "a replaced attempt publishes nothing");
        // The record ignores an older id even when one reaches it.
        p.boundary(0, old.id(), Boundary::FirstSemanticOutput, 6_000);
        assert_eq!(p.snapshot(6_000).unwrap().attempt_phase, Some(AttemptPhase::Head));
        new.observe(Boundary::HeadReceived);
        deliver(&mut p, &identity, 7_000);
        assert_eq!(p.snapshot(7_000).unwrap().attempt_phase, Some(AttemptPhase::Payload));
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

    /// Staleness is inactivity of the response's content: content that keeps advancing keeps a run alive however long it
    /// lasts, and events that carry none never do.
    #[test]
    fn only_content_progress_keeps_a_stream_alive_and_the_status_names_its_absence() {
        use mixdog_agent::agent_tool::progress::{ProgressInput, WatchdogPolicy, progress_fields, stale_report};
        let policy = WatchdogPolicy { first_transport_ms: 0, first_semantic_ms: 0, idle_stale_ms: 300_000 };
        let mut p = RunProgress::default();
        p.ask_start(1000);
        p.stage_change("requesting", 1000);
        p.stage_change("streaming", 2000);
        // A large write: arguments advance every 10 s for 20 minutes, four times the idle budget.
        for beat in 0..120 {
            p.stream_delta(StreamKind::Tool, 10_000 + beat * 10_000);
        }
        let now = 10_000 + 119 * 10_000 + 5_000;
        assert_eq!(stale_report(&p.snapshot(now).unwrap(), now, &policy), None);
        // Then only keep-alives: no content, so the run goes stale once the budget (and the keep-alive allowance) is spent.
        let mut at = now;
        while at < now + 1_000_000 {
            at += 10_000;
            p.stream_delta(StreamKind::Keepalive, at);
        }
        let snapshot = p.snapshot(at).unwrap();
        assert!(stale_report(&snapshot, at, &policy).is_some_and(|s| s.contains("task stale")));
        let fields = progress_fields(&ProgressInput {
            now: at,
            snapshot: Some(&snapshot),
            runtime_stage: Some("streaming"),
            policy: Some(policy),
            ..ProgressInput::default()
        });
        assert!(fields.diagnostic.starts_with("stale: "), "{}", fields.diagnostic);
        assert!(fields.last_progress.contains("no new content"), "{}", fields.last_progress);
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

    /// A scheduled retry is the retry schedule's wait, not the provider's silence: no threshold cuts it, the status says when the
    /// retry runs, and the next submission times its own wait from its start.
    #[test]
    fn a_scheduled_retry_is_no_silence_and_the_status_says_when_it_runs() {
        use mixdog_agent::agent_tool::progress::{ProgressInput, progress_fields};
        use mixdog_core_api::domain::provider::Boundary;
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let attempt = identity.begin_attempt(Default::default(), false);
        attempt.observe(Boundary::AttemptFailed);
        deliver(&mut p, &identity, 2_000);
        p.retry_scheduled(302_000, 2_000);
        let now = 301_500;
        assert_eq!(stale(&p, now, &agent), None, "300 s of back-off is past every 120 s threshold and still no stall");
        let snapshot = p.snapshot(now).unwrap();
        assert_eq!(snapshot.retry_at, 302_000);
        let fields = progress_fields(&ProgressInput {
            now,
            snapshot: Some(&snapshot),
            runtime_stage: Some("requesting"),
            policy: Some(agent),
            ..ProgressInput::default()
        });
        assert_eq!((fields.last_progress.as_str(), fields.diagnostic.as_str()), ("model request failed; retrying in 1s", "provider retry scheduled in 1s"));
        submit(&mut p, &identity, 302_000);
        assert_eq!(p.snapshot(302_000).unwrap().retry_at, 0);
        assert!(stale(&p, 302_000 + 120_001, &agent).is_some(), "the retried request's own wait is supervised from its start");
    }

    /// A tool owns its time and a wait for execution capacity is the pool's: however long either is quiet, and with no heartbeat at
    /// all, neither is read as a silent model. The model's own silence still is.
    #[test]
    fn a_quiet_tool_or_capacity_wait_is_never_read_as_a_silent_model() {
        use mixdog_agent::agent_tool::progress::{WatchdogPolicy, stale_report};
        let policy = WatchdogPolicy { first_transport_ms: 0, first_semantic_ms: 0, idle_stale_ms: 60_000 };
        let mut p = RunProgress::default();
        p.ask_start(1_000);
        p.stage_change("tool_running", 2_000);
        let hour = 3_600_000;
        assert_eq!(stale_report(&p.snapshot(2_000 + hour).unwrap(), 2_000 + hour, &policy), None, "a quiet tool");
        p.stage_change("resource_wait", 10_000);
        assert_eq!(stale_report(&p.snapshot(10_000 + hour).unwrap(), 10_000 + hour, &policy), None, "a wait for a slot");
        p.stage_change("streaming", 20_000);
        assert!(stale_report(&p.snapshot(20_000 + 60_001).unwrap(), 20_000 + 60_001, &policy).is_some(), "a silent model");
    }

    /// A model wait is the driver's: whatever phase a live driven attempt of the current submission is in, however long it has run
    /// and whatever the agent's own thresholds say, the watchdog only observes it, and a recovery's total is no head allowance.
    #[test]
    fn the_watchdog_only_observes_a_live_attempt_of_the_current_submission_in_every_phase() {
        use mixdog_core_api::domain::provider::{Boundary, PhaseWindows};
        let secs285 = Some(std::time::Duration::from_secs(285));
        let windows = PhaseWindows { head: secs285, payload: secs285, recovery: secs285, ..PhaseWindows::default() };
        let agent = agent_120();
        let (mut p, identity, _) = watched();
        submit(&mut p, &identity, 1_000);
        let attempt = identity.begin_attempt(windows, false);
        deliver(&mut p, &identity, 1_000);
        assert_eq!(stale(&p, 1_000 + 200_000, &agent), None, "head");
        attempt.observe(Boundary::HeadReceived);
        deliver(&mut p, &identity, 250_000);
        assert_eq!(stale(&p, 250_000 + 200_000, &agent), None, "payload");
        attempt.observe(Boundary::FirstProtocolPayload);
        deliver(&mut p, &identity, 500_000);
        // Transport, keepalives and a tool-less chunk moving bytes are no progress and no deadline of this watchdog.
        for at in [700_000, 900_000] {
            p.stream_delta(StreamKind::Transport, at);
            p.stream_delta(StreamKind::Keepalive, at);
        }
        assert_eq!(stale(&p, 1_100_000, &agent), None, "first output");
        submit(&mut p, &identity, 1_600_000);
        let recovery = identity.begin_attempt(windows, true);
        deliver(&mut p, &identity, 1_600_000);
        assert_eq!(stale(&p, 1_600_000 + 200_000, &agent), None, "the recovery's generation total is no head allowance");
        recovery.observe(Boundary::AttemptEnded);
    }

    /// A Cursor think that streams only token counts reports semantic progress and stays alive past the idle budget; the
    /// service's 10 s heartbeat is transport health and never holds a run with nothing else.
    #[test]
    fn a_token_only_stretch_is_progress_and_a_heartbeat_only_stretch_is_not() {
        use mixdog_agent::agent_tool::progress::{WatchdogPolicy, stale_report};
        let policy = WatchdogPolicy { first_transport_ms: 0, first_semantic_ms: 0, idle_stale_ms: 315_000 };
        let stretch = |kind: StreamKind| {
            let mut p = RunProgress::default();
            p.ask_start(1_000);
            p.stage_change("requesting", 1_000);
            p.stream_delta(StreamKind::Reasoning, 2_000);
            let mut at = 2_000;
            while at < 2_000 + 900_000 {
                at += 10_000;
                p.stream_delta(kind, at);
            }
            stale_report(&p.snapshot(at).unwrap(), at, &policy)
        };
        assert_eq!(stretch(StreamKind::Semantic), None, "fifteen minutes of token deltas");
        assert!(stretch(StreamKind::Transport).is_some_and(|s| s.contains("task stale")), "fifteen minutes of heartbeats");
    }
}
