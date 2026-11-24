//! The run's transcript sink: ordered commits, drafts and their saves.

use super::*;

pub(super) type SinkState = (Arc<Mutex<Segments>>, Arc<Mutex<Observed>>);

pub(super) type SinkServices = (Arc<dyn Clock>, Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>);

/// What the interrupted request had produced that the transcript does not hold yet
/// (`createTurnInterruptionTracker`): the run's observer fills it, the sink empties it when an assistant message commits.
#[derive(Default)]
pub(super) struct Observed {
    pub(super) started: bool,
    pub(super) text: String,
    pub(super) reasoning: String,
    /// `markToolPhaseStarted`; a new send (`markProviderSendStarted`) puts it back.
    pub(super) tools: bool,
    pub(super) calls: Vec<mixdog_core_api::domain::provider::ToolCall>,
    /// Results that settled but were not committed in call order (`__earlyNotify`).
    pub(super) results: Vec<AgentMessage>,
    /// How much of the above the run's draft holds (`journalDelta`'s cursor): the lengths of `text`, `reasoning` and
    /// `calls`, the phase, and the early results not yet written.
    pub(super) drafted_text: usize,
    pub(super) drafted_reasoning: usize,
    pub(super) drafted_calls: usize,
    pub(super) drafted_tools: bool,
    pub(super) undrafted_results: Vec<Value>,
    /// The calls whose result the draft's file may hold and is to give up: each was run again
    /// (`RunObserver::early_result_replaced`).
    pub(super) undrafted_withdrawn: Vec<String>,
}

impl Observed {
    /// `markAssistantMessageCommitted`: the message holds what was drafted of it.
    pub(super) fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
        self.calls.clear();
        self.drafted_text = 0;
        self.drafted_reasoning = 0;
        self.drafted_calls = 0;
    }

    /// What the draft gained since its last write (a `draft` record's body, `RunDraft`), or `None`.
    pub(super) fn undrafted(&mut self) -> Option<Value> {
        let mut body = serde_json::Map::new();
        if self.text.len() > self.drafted_text {
            body.insert("text".into(), json!(self.text[self.drafted_text..]));
            self.drafted_text = self.text.len();
        }
        if self.reasoning.len() > self.drafted_reasoning {
            body.insert("reasoning".into(), json!(self.reasoning[self.drafted_reasoning..]));
            self.drafted_reasoning = self.reasoning.len();
        }
        if self.calls.len() > self.drafted_calls {
            let calls = row_of(&AgentMessage::assistant("", self.calls[self.drafted_calls..].to_vec()));
            body.insert("calls".into(), calls.get("toolCalls").cloned().unwrap_or_default());
            self.drafted_calls = self.calls.len();
        }
        if !self.undrafted_withdrawn.is_empty() {
            body.insert("withdrawn".into(), json!(std::mem::take(&mut self.undrafted_withdrawn)));
        }
        if !self.undrafted_results.is_empty() {
            body.insert("results".into(), Value::Array(std::mem::take(&mut self.undrafted_results)));
        }
        if self.tools != self.drafted_tools {
            body.insert("tools".into(), json!(self.tools));
            self.drafted_tools = self.tools;
        }
        (!body.is_empty()).then_some(Value::Object(body))
    }
}

pub(super) enum Job {
    /// A row, with its place among the run's shown reports.
    Commit(u64, ItemCommit, Option<RowPlace>),
    Compact(u64, mixdog_core_session::session::run::Compaction),
    /// A rewrite that is not a compaction: the model context restarts at these rows, with no divider.
    Rewound(u64, Vec<(ItemId, Value)>),
    Draft(u64, Value),
}

/// `TURN_CHECKPOINT_THROTTLE_MS` (`ask-turn-state.mjs:14`): streamed text is drafted at most this often; every other
/// change of the draft is written at once (`checkpoint.schedule(true)`).
pub(super) const DRAFT_THROTTLE: std::time::Duration = std::time::Duration::from_millis(150);

/// When the draft was last written, and whether a throttled write is armed.
#[derive(Default)]
pub(super) struct DraftClock {
    pub(super) last: Option<tokio::time::Instant>,
    pub(super) armed: bool,
}

/// `TranscriptSink` over the run's port: commits go to the actor in order on one task, which waits for no save (the actor
/// shows each as it takes it); their saves are told in the same order on another, which `durable` waits for. `Ticket(0)`
/// is the turn's input row, which the actor committed.
pub(super) struct PortSink {
    pub(super) jobs: Jobs,
    /// The last job the actor has taken.
    pub(super) accepted: watch::Receiver<u64>,
    /// The last job whose save has ended, every one before it too.
    pub(super) done: watch::Receiver<u64>,
    pub(super) port: RunPort,
    pub(super) rows: Arc<StoredRows>,
    pub(super) live: LiveTurnPublisher,
    /// The turn's messages, each the one copy the sink holds: the rows registered for it refer to it (`StoredRows::record_turn`).
    pub(super) turn: Mutex<Vec<Arc<AgentMessage>>>,
    /// The segments the shown assistant text belongs to, until its message commits.
    pub(super) streaming: Arc<Mutex<Segments>>,
    pub(super) iids: Mutex<HashMap<String, ItemId>>,
    pub(super) clock: Arc<dyn Clock>,
    pub(super) blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    /// A worker's turn hook (`onToolResult`): called with each tool result the turn gains.
    pub(super) on_tool_result: Option<Arc<ToolResultCallback>>,
    /// What the turn's input row says of the turn, which its assistant rows repeat; `None` for an input row
    /// without transcript metadata.
    pub(super) stamp: Option<TurnStamp>,
    /// The loop's counters, set by the host just before the turn's terminal reply commits
    /// (`appendAssistantTurnMessage` writes them on that message).
    pub(super) terminal: Mutex<Option<(u32, u64)>>,
    pub(super) applied: AppliedSkills,
    pub(super) drafted: Mutex<DraftClock>,
    /// The job of the last rewrite handed over (`replace`); 0 before any.
    pub(super) rewrite: AtomicU64,
    /// The model context the turn's messages follow, which a stop closes the turn on.
    pub(super) base: Mutex<Base>,
}

/// The model context ahead of the turn's latest messages: the history the turn began on, then the context its last rewrite
/// (`replace`) or reload of the stored history restarted at.
#[derive(Default)]
pub(super) struct Base {
    /// Each row with its item.
    pub(super) rows: Vec<(ItemId, HistoryRow)>,
    /// How many of the turn's messages ([`PortSink::turn`]) the rows already hold.
    pub(super) held: usize,
}

impl Base {
    /// The row of `row` the context holds.
    pub(super) fn body(row: &HistoryRow) -> Value {
        match row {
            HistoryRow::Stored(stored) => Value::Object(stored.to_map()),
            HistoryRow::Message(message) => row_of(message),
        }
    }
}

/// The run's jobs in order, and the draft they take from: what a draft takes from `observed`, and an assistant commit
/// empties of it, is numbered and queued while `observed` is held, so no draft of a message lands after the message's row.
pub(super) struct Jobs {
    /// `markAssistantMessageCommitted` empties it.
    pub(super) observed: Arc<Mutex<Observed>>,
    pub(super) seq: AtomicU64,
    pub(super) tx: mpsc::UnboundedSender<Job>,
    /// The run's shown reports, which each row takes its place among (`None`: a sink that shows nothing).
    pub(super) shown: Option<mpsc::UnboundedSender<Shown>>,
    /// Called once a draft's body is taken, before it is queued.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) taken: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Jobs {
    /// Queues what the draft gained since its last write.
    pub(super) fn draft(&self) {
        let mut observed = lock(&self.observed);
        if let Some(body) = observed.undrafted() {
            #[cfg(any(test, feature = "test-support"))]
            if let Some(taken) = lock(&self.taken).take() {
                taken();
            }
            self.queue(&mut observed, |n| Job::Draft(n, body));
        }
    }

    /// Queues a row of the run (an assistant message's ends its draft), after the seal of the turn's reply if any.
    pub(super) fn row(&self, assistant: bool, sealed: Option<Value>, item: ItemCommit) -> u64 {
        let mut observed = lock(&self.observed);
        if assistant {
            observed.message_committed();
        }
        if let Some(sealed) = sealed {
            self.queue(&mut observed, |n| Job::Draft(n, sealed));
        }
        // The rows and the shown reports reach the port on two tasks: the row takes its place among the reports here, after
        // every report the run produced before it ([`row_handover`]). A forwarder already gone drops the place at once.
        let place = self.shown.as_ref().map(|shown| {
            let (reached, place) = tokio::sync::oneshot::channel();
            let _ = shown.send(Shown::Row(reached));
            place
        });
        self.queue(&mut observed, |n| Job::Commit(n, item, place))
    }

    /// Numbers and queues one job; `_held` is the observed record, held by the caller.
    pub(super) fn queue(&self, _held: &mut Observed, job: impl FnOnce(u64) -> Job) -> u64 {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(job(n));
        n
    }
}

impl PortSink {
    pub(super) fn spawn(
        port: RunPort,
        rows: Arc<StoredRows>,
        live: LiveTurnPublisher,
        state: SinkState,
        services: SinkServices,
        outputs: (Option<Arc<ToolResultCallback>>, mpsc::UnboundedSender<Shown>),
        initial: (Option<TurnStamp>, AppliedSkills),
    ) -> Arc<Self> {
        let (on_tool_result, shown) = outputs;
        let (streaming, observed) = state;
        let (clock, blobs) = services;
        let (stamp, applied) = initial;
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let (accepted_tx, accepted) = watch::channel(0u64);
        let (done_tx, done) = watch::channel(0u64);
        let (saves, mut saving) = mpsc::unbounded_channel::<(u64, Result<Queued, RunError>, &'static str)>();
        let worker = port.clone();
        // A row held for its place past the run's cancel is handed over on a port whose send outlives the token: it would have
        // gone before the cancel had the forwarder not held it, and the cancelled run's flush waits for its save.
        let unheld = port.closing();
        // The actor takes each job in order and shows it at once; it orders the writes itself (`outbox.rs`), so nothing here
        // waits for one before handing on the next.
        drop(mixdog_rt::spawn(
            "run-commit",
            TaskClass::Work,
            turn_task(async move {
                while let Some(job) = turn_input(queue.recv()).await {
                    let (n, queued, failed) = match job {
                        Job::Commit(n, item, place) => {
                            let queued = match row_handover(place).await {
                                Handover::Reached(handed) => {
                                    let queued = worker.queue_item(item).await;
                                    let _ = handed.send(());
                                    queued
                                }
                                Handover::Unplaced => worker.queue_item(item).await,
                                Handover::Gone => unheld.queue_item(item).await,
                            };
                            (n, queued, "[session] message save failed")
                        }
                        Job::Compact(n, compaction) => (n, worker.queue_compacted(compaction).await, "[session] compaction save failed"),
                        Job::Rewound(n, replacement) => (n, worker.queue_context_rewound(replacement).await, "[session] context save failed"),
                        // Node reports a failed checkpoint write and goes on (`[turn-checkpoint] write failed`).
                        Job::Draft(n, body) => (n, worker.queue_draft(body).await, "[turn-checkpoint] write failed"),
                    };
                    accepted_tx.send_replace(n);
                    let _ = saves.send((n, queued, failed));
                }
            }),
        ));
        let teller = port.clone();
        drop(mixdog_rt::spawn(
            "run-commit-saves",
            TaskClass::Work,
            turn_task(async move {
                while let Some((n, queued, failed)) = turn_input(saving.recv()).await {
                    // Node logs a failed session save and goes on (`ask-turn-state.mjs:107`, `session-lifecycle.mjs:522`).
                    let saved = match queued {
                        Ok(queued) => teller.saved(queued).await,
                        Err(error) => Err(error),
                    };
                    if let Err(error) = saved {
                        tracing::warn!("{failed}: {error:?}");
                    }
                    done_tx.send_replace(n);
                }
            }),
        ));
        let jobs = Jobs {
            observed,
            seq: AtomicU64::new(0),
            tx: jobs,
            shown: Some(shown),
            #[cfg(any(test, feature = "test-support"))]
            taken: Mutex::default(),
        };
        Arc::new(Self {
            jobs,
            accepted,
            done,
            port,
            rows,
            live,
            turn: Mutex::new(Vec::new()),
            streaming,
            iids: Mutex::new(HashMap::new()),
            clock,
            blobs,
            on_tool_result,
            stamp,
            terminal: Mutex::new(None),
            applied,
            drafted: Mutex::new(DraftClock::default()),
            rewrite: AtomicU64::new(0),
            base: Mutex::default(),
        })
    }

    /// The model context restarts at `rows`, which hold every message the turn has committed so far.
    pub(super) fn restart(&self, rows: Vec<(ItemId, HistoryRow)>) {
        let held = lock(&self.turn).len();
        *lock(&self.base) = Base { rows, held };
    }

    /// The run's draft changed (`checkpoint.schedule`): written now when `now` (a boundary) or when the last write is
    /// older than [`DRAFT_THROTTLE`], else once that much time has passed.
    pub(super) fn draft(self: &Arc<Self>, now: bool) {
        let wait = {
            let mut clock = lock(&self.drafted);
            let at = tokio::time::Instant::now();
            match clock.last {
                Some(last) if !now && at < last + DRAFT_THROTTLE => {
                    if std::mem::replace(&mut clock.armed, true) {
                        return;
                    }
                    last + DRAFT_THROTTLE - at
                }
                _ => {
                    clock.last = Some(at);
                    drop(clock);
                    self.write_draft();
                    return;
                }
            }
        };
        let sink = self.clone();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(wait).await;
            {
                let mut clock = lock(&sink.drafted);
                clock.armed = false;
                clock.last = Some(tokio::time::Instant::now());
            }
            sink.write_draft();
        }));
    }

    /// Queues what the draft gained since its last write, in order with the run's rows.
    pub(super) fn write_draft(&self) {
        self.jobs.draft();
    }

    /// What Node's loop and turn commit write on an assistant row besides its content: its id, time and
    /// route (`attachAssistantTranscriptMetadata`, `persistedAssistantTranscriptMetadata`), the tool-call
    /// message's `createdAt`, and on the terminal reply the loop's counters and the turn's completion
    /// (`appendAssistantTurnMessage`, `attachAssistantTranscriptCompletion`).
    pub(super) fn stamp_assistant(&self, row: &mut Value, message: &AgentMessage, terminal: Option<(u32, u64)>) {
        let Some(stamp) = &self.stamp else { return };
        let Some(object) = row.as_object_mut() else { return };
        let now = self.clock.now_ms();
        if !message.tool_calls().is_empty() {
            object.insert("createdAt".into(), json!(now));
        }
        if let Some((iterations, tool_calls_total)) = terminal {
            object.insert("iterations".into(), json!(iterations));
            object.insert("toolCallsTotal".into(), json!(tool_calls_total));
        }
        let meta = object.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let transcript = meta.as_object_mut().expect("meta is an object").entry("transcript").or_insert_with(|| json!({}));
        if !transcript.is_object() {
            *transcript = json!({});
        }
        let transcript = transcript.as_object_mut().expect("transcript is an object");
        transcript.entry("messageId").or_insert_with(|| json!(self.message_id()));
        transcript.entry("at").or_insert_with(|| json!(now));
        for (key, value) in &stamp.carried {
            transcript.entry(key.clone()).or_insert_with(|| value.clone());
        }
        if terminal.is_some() && !mixdog_js::js_trim(&message.text()).is_empty() {
            let mut completion = json!({ "status": "done", "verb": stamp.verb, "elapsedMs": (now - stamp.started_at).max(0) });
            if let Some(checkpoint) = &stamp.checkpoint_id {
                completion["checkpointId"] = json!(checkpoint);
            }
            transcript.entry("completion").or_insert(completion);
        }
        // Node's key order: the tool-call message opens with `role, createdAt` (`buildToolCallAssistantMessage`), the
        // terminal reply puts its `meta` right after `content` (`appendAssistantTurnMessage`).
        let lead: &[&str] = if !message.tool_calls().is_empty() {
            &["role", "createdAt"]
        } else if terminal.is_some() {
            &["role", "content", "meta"]
        } else {
            &[]
        };
        if !lead.is_empty() {
            let mut ordered = serde_json::Map::new();
            for key in lead {
                if let Some(value) = object.shift_remove(*key) {
                    ordered.insert((*key).into(), value);
                }
            }
            ordered.append(object);
            *object = ordered;
        }
    }

    /// The input row and the context before it: known ids, and the turn's first live message.
    pub(super) fn seed(&self, input: &AgentMessage) {
        let mut turn = lock(&self.turn);
        turn.push(Arc::new(input.clone()));
        self.live.publish(&turn, &*self.rows);
    }

    pub(super) fn iid_of(&self, message: &AgentMessage) -> ItemId {
        match &message.message_id {
            Some(id) => lock(&self.iids).entry(id.clone()).or_insert_with(new_item_id).clone(),
            None => new_item_id(),
        }
    }

    /// Every queued commit is durable (or failed).
    pub(super) async fn flush(&self) {
        let last = self.jobs.seq.load(Ordering::SeqCst);
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= last).await;
    }
}

/// The compacted record's identities from the loop's report.
pub(super) fn dropped_of(dropped: &mixdog_agent::env::Dropped) -> mixdog_core_session::session::run::Dropped {
    mixdog_core_session::session::run::Dropped { message_ids: dropped.message_ids.clone(), call_ids: dropped.call_ids.clone() }
}

#[async_trait]
impl TranscriptSink for PortSink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        // A save writes the throttled draft first (the transcript snapshot hook's `flushNow`): a crash at the row's write
        // leaves what streamed of it.
        self.write_draft();
        let mut row = row_of(message);
        let mut terminal = None;
        if message.role() == Role::Assistant {
            terminal = lock(&self.terminal).take();
            self.stamp_assistant(&mut row, message, terminal);
        }
        // Node hides a row by what it is: a user row the transcript shows nothing for (a hook or
        // skill note, internal text) is not visible; a card or cancel line is written into its meta.
        // and the row that counts for prompt history carries its display text.
        let (row, visible, prompt) = if message.role() == Role::User {
            // The facts read the attachment store (paste line counts, offloaded prompt bodies): the
            // read runs on the store's lane and this task awaits its answer.
            let lane_row = row.clone();
            let read = with_blobs_if_read(&*self.blobs, move |blobs| {
                let mut classified = lane_row.clone();
                let facts = row_facts(&mut classified, &mut UserText::new(blobs));
                (classified, facts)
            })
            .await;
            // A read that never ran is an error of the commit, with the lane's reason: nothing is queued.
            let (row, facts) = read.map_err(CommitError::StoreUnavailable)?;
            let (visible, prompt) = facts.map_or((true, None), |facts| (facts.visible, facts.prompt));
            (row, visible, prompt)
        } else {
            (row, true, None)
        };
        // The segments the reply was shown as: its row names them, so the transcript shows the same rows, live and on reload.
        let shown = if message.role() == Role::Assistant { lock(&self.streaming).take() } else { None };
        let (shown, mut named) = match shown {
            Some((iid, named)) => (Some(iid), named),
            None => (None, serde_json::Map::new()),
        };
        // A reply that ends the turn is its own text (Node's final row is `content`): the updates shown ahead of a tool call
        // stay with that call's row, the ones ahead of the answer go as the answer lands.
        if message.message.tool_calls.is_empty() {
            named.swap_remove("shownText");
        }
        let mut row = row;
        with_shown(&mut row, named);
        let held = Arc::new(message.clone());
        self.rows.record_turn(held.clone(), row.clone());
        if message.role() == Role::Tool {
            // The authoritative result is in the transcript now: an early notice of it is no longer pending
            // (`recordToolResult` deletes it), and one the draft has not taken yet is not drafted behind its call's row.
            if let Some(id) = message.tool_call_id() {
                let mut observed = lock(&self.jobs.observed);
                observed.results.retain(|early| early.tool_call_id() != Some(id));
                observed.undrafted_results.retain(|early| early.get("toolCallId").and_then(Value::as_str) != Some(id));
            }
            if let Some(hook) = &self.on_tool_result {
                hook(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage { ui_diff: message.ui_diff.clone() });
            }
        }
        {
            let mut turn = lock(&self.turn);
            turn.push(held);
            self.live.publish_stored(&turn, &self.rows);
        }
        // The shown item is the message's item: a later rewrite of the context names it by this id.
        if let (Some(id), Some(iid)) = (&message.message_id, &shown) {
            lock(&self.iids).insert(id.clone(), iid.clone());
        }
        let role = match message.role() {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::Developer => "developer",
        };
        // The turn's final reply seals its draft first (`sealed` checkpoint), durable before the row is sent: a turn whose
        // reply row then fails to land is still recovered finished.
        let sealed = terminal.is_some().then(|| json!({ "sealed": row.clone() }));
        let item = ItemCommit { iid: shown.unwrap_or_else(|| self.iid_of(message)), role: Some(role.to_owned()), model: true, visible, body: row, prompt };
        Ok(Ticket(self.jobs.row(message.role() == Role::Assistant, sealed, item)))
    }

    fn replace(&self, messages: &[AgentMessage], rewrite: &mixdog_agent::env::Rewrite) {
        // The run's leading system messages are the header's prompt (`system_messages`, put before the stored rows by `drive`),
        // not context rows: the next turn's request carries one system set, as `adoptCompactedTranscript` leaves one.
        let mut base = Vec::new();
        let replacement: Vec<(ItemId, Value)> = messages
            .iter()
            .skip_while(|m| m.role() == Role::System)
            .map(|m| {
                let (iid, row) = (self.iid_of(m), row_of(m));
                let held = match &row {
                    Value::Object(map) => HistoryRow::Stored(Arc::new(mixdog_agent::message::StoredRow::new(map.clone()))),
                    _ => HistoryRow::Message(Box::new(m.clone())),
                };
                base.push((iid.clone(), held));
                (iid, row)
            })
            .collect();
        self.restart(base);
        // Only a compaction pass writes a compaction record (and its divider, which an agent-mode session never shows).
        // Node splices any other rewrite into `state.messages` in place (`route-fallback.mjs:161` for a route's replay
        // strip): the context restarts silently.
        if !rewrite.compaction {
            let job = self.jobs.queue(&mut lock(&self.jobs.observed), |n| Job::Rewound(n, replacement));
            self.rewrite.store(job, Ordering::SeqCst);
            return;
        }
        let compaction = mixdog_core_session::session::run::Compaction {
            replacement,
            at: self.clock.now_ms(),
            dropped_count: rewrite.dropped_count,
            dropped: rewrite.dropped.as_ref().map(dropped_of),
        };
        let job = self.jobs.queue(&mut lock(&self.jobs.observed), |n| Job::Compact(n, compaction));
        self.rewrite.store(job, Ordering::SeqCst);
    }

    fn call_epoch(&self) -> u64 {
        self.port.call_epoch()
    }

    fn calls_left(&self, epoch: u64) {
        self.port.calls_left(epoch);
    }

    fn message_id(&self) -> String {
        format!("msg_{}", uuid::Uuid::new_v4().simple())
    }

    async fn skills_applied(&self, message: &AgentMessage, names: &[String]) {
        let applied = &self.applied;
        let item = if message.message_id == applied.input.0 { applied.input.1.clone() } else { self.iid_of(message) };
        // Node schedules the save and goes on; a stamp that cannot be stored never fails the turn.
        if let Err(error) = applied.parts.record_applied_skills(&applied.thread, &item, names).await {
            tracing::warn!("[session] applied skills save failed: {}", error.message);
        }
    }

    /// Waits for the save to end, with no bound of its own (a cancelled run stops waiting, `Run::until_durable`). A refused
    /// row does not fail the running turn: Node gates only the next turn's open on durability (`turn-durability.mjs`).
    async fn durable(&self, ticket: Ticket) {
        if ticket.0 == 0 {
            let _ = self.port.input_durable().await;
            return;
        }
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= ticket.0).await;
    }

    /// The actor has taken the job of `ticket`: what the run reports from here reaches it after. The input row it holds already.
    async fn accepted(&self, ticket: Ticket) {
        let mut accepted = self.accepted.clone();
        let _ = accepted.wait_for(|a| *a >= ticket.0).await;
    }

    /// The jobs queued so far, the draft the observer queued for the send's mark among them, have run: each ends once its
    /// write is durable or has failed (`RunPort::draft`, `commit_item`).
    async fn drafted(&self) {
        let queued = self.jobs.seq.load(Ordering::SeqCst);
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= queued).await;
    }

    /// The last rewrite is on disk. Its job's ack does not say so (a failed save acks the record it keeps in memory): once
    /// the actor has taken the job, the session is asked whether everything it accepted has landed. A run that rewrote
    /// nothing has nothing unstored.
    async fn replaced(&self) -> bool {
        let job = self.rewrite.load(Ordering::SeqCst);
        if job == 0 {
            return true;
        }
        let mut accepted = self.accepted.clone();
        accepted.wait_for(|a| *a >= job).await.is_ok() && self.port.writes_landed().await.is_ok()
    }
}
