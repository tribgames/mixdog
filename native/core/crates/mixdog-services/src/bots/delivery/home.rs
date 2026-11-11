//! The delivery of rows into agent home threads (`createAgentHomeDelivery` of
//! agent-home-delivery.mjs): the durable intake, the one drainer per home that posts a home's queue
//! once its thread is idle, the rows posted right before a turn starts, and the bookkeeping a
//! restart recovers. The relay of posted task results is in `relay`.
//!
//! Delivery is durable. A finished run is first ENQUEUED in the persisted queue, keyed by its run
//! id, so a retried enqueue adds nothing and a crash between posting and dequeuing never posts
//! twice (the posted message id derives from the run id). Posting never starts a turn.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use mixdog_core_base::rooms::ids::{agent_id_of_home_session, is_room_thread_session_id, room_id_of_session, room_member_of_session};
use mixdog_js::utf16_len;
use serde_json::{Map, Value, json};
use tokio::sync::{Semaphore, watch};

use super::env::{DeliveryConfig, HomeAgent, HomeDirectory, HomeThreads, LiveSlot, Presence, RetryTimer, RoomRelay, ThreadSnapshot};
use super::queue::{AddOptions, RoutineResultQueue, WatchError, answer_key};
use super::rows::{
    QueuedRow, bounded_reply, delivered_row, js_str, message_id_of, posted_message, routine_omitted_message, routine_result_notice,
    routine_run_notice, routine_summary, str_of, truthy, wakes_agent,
};
use crate::bots::host::{AnnouncedRun, DeliveryItem};
use crate::bots::ids::{MIXY_AGENT_ID, agent_home_session_id, schedule_owner_agent_id};
use crate::bots::routine::RoutineKind;
use crate::scheduler::Clock;

/// Task report statuses that post a row and wake nobody.
const QUIET_TASK_STATUSES: [&str; 3] = ["started", "blocked", "working"];

/// A coding task session's report into the home of the agent that created it (`report` of
/// `enqueueTask`).
#[derive(Debug, Clone, Default)]
pub struct TaskReport {
    pub run_id: String,
    pub task_session_id: String,
    pub title: String,
    pub status: String,
    pub text: String,
    /// `session`: any session other than a task session the agent created.
    pub target: Option<String>,
    pub files: Vec<Value>,
    pub omitted: f64,
    pub hop: f64,
    /// The send this report ends.
    pub watch_id: String,
    /// Every send this one turn answered; `watch_id` is the first of them.
    pub watch_ids: Vec<String>,
    /// The progress update that carried this final report's answer, if one did.
    pub progress_run_id: String,
    /// The session the work was sent from (a room member's own work reports to its member session).
    pub from: String,
    /// A progress update moves its send's watch mark to the turn it carries.
    pub progress_watch_id: String,
    pub answer_id: String,
}

/// The queued item of one task report (`taskReportItem`).
fn task_report_item(report: &TaskReport, now: i64) -> Value {
    let (reply_text, reply_chars) = bounded_reply(&report.text);
    let mut item = Map::new();
    item.insert("runId".into(), json!(report.run_id));
    item.insert("kind".into(), json!("agent-task"));
    item.insert("taskSessionId".into(), json!(report.task_session_id));
    item.insert("title".into(), json!(report.title));
    item.insert("status".into(), json!(report.status));
    // The UI row's one line comes from the whole reply, not its bounded part.
    item.insert("summary".into(), json!(routine_summary(&report.text)));
    if reply_chars > utf16_len(&reply_text) {
        item.insert("textChars".into(), json!(reply_chars));
    }
    item.insert("text".into(), json!(reply_text));
    if report.target.as_deref() == Some("session") {
        item.insert("target".into(), json!("session"));
    }
    if !report.watch_id.is_empty() {
        item.insert("sendId".into(), json!(report.watch_id));
    }
    if report.watch_ids.len() > 1 {
        item.insert("sendIds".into(), json!(report.watch_ids));
    }
    if !report.files.is_empty() {
        item.insert("files".into(), Value::Array(report.files.clone()));
        if report.omitted > 0.0 {
            item.insert("omitted".into(), mixdog_js::json_number(report.omitted));
        }
    }
    if !report.progress_run_id.is_empty() {
        item.insert("progressRunId".into(), json!(report.progress_run_id));
    }
    item.insert("roundTrip".into(), json!(!QUIET_TASK_STATUSES.contains(&report.status.as_str())));
    if report.hop > 0.0 {
        item.insert("hop".into(), mixdog_js::json_number(report.hop));
    }
    item.insert("at".into(), json!(now));
    Value::Object(item)
}

/// A pass that finished: the drainer signals it by dropping its sender.
pub struct Drained(watch::Receiver<()>);

impl Drained {
    /// Resolves once the pass (and the passes it was asked for meanwhile) is over.
    pub async fn wait(mut self) {
        while self.0.changed().await.is_ok() {}
    }
}

#[derive(Default)]
struct DrainBook {
    /// Home → the running pass.
    running: HashMap<String, watch::Receiver<()>>,
    /// Homes enqueued to while their pass ran.
    again: HashSet<String>,
}

/// Removes a home from the running passes when its task ends without having done so (a panic),
/// and signals the waiters by dropping its sender.
struct PassEnd {
    delivery: Arc<AgentHomeDelivery>,
    home: String,
    removed: bool,
    _signal: watch::Sender<()>,
}

impl Drop for PassEnd {
    fn drop(&mut self) {
        if !self.removed {
            lock(&self.delivery.book).running.remove(&self.home);
        }
    }
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The delivery of rows into agent home threads.
pub struct AgentHomeDelivery {
    pub(super) threads: Arc<dyn HomeThreads>,
    pub(super) directory: Arc<dyn HomeDirectory>,
    pub(super) live: Arc<LiveSlot>,
    pub(super) room_relay: Arc<dyn RoomRelay>,
    pub(super) queue: Arc<RoutineResultQueue>,
    pub(super) clock: Arc<dyn Clock>,
    retry: Arc<dyn RetryTimer>,
    pub(super) config: DeliveryConfig,
    /// Wake batch id → the relay turn this process runs.
    pub(super) relays: Mutex<HashMap<String, super::relay::RelayState>>,
    book: Mutex<DrainBook>,
    /// Homes with a retry timer armed.
    timers: Mutex<HashSet<String>>,
    /// Missing homes whose wait was logged.
    wait_logged: Mutex<HashSet<String>>,
    /// Held-request message ids shown live in a busy thread.
    held_shown: Mutex<HashSet<String>>,
    /// Per thread, one posting turn at a time.
    posting: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// The process's sensitive values: a task's or routine run's reply leaves its session with them as the marker.
    marks: std::sync::OnceLock<Arc<crate::memory::sensitive::SensitiveStore>>,
}

impl AgentHomeDelivery {
    #[allow(clippy::too_many_arguments)] // the Node options bag: one seam per field
    pub fn new(
        threads: Arc<dyn HomeThreads>,
        directory: Arc<dyn HomeDirectory>,
        live: Arc<LiveSlot>,
        room_relay: Arc<dyn RoomRelay>,
        queue: Arc<RoutineResultQueue>,
        clock: Arc<dyn Clock>,
        retry: Arc<dyn RetryTimer>,
        config: DeliveryConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            retry,
            threads,
            directory,
            live,
            room_relay,
            queue,
            clock,
            config,
            relays: Mutex::default(),
            book: Mutex::default(),
            timers: Mutex::default(),
            wait_logged: Mutex::default(),
            held_shown: Mutex::default(),
            posting: Mutex::default(),
            marks: std::sync::OnceLock::new(),
        })
    }

    /// Binds the process's sensitive values the replies queued from now on are redacted with; `false` when bound.
    pub fn redact_with(&self, marks: Arc<crate::memory::sensitive::SensitiveStore>) -> bool {
        self.marks.set(marks).is_ok()
    }

    /// `redactSensitiveText(sessionId, text)`.
    fn redacted(&self, session_id: &str, text: &str) -> String {
        self.marks.get().map_or_else(|| text.to_owned(), |marks| marks.redact_text(session_id, text))
    }

    pub(super) fn now_ms(&self) -> i64 {
        self.clock.now().timestamp_millis()
    }

    pub(super) fn log(&self, line: &str) {
        mixdog_rt::node_stderr!("mixdog routines: {line}");
    }

    /// Whether home thread `session_id` is busy: a turn in flight in this process, or the live
    /// surface says so.
    pub(super) fn busy(&self, session_id: &str) -> bool {
        self.threads.turn_in_flight(session_id) || self.live.get().is_some_and(|live| live.busy(session_id))
    }

    /// Shows `notice` live in `home` through the live surface; whether a window showed it
    /// (false, logged, when the surface failed).
    pub(super) async fn notice_live(&self, home: &str, notice: Value) -> bool {
        let Some(live) = self.live.get() else { return false };
        let mut notice = notice;
        if let Some(map) = notice.as_object_mut() {
            map.insert("posted".into(), json!(true));
        }
        match live.notice(home, notice).await {
            Ok(shown) => shown,
            Err(error) => {
                self.log(&format!("live notice in {home} failed: {error}"));
                false
            }
        }
    }

    /// Drains `home` again after `delay`, one retry timer per home armed at a time.
    pub(super) fn later(self: &Arc<Self>, home: &str, delay: Duration) {
        if !lock(&self.timers).insert(home.to_string()) {
            return;
        }
        let this = Arc::clone(self);
        let home = home.to_string();
        self.retry.arm(
            delay,
            Box::new(move || {
                lock(&this.timers).remove(&home);
                drop(this.drain(&home));
            }),
        );
    }

    /// Runs `work` as the thread's posting turn: push queued rows, save the thread, dequeue them,
    /// and a final report's check whether its answer already went out as a progress update. No
    /// pass ever dequeues rows another pushed but has not saved yet.
    pub(super) async fn posting_for<T>(&self, home: &str, work: impl Future<Output = T>) -> T {
        let gate = Arc::clone(lock(&self.posting).entry(home.to_string()).or_insert_with(|| Arc::new(Semaphore::new(1))));
        // The gate is never closed, so a refusal cannot happen; the work runs either way.
        let permit = gate.acquire().await.ok();
        let out = work.await;
        drop(permit);
        let mut gates = lock(&self.posting);
        // The map's and this call's hold are the only ones left: nobody waits on it.
        if Arc::strong_count(&gate) == 2 {
            gates.remove(home);
        }
        out
    }

    /// Whether progress row `run_id`, or another carrying the same answer, is in thread `home`.
    async fn posted_in(&self, home: &str, run_id: &str) -> Result<bool, String> {
        let Some(thread) = self.threads.load(home).await? else { return Ok(false) };
        let key = answer_key(run_id);
        let own = message_id_of(run_id);
        Ok(thread.messages.iter().any(|message| {
            let id = str_of(message.pointer("/meta/transcript/messageId"));
            id == own || (!key.is_empty() && answer_key(id) == key)
        }))
    }

    // --- intake ---

    /// Persists the result `item` of a schedule or webhook `name` for its owner's home, then
    /// starts draining it. Resolves once it is queued.
    pub async fn enqueue(self: &Arc<Self>, owner_agent_id: &str, name: &str, item: &DeliveryItem) -> Result<String, String> {
        let home = agent_home_session_id(&schedule_owner_agent_id(Some(owner_agent_id))).unwrap_or_default();
        if item.run_id.is_empty() {
            return Err("routine result: runId required".into());
        }
        let mut row = Map::new();
        row.insert("runId".into(), json!(item.run_id));
        row.insert("kind".into(), json!(if item.kind == RoutineKind::Webhook { "webhook" } else { "schedule" }));
        row.insert("name".into(), json!(name));
        row.insert("ok".into(), json!(item.ok));
        let run_session = item.run_session_id.as_deref().unwrap_or_default();
        row.insert("text".into(), json!(routine_summary(&self.redacted(run_session, &item.text))));
        row.insert("runSessionId".into(), item.run_session_id.as_ref().filter(|s| !s.is_empty()).map_or(Value::Null, |s| json!(s)));
        if let Some(reason) = item.reason.as_ref().filter(|r| !r.is_empty()) {
            row.insert("reason".into(), json!(reason));
        }
        if item.paused == Some(true) {
            row.insert("paused".into(), json!(true));
        }
        row.insert("at".into(), json!(self.now_ms()));
        self.queue.add(&home, Value::Object(row), AddOptions::default()).await?;
        drop(self.drain(&home));
        Ok(home)
    }

    /// The home thread of `agent_id`, Mixy's when it has none.
    fn home_of(agent_id: &str) -> String {
        agent_home_session_id(agent_id).or_else(|| agent_home_session_id(MIXY_AGENT_ID)).unwrap_or_default()
    }

    /// Persists one held-request row (`held`: the held request's fields) for `agent_id`'s home
    /// thread, then starts draining it. Each status posts once.
    pub async fn enqueue_held(self: &Arc<Self>, agent_id: &str, held: Value) -> Result<String, String> {
        let home = Self::home_of(agent_id);
        let Some(id) = held.get("id").filter(|id| truthy(id)).map(mixdog_js::value_to_string) else { return Err("held request: id required".into()) };
        let status = held.get("status").filter(|s| truthy(s)).map_or_else(|| "pending".to_string(), mixdog_js::value_to_string);
        let item = json!({ "runId": format!("{id}_{status}"), "kind": "held-request", "held": held, "at": self.now_ms() });
        self.queue.add(&home, item, AddOptions::default()).await?;
        drop(self.drain(&home));
        Ok(home)
    }

    /// Persists one report of a coding task session `agent_id` created for its home thread, then
    /// starts draining it. `started` and `blocked` only post a line; a turn's end also wakes the
    /// agent.
    pub async fn enqueue_task(self: &Arc<Self>, agent_id: &str, report: &TaskReport) -> Result<String, String> {
        let home = Self::home_of(agent_id);
        if report.run_id.is_empty() || report.task_session_id.is_empty() {
            return Err("task report: runId and taskSessionId required".into());
        }
        let report = &TaskReport { text: self.redacted(&report.task_session_id, &report.text), ..report.clone() };
        let item = task_report_item(report, self.now_ms());
        let mut unwatch: Vec<String> = Vec::new();
        for id in std::iter::once(&report.watch_id).chain(report.watch_ids.iter()) {
            if !id.is_empty() && !unwatch.contains(id) {
                unwatch.push(id.clone());
            }
        }
        // A room member's own work reports to its member session, never its home.
        let target = if room_member_of_session(&report.from).is_some_and(|member| member.agent_id == agent_id) { report.from.clone() } else { home };
        if report.progress_run_id.is_empty() {
            // A progress update moves its send's watch mark to the turn it carries, in the same
            // write: a restart never reports it again.
            let progressed = (!report.progress_watch_id.is_empty()).then(|| (report.progress_watch_id.clone(), report.answer_id.clone()));
            self.queue.add(&target, item, AddOptions { unwatch, progress_posted: false, progressed }).await?;
        } else {
            // Whether its answer already went out as that progress update is decided in the
            // thread's posting turn, against the thread itself: a row being posted (or posted
            // before a crash, not dequeued yet) counts as posted, never as still queued.
            let add = async {
                let posted = self.posted_in(&target, &report.progress_run_id).await?;
                self.queue.add(&target, item, AddOptions { unwatch, progress_posted: posted, progressed: None }).await
            };
            self.posting_for(&target, add).await?;
        }
        drop(self.drain(&target));
        Ok(target)
    }

    /// Persists `text`, the agent's own reply from turn `run_id` it ran outside its thread, for
    /// `agent_id`'s home thread, then starts draining it. It posts once, as the agent's message; no
    /// turn follows.
    pub async fn enqueue_message(self: &Arc<Self>, agent_id: &str, run_id: &str, text: &str) -> Result<String, String> {
        let home = Self::home_of(agent_id);
        if run_id.is_empty() || mixdog_js::js_trim(text).is_empty() {
            return Err("agent message: runId and text required".into());
        }
        let item = json!({ "runId": run_id, "kind": "agent-message", "text": mixdog_js::js_trim(text), "at": self.now_ms() });
        self.queue.add(&home, item, AddOptions::default()).await?;
        drop(self.drain(&home));
        Ok(home)
    }

    // --- bookkeeping ---

    async fn home_deleted(&self, home: &str) -> bool {
        // A bookkept home proven deleted: a bot's home whose definition is gone, or a room thread
        // whose room is. Never Mixy's home, never on an unknown answer.
        if let Some(agent_id) = agent_id_of_home_session(home) {
            return agent_id != MIXY_AGENT_ID && self.directory.agent_presence(&agent_id).await == Presence::Deleted;
        }
        let room_id = room_id_of_session(home).or_else(|| room_member_of_session(home).map(|member| member.room_id)).unwrap_or_default();
        !room_id.is_empty() && self.directory.room_presence(&room_id).await == Presence::Deleted
    }

    /// Retires the bookkeeping of deleted homes (and stale round counts).
    async fn prune(&self) -> Result<(), String> {
        let mut gone = Vec::new();
        for home in self.queue.bookkept_homes().await? {
            if self.home_deleted(&home).await {
                gone.push(home);
            }
        }
        self.queue.prune(gone).await
    }

    /// Stores `watch`; a home at its watch cap first gives up its oldest watches whose target
    /// sessions are proven deleted, and refuses the watch (so the send claims no report) when that
    /// frees too few.
    pub async fn watch_task(&self, watch: Value) -> Result<(), WatchError> {
        let stored = self.queue.watches().await.map_err(WatchError::Failed)?;
        let own: Vec<&Value> = stored
            .iter()
            .filter(|kept| truthy(kept) && kept.get("homeSessionId") == watch.get("homeSessionId") && kept.get("runId") != watch.get("runId"))
            .collect();
        let over = (own.len() + 1).saturating_sub(self.queue.watch_cap());
        let mut drop_ids: Vec<String> = Vec::new();
        for kept in own {
            if drop_ids.len() >= over {
                break;
            }
            if self.threads.session_deleted(str_of(kept.get("taskSessionId"))).await {
                drop_ids.push(str_of(kept.get("runId")).to_string());
            }
        }
        if !drop_ids.is_empty() {
            self.log(&format!("{} is at its watch cap: dropped {} watch(es) of deleted sessions", str_of(watch.get("homeSessionId")), drop_ids.len()));
        }
        self.queue.watch(watch, drop_ids).await
    }

    /// Daemon start: retires stale bookkeeping and drains every queue an earlier process left.
    /// The homes it drains.
    pub async fn recover(self: &Arc<Self>) -> Result<Vec<String>, String> {
        if let Err(error) = self.prune().await {
            self.log(&format!("pruning the routine results failed: {error}"));
        }
        // The stored watches name the hand-offs an earlier process left open: reading them notes
        // each one now, so a target that asks again after the restart reaches the chat that
        // handed it the work.
        if let Err(error) = self.queue.watches().await {
            self.log(&format!("reading the report watches failed: {error}"));
        }
        let homes = self.queue.pending_homes().await?;
        for home in &homes {
            drop(self.drain(home));
        }
        Ok(homes)
    }

    pub async fn unwatch_task(&self, run_id: &str) -> Result<(), String> {
        self.queue.unwatch(run_id).await
    }

    pub async fn follow_task(&self, run_id: &str, submission_id: &str) -> Result<(), String> {
        self.queue.follow_watch(run_id, submission_id).await
    }

    pub async fn task_watches(&self) -> Result<Vec<Value>, String> {
        self.queue.watches().await
    }

    pub async fn own_task(&self, work: Value) -> Result<(), String> {
        self.queue.own(work).await
    }

    pub async fn disown_task(&self, run_ids: Vec<String>) -> Result<(), String> {
        self.queue.disown(run_ids).await
    }

    pub async fn owned_tasks(&self) -> Result<Vec<Value>, String> {
        self.queue.owned().await
    }

    /// A user's own message in `home`: its round trips with every target restart.
    pub async fn reset_rounds(&self, home: &str) -> Result<(), String> {
        self.queue.reset_rounds(home).await
    }

    /// Shows a run's live-only row (`running`, or a result whose delivery failed) in the owner's
    /// home when it is open and idle. Nothing is stored and no turn or unread mark follows; the
    /// posted result (same message id) replaces it. False when no window shows it.
    pub async fn announce(&self, owner_agent_id: &str, name: &str, run: &AnnouncedRun) -> bool {
        if self.live.get().is_none() {
            return false;
        }
        let home = agent_home_session_id(&schedule_owner_agent_id(Some(owner_agent_id))).unwrap_or_default();
        if run.item.run_id.is_empty() || self.busy(&home) {
            return false;
        }
        let kind = if run.item.kind == RoutineKind::Webhook { "webhook" } else { "schedule" };
        let notice = routine_run_notice(kind, name, &run.item.run_id, run.state, run.item.ok, run.item.run_session_id.as_deref(), &message_id_of(&run.item.run_id));
        self.notice_live(&home, notice).await
    }

    // --- posting ---

    /// Shows the held requests of `items` live in a busy thread. A held request waits on the user,
    /// possibly raised by the very turn that keeps its thread busy: shown at once; the stored row
    /// (same message id) replaces it once the thread is idle.
    async fn show_held_live(&self, home: &str, items: &[Value]) {
        let now = self.now_ms();
        for item in items.iter().filter(|item| str_of(item.get("kind")) == "held-request") {
            let message_id = message_id_of(&run_id_of(item));
            if !lock(&self.held_shown).insert(message_id.clone()) {
                continue;
            }
            let mut notice = delivered_row(item, &message_id, now).notice;
            if let Some(map) = notice.as_object_mut() {
                map.insert("messageId".into(), json!(message_id));
                if let Some(at) = item.get("at") {
                    map.insert("at".into(), at.clone());
                }
            }
            self.notice_live(home, notice).await;
        }
    }

    /// Appends to `thread` the omission notice and the queued `items` not posted before, stores it
    /// and shows the new rows live. The run ids owed a wake (every dequeued task result, posted
    /// now or before).
    async fn post_rows(&self, home: &str, thread: &ThreadSnapshot, items: &[Value], omitted: Option<&Value>) -> Result<Vec<String>, String> {
        let now = self.now_ms();
        let posted: HashSet<&str> = thread.messages.iter().filter_map(|message| message.pointer("/meta/transcript/messageId").and_then(Value::as_str)).filter(|id| !id.is_empty()).collect();
        let mut fresh: Vec<(Value, Value)> = Vec::new();
        if let Some(omitted) = omitted {
            let omitted_id = message_id_of(&mixdog_js::value_to_string(omitted.get("id").unwrap_or(&Value::Null)));
            if !posted.contains(omitted_id.as_str()) {
                let message = posted_message(&routine_omitted_message(omitted.get("count").unwrap_or(&Value::Null), &omitted_id, now));
                let notice = routine_result_notice(&message);
                fresh.push((message, notice));
            }
        }
        let mut to_wake = Vec::new();
        for item in items {
            let run_id = run_id_of(item);
            let message_id = message_id_of(&run_id);
            let QueuedRow { message, notice, wake } = delivered_row(item, &message_id, now);
            if wake {
                to_wake.push(run_id);
            }
            if posted.contains(message_id.as_str()) {
                continue;
            }
            fresh.push((message, notice));
        }
        {
            let mut shown = lock(&self.held_shown);
            for item in items {
                shown.remove(&message_id_of(&run_id_of(item)));
            }
        }
        // The caller dequeues `items` (and `omitted`) next: the thread holding them is stored
        // first, also when an earlier pass pushed them but its store failed.
        if !items.is_empty() || omitted.is_some() {
            let touched = (!fresh.is_empty()).then_some(now);
            let rows = fresh.iter().map(|(message, _)| message.clone()).collect();
            self.threads.append(home, rows, touched).await?;
        }
        for (message, notice) in fresh {
            let mut notice = notice;
            if let Some(map) = notice.as_object_mut() {
                let transcript = message.pointer("/meta/transcript");
                map.insert("messageId".into(), transcript.and_then(|t| t.get("messageId")).cloned().unwrap_or(Value::Null));
                if let Some(at) = transcript.and_then(|t| t.get("at")) {
                    map.insert("at".into(), at.clone());
                }
            }
            self.notice_live(home, notice).await;
        }
        Ok(to_wake)
    }

    /// Right before a turn of thread `home` takes its prompt (whatever started it: the user, a
    /// routine, a wake): posts its queued rows that wake nobody — progress updates of the sessions
    /// its agent handed work to, start and wait lines, held requests, routine results — in queue
    /// order, so the turn reads them before its prompt. Rows that wake the agent stay for the drain
    /// after the turn. A failure is logged; the turn goes on and the drain posts the rows later.
    pub async fn post_before_turn(&self, home: &str) {
        if let Err(error) = self.posting_for(home, self.post_before(home)).await {
            self.log(&format!("posting the rows owed before a turn of {home} failed: {error}"));
        }
    }

    async fn post_before(&self, home: &str) -> Result<(), String> {
        let items: Vec<Value> = self.queue.items(home).await?.into_iter().filter(|item| !wakes_agent(item)).collect();
        let omitted = self.queue.omitted(home).await?;
        if items.is_empty() && omitted.is_none() {
            return Ok(());
        }
        let Some(thread) = self.threads.load(home).await?.filter(|thread| !thread.closed) else { return Ok(()) };
        self.post_rows(home, &thread, &items, omitted.as_ref()).await?;
        self.queue.remove(home, run_ids_of(&items), omitted, Vec::new()).await?;
        Ok(())
    }

    /// The session turn prelude of the daemon: before a turn of an agent's home thread or a room
    /// member session starts, its queued rows that wake nobody post first. Nothing for any other
    /// session.
    pub async fn post_before_agent_turn(&self, session_id: &str) {
        if agent_id_of_home_session(session_id).is_some() || room_member_of_session(session_id).is_some() {
            self.post_before_turn(session_id).await;
        }
    }

    // --- the drain ---

    /// The single drainer of `home`; a call during a pass runs one more pass.
    pub fn drain(self: &Arc<Self>, home: &str) -> Drained {
        let (signal, done) = {
            let mut book = lock(&self.book);
            if let Some(running) = book.running.get(home) {
                let done = running.clone();
                book.again.insert(home.to_string());
                return Drained(done);
            }
            let (signal, done) = watch::channel(());
            book.running.insert(home.to_string(), done.clone());
            (signal, done)
        };
        let this = Arc::clone(self);
        let home = home.to_string();
        tokio::spawn(async move {
            let mut end = PassEnd { delivery: Arc::clone(&this), home: home.clone(), removed: false, _signal: signal };
            loop {
                lock(&this.book).again.remove(&home);
                let failed = this.drain_once(&home).await.err();
                if let Some(error) = &failed {
                    this.log(&format!("delivery into {home} failed, retrying: {error}"));
                    this.later(&home, this.config.busy_retry);
                }
                // The last look at `again` and leaving the running passes are one step, so a call
                // that finds the pass running is always served by one more.
                let mut book = lock(&this.book);
                if failed.is_some() || !book.again.contains(&home) {
                    book.running.remove(&home);
                    end.removed = true;
                    break;
                }
            }
        });
        Drained(done)
    }

    /// Posts every queued result of `home` if its thread is idle, in its posting turn, then wakes
    /// the agent for what it owes; else retries later. The wake runs outside the posting turn: the
    /// turn it starts posts first (`post_before_turn`).
    async fn drain_once(self: &Arc<Self>, home: &str) -> Result<(), String> {
        if self.posting_for(home, self.post_idle(home)).await? {
            self.wake_owed(home).await?;
        }
        Ok(())
    }

    /// Dequeues every queued item (and the omission) of `home` unposted, and its wake obligations.
    async fn drop_queued(&self, home: &str, items: &[Value], omitted: Option<Value>) -> Result<(), String> {
        self.queue.remove(home, run_ids_of(items), omitted, Vec::new()).await?;
        self.queue.drop_wakes(home).await
    }

    /// Mixy's heartbeat reports queued for her home while she does not exist are dropped, never
    /// posted once she is created; so is the omission notice when nothing else waits. What is left
    /// to post.
    async fn drop_heartbeat_reports(&self, home: &str, items: Vec<Value>, omitted: Option<Value>) -> Result<(Vec<Value>, Option<Value>), String> {
        let (reports, kept): (Vec<Value>, Vec<Value>) = items.into_iter().partition(is_heartbeat_report);
        let retired = if kept.is_empty() { omitted.clone() } else { None };
        self.log(&format!("{} heartbeat report(s) for {home} are dropped: Mixy was never created", reports.len()));
        self.queue.remove(home, run_ids_of(&reports), retired.clone(), Vec::new()).await?;
        Ok((kept, if retired.is_some() { None } else { omitted }))
    }

    /// `drainOnce`'s posting: whether it posted to the thread; false when nothing is owed or the
    /// pass ends here (moved, busy, missing, dropped).
    async fn post_idle(self: &Arc<Self>, home: &str) -> Result<bool, String> {
        let mut items = self.queue.items(home).await?;
        let mut omitted = self.queue.omitted(home).await?;
        let owed = self.queue.wakes(home).await?.owes_wake();
        if items.is_empty() && omitted.is_none() && !owed {
            return Ok(false);
        }
        if room_id_of_session(home).is_some() {
            // A room log's queued rows: task reports go to member sessions now, so what an earlier
            // version left under the log's id is dropped, never posted.
            self.log(&format!("{} legacy task report(s) queued for the room log {home} are dropped", items.len()));
            self.drop_queued(home, &items, omitted).await?;
            return Ok(false);
        }
        let mixy_home = agent_home_session_id(MIXY_AGENT_ID).unwrap_or_default();
        if home == mixy_home && items.iter().any(is_heartbeat_report) && !self.directory.mixy_exists().await {
            (items, omitted) = self.drop_heartbeat_reports(home, items, omitted).await?;
            if items.is_empty() && omitted.is_none() && !owed {
                return Ok(false);
            }
        }
        let agent_id = agent_id_of_home_session(home);
        if let Some(agent_id) = agent_id.as_deref().filter(|id| *id != MIXY_AGENT_ID)
            && self.directory.agent_presence(agent_id).await == Presence::Deleted
        {
            // The owner is gone (its home archived): Mixy, the default owner, gets them.
            self.log(&format!("{} result(s) of the deleted agent {agent_id} go to {mixy_home}", items.len()));
            self.queue.move_home(home, &mixy_home).await?;
            if owed {
                self.queue.drop_wakes(home).await?;
            }
            drop(self.drain(&mixy_home));
            return Ok(false);
        }
        if self.busy(home) {
            self.show_held_live(home, &items).await;
            self.later(home, self.config.busy_retry);
            return Ok(false);
        }
        let Some(thread) = self.threads.load(home).await?.filter(|thread| !thread.closed) else {
            // A room thread proven gone: its queued rows are dropped, never retried.
            if is_room_thread_session_id(home) && (self.home_deleted(home).await || self.threads.session_deleted(home).await) {
                self.log(&format!("{} task report(s) for the deleted {home} are dropped", items.len()));
                self.drop_queued(home, &items, omitted).await?;
                return Ok(false);
            }
            // A missing home of an agent that can never have one (no bot): its queued rows are
            // dropped with a log line, never retried.
            if let Some(agent_id) = agent_id.as_deref().filter(|id| *id != MIXY_AGENT_ID)
                && self.directory.home_agent(agent_id).await == HomeAgent::None
            {
                self.log(&format!("{} result(s) for {home} are dropped: {agent_id} is not a bot, so it has no chat", items.len()));
                self.drop_queued(home, &items, omitted).await?;
                return Ok(false);
            }
            // Kept (a bot, or an agent whose kind cannot be read): logged once per process.
            if lock(&self.wait_logged).insert(home.to_string()) {
                self.log(&format!("{} result(s) wait for the home thread {home}", items.len()));
            }
            self.later(home, self.config.missing_retry);
            return Ok(false);
        };
        let to_wake = self.post_rows(home, &thread, &items, omitted.as_ref()).await?;
        // Dequeuing and owing the wake are one write: no restart between posting and waking
        // loses the wake.
        let overflowed = self.queue.remove(home, run_ids_of(&items), omitted, to_wake).await?;
        if overflowed > 0 {
            self.log(&format!("{home} is at its wake cap: {overflowed} result(s) ride the next wake as a count"));
        }
        Ok(true)
    }
}

/// A heartbeat report: Mixy's own reply from a check turn (`agent-message` is its only sender).
fn is_heartbeat_report(item: &Value) -> bool {
    str_of(item.get("kind")) == "agent-message"
}

fn run_ids_of(items: &[Value]) -> Vec<String> {
    items.iter().map(run_id_of).collect()
}

/// `String(item.runId)`.
fn run_id_of(item: &Value) -> String {
    js_str(item.get("runId"))
}
