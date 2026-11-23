//! A turn an agent outside Mixdog's loop runs. It begins as every turn does ([`super::drive`]: the model context read,
//! the settings reconcile, the session's prompt, the prompt hooks, the title and the reminders the input carries) and is
//! handed over where the loop would be entered: the agent gets the input as it is sent, the session's port, and the
//! session's tools as calls of the loop's own execution path.

use mixdog_agent::handed::HandedCalls;
use mixdog_agent::handed::HandedParts;
use mixdog_core_run::run_host::progress::RunProgress;
use mixdog_core_session::session::goal_reminder::GoalReminder;
use mixdog_core_session::session::prompt_notice::CarriedNotice;
use mixdog_core_session::session::run::Compaction;
use mixdog_core_session::session::transcript_writer::TurnTranscript;
use mixdog_core_session::session::turn_snapshot::TurnSnapshot;
use mixdog_store::schema::record::Header;

use super::*;

/// The agents that run turns outside Mixdog's loop.
#[async_trait]
pub trait OutsideAgents: Send + Sync + 'static {
    /// The route `header` names is one of these agents'.
    fn serves(&self, header: &Header) -> bool;
    /// The agent of the route `header` names cannot run now (turned off, not installed, signed out, failed to start):
    /// what it says why. `None` for an agent that can run, and for one whose turn waits for it.
    fn refusal(&self, _header: &Header) -> Option<String> {
        None
    }
    /// The input row `input` is something to tell the agent. One that is not (the turn of a reply the agent began on
    /// its own) is sent to nobody, so it carries no reminders.
    fn prompts(&self, input: &Value) -> bool;
    /// Runs the turn to its outcome.
    async fn run(&self, turn: OutsideTurn) -> RunOutcome;
    /// A turn of `thread` that began on an agent's route ended before it was handed to the agent, for the reason `why`.
    async fn unrun(&self, thread: &ThreadId, why: &str);
    /// A turn of the loop begins on `header`: what an agent holds of the thread is not continued past it. The change
    /// that takes the agent's own session out of the header, if the header names one; the turn starts once the session
    /// holds it.
    fn loop_turn(&self, thread: &ThreadId, header: &Header) -> Option<mixdog_store::schema::record::HeaderChange>;
    /// The route provider `provider` is one of these agents': a session on it has that agent for its own model, so
    /// what the session's own model writes outside a turn (a summary of the conversation) the agent writes.
    fn answers(&self, _provider: &str) -> bool {
        false
    }
    /// Asks the agent of `ask.provider` one question outside every conversation, in a session of the agent's that
    /// ends with the answer. `Err` tells why no answer was made.
    async fn ask(&self, ask: OutsideAsk) -> Result<OutsideAnswer, String> {
        Err(format!("no agent answers for {}", ask.provider))
    }
}

/// One question for an agent outside every conversation.
pub struct OutsideAsk {
    /// The route provider and model of the session the question is asked for.
    pub provider: String,
    pub model: String,
    /// The instructions the answer is written under, and the question.
    pub system: String,
    pub prompt: String,
}

/// An agent's answer to an [`OutsideAsk`].
#[derive(Clone, Debug, Default)]
pub struct OutsideAnswer {
    pub text: String,
    /// Why the agent stopped, in the protocol's word for it; `None` when it did not say.
    pub stop_reason: Option<String>,
    pub usage: Option<mixdog_core_api::domain::provider::Usage>,
    /// The usage's input leaves its cache reads out.
    pub input_excludes_cache: bool,
}

/// Hears the calls an outside agent's turn runs as the loop's observer hears its own: a wait on the user's approval is
/// a counted wait of the session's progress. The agent's turn, which marks the spinner for every step it takes, reads
/// the wait there and marks it in order with its other steps.
struct HandedObserver {
    progress: watch::Sender<RunProgress>,
    clock: Arc<dyn Clock>,
}

impl RunObserver for HandedObserver {
    fn event(&self, event: RunEvent) {
        let RunEvent::Stage(Stage::ApprovalWait { waiting }) = event else { return };
        let now = self.clock.now_ms();
        self.progress.send_modify(|progress| progress.approval_wait(waiting, now));
    }

    // No text of Mixdog's is shown in a turn an agent outside the loop runs.
    fn can_retract(&self) -> bool {
        false
    }

    fn retract_text(&self, _: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

/// The tool side of a turn's assembly, for a turn no provider of Mixdog's answers.
pub struct OutsideAssembled {
    /// The header the tools were assembled on: the turn's, or the one a tool-exposure migration left.
    pub header: Header,
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    pub gate: GateBuilder,
    /// The turn's workspace, where the review baseline is taken.
    pub worktree: String,
    pub clock: Arc<dyn Clock>,
    pub guards: Arc<dyn TurnGuards>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    pub hidden_agent: bool,
    pub live_cwd: Option<mixdog_agent::tools::LiveCwd>,
    /// Where a call's large result is stored, as a call of the loop's is.
    pub artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>,
    pub failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
    /// The session's repeat guards, as its record holds them.
    pub repeat: mixdog_agent::tools::RepeatGuards,
    /// The token budget a summary of the conversation for the agent is sized by.
    pub handoff_budget_tokens: u64,
    /// The session's compaction policy, over the window its header holds (the agent's own, once it reported one);
    /// `None` with automatic compaction off or no window known.
    pub compact: Option<mixdog_agent::boundary::CompactPolicy>,
    /// The session's reading of its context: what the agent last reported it holds. `None` with no reading, or one
    /// a compaction left behind.
    pub context_tokens: Option<u64>,
}

/// One turn, begun, as its agent takes it.
pub struct OutsideTurn {
    pub thread: ThreadId,
    pub turn: TurnId,
    /// The header the turn runs on: reconciled, its prompt current.
    pub header: Header,
    /// The input row as it is sent: the turn's context ahead of the prompt, its reminders behind it.
    pub input: Value,
    pub port: RunPort,
    pub cancel: tokio_util::sync::CancellationToken,
    pub progress: watch::Sender<RunProgress>,
    pub transcript: Option<TurnTranscript>,
    /// The session's tools, each call run as the loop runs one.
    pub calls: Arc<HandedCalls>,
    /// The conversation the session holds from before this turn.
    pub history: History,
    /// The hook of the job that owns a sub-agent's turn (`AgentTurn.hooks.on_tool_result`): told each tool result
    /// the turn gains, as the loop's sink tells it.
    pub on_tool_result: Option<Arc<ToldResult>>,
}

/// A job's hook for the tool results its turn gains.
pub type ToldResult = dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync;

/// The conversation a session holds from before a turn, for an agent that starts without it.
pub struct History {
    port: RunPort,
    rows: Vec<(ItemId, Value)>,
    input: (ItemId, Value),
    budget_tokens: u64,
    clock: Arc<dyn Clock>,
    /// The session's reading of the agent's context and the trigger it reached, when it reached it.
    due: Option<(u64, u64)>,
}

/// The reading and the trigger of a context that reached the session's compaction trigger: the pressure a provider's
/// session reads before a request is the prompt its provider last measured, and an agent's is what the agent last
/// reported it holds.
fn due(policy: Option<&mixdog_agent::boundary::CompactPolicy>, context_tokens: Option<u64>) -> Option<(u64, u64)> {
    let (policy, used) = policy.zip(context_tokens)?;
    let trigger = policy.trigger_tokens.max(1);
    (used >= trigger).then_some((used, trigger))
}

impl History {
    /// The session holds a conversation from before the turn.
    pub fn holds_conversation(&self) -> bool {
        self.rows.iter().any(|(_, row)| mixdog_core_session::session::route_session::has_user_conversation(std::slice::from_ref(row)))
    }

    /// The summary an earlier compaction left in `rows`, where they hold nothing the user said since: the text an agent
    /// is handed as it stands. `None` for rows that hold a conversation, or no summary.
    fn standing_summary(rows: &[&Value]) -> Option<Result<String, String>> {
        use mixdog_core_ports::ports::route::is_summary_anchor;
        use mixdog_core_session::session::route_session::has_user_conversation;
        let summarized = rows.iter().any(|row| is_summary_anchor(row));
        let conversation = rows.iter().any(|row| has_user_conversation(std::slice::from_ref(*row)));
        (summarized && !conversation).then(|| Self::told(rows.iter().copied().filter(|row| row.get("role").and_then(Value::as_str) != Some("system"))))
    }

    /// `rows` as the text an agent reads: each row that says something, under who said it.
    fn told<'a>(rows: impl IntoIterator<Item = &'a Value>) -> Result<String, String> {
        let mut text = Vec::new();
        for row in rows {
            let message = message_of(row).map_err(|error| format!("the summary holds a row this build cannot read: {error}"))?;
            let said = message.text();
            if !mixdog_js::js_trim(&said).is_empty() {
                let who = match message.role() {
                    Role::Assistant => "Assistant",
                    Role::Tool => "Tool result",
                    _ => "User",
                };
                text.push(format!("## {who}\n{said}"));
            }
        }
        Ok(text.join("\n\n"))
    }

    /// Summarizes the conversation with the session's own compactor, makes the result the session's stored context, and
    /// returns it as text for the agent. A context that holds only the summary of an earlier compaction is handed over
    /// as it stands; `None` for a session with neither. A summary that cannot be made, or stored, is the error.
    pub async fn hand_over(&self) -> Result<Option<String>, String> {
        if let Some(summary) = Self::standing_summary(&self.rows.iter().map(|(_, row)| row).collect::<Vec<_>>()) {
            return summary.map(Some);
        }
        if !self.holds_conversation() {
            return Ok(None);
        }
        self.summarize().await.map(Some)
    }

    /// The agent's context reached the session's compaction trigger: the reading and the trigger.
    pub fn compaction_due(&self) -> Option<(u64, u64)> {
        self.due
    }

    /// The session's automatic compaction, for a context the agent holds: the header stops naming the agent's session,
    /// which holds what the summary replaces, and the stored conversation is summarized as [`Self::hand_over`]
    /// summarizes it, whatever it holds since an earlier summary (the agent's own turns are in it). The session is left
    /// first: a stop between the two writes leaves a conversation whose next turn hands it over, never a summary under a
    /// header that still names the session it replaced. `None` for a session whose stored context is empty; an error
    /// may come after the session was left.
    pub async fn compact(&self) -> Result<Option<String>, String> {
        if self.rows.iter().all(|(_, row)| row.get("role").and_then(Value::as_str) == Some("system")) {
            return Ok(None);
        }
        let unset = vec![mixdog_core_session::session::turn_ops::AGENT_SESSION.to_owned()];
        let left = mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset, patch: Default::default() };
        self.port.save_header(left).await.map_err(|error| format!("the agent's session could not be left behind: {error:?}"))?;
        self.summarize().await.map(Some)
    }

    /// Summarizes the stored conversation with the session's own compactor, stores the result as the session's
    /// context and returns it as text.
    async fn summarize(&self) -> Result<String, String> {
        let rows: Vec<Value> = self.rows.iter().map(|(_, row)| row.clone()).collect();
        let compacted = self.port.compact_for_heir(&rows, self.budget_tokens).await.map_err(|error| error.to_string())?;
        let kept: Vec<Value> = compacted
            .ok_or_else(|| "this session has no compaction to summarize it with".to_owned())?
            .into_iter()
            .filter(|row| row.get("role").and_then(Value::as_str) != Some("system"))
            .collect();
        let text = Self::told(&kept)?;
        let mut replacement = Vec::with_capacity(kept.len() + 1);
        let item_of: HashMap<String, ItemId> = self.rows.iter().filter_map(|(item, row)| Some((message_of(row).ok()?.message_id?, item.clone()))).collect();
        for row in &kept {
            let id = message_of(row).ok().and_then(|message| message.message_id);
            replacement.push((id.as_ref().and_then(|id| item_of.get(id)).cloned().unwrap_or_else(new_item_id), row.clone()));
        }
        // The calls the summary took out leave the session's context: the ids of the calls that enter it from here on
        // are told apart from theirs.
        self.port.calls_left(self.port.call_epoch() + 1);
        replacement.push(self.input.clone());
        let compaction = Compaction { replacement, at: self.clock.now_ms(), dropped_count: rows.len().saturating_sub(kept.len()) as u64, dropped: None };
        self.port.compacted(compaction).await.map_err(|error| format!("the summary could not be stored: {error:?}"))?;
        // The reading was of the context the summary replaced: the session has none until the agent reports again.
        let now = mixdog_js::json_number(self.clock.now_ms() as f64);
        let set = [("lastContextTokens", json!(0)), ("lastContextTokensUpdatedAt", now), ("lastContextTokensStaleAfterCompact", json!(false))]
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect();
        let read = mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() };
        // The summary is stored: a failed reset is no failed compaction, or the turn would go on in the session it replaced.
        if let Err(error) = self.port.save_header(read).await {
            tracing::warn!("[session] the context reading could not be reset after a compaction: {error:?}");
        }
        Ok(text)
    }
}

/// What [`drive_outside`] takes over from the turn's start.
pub(super) struct Outside {
    pub(super) parts: Arc<dyn RunParts>,
    pub(super) agents: Arc<dyn OutsideAgents>,
    pub(super) thread: ThreadId,
    pub(super) turn: TurnId,
    pub(super) header: Header,
    pub(super) port: RunPort,
    pub(super) context: mixdog_core_session::session::run::ModelContext,
    pub(super) surface: watch::Receiver<Arc<SessionSurface>>,
    pub(super) progress: watch::Sender<RunProgress>,
    pub(super) tool_progress: Arc<dyn mixdog_core_api::domain::tool::ProgressSink>,
    pub(super) hints: ToolHints,
    pub(super) cancel: tokio_util::sync::CancellationToken,
    pub(super) review: TurnSnapshot,
    pub(super) input_body: Value,
    pub(super) input_item: ItemId,
    pub(super) stored_ids: Vec<ItemId>,
    pub(super) prior: Vec<Value>,
    pub(super) injected: bool,
    pub(super) goal_reminder: Option<GoalReminder>,
    pub(super) notice: CarriedNotice,
    pub(super) transcript: Option<TurnTranscript>,
    pub(super) turn_context: String,
    pub(super) unattended: bool,
    pub(super) generation: u64,
    pub(super) request: String,
    pub(super) asked: Arc<std::sync::atomic::AtomicBool>,
    pub(super) handover: Arc<AgentReach>,
    pub(super) rebound: bool,
    pub(super) rebind_owed: bool,
    /// What an agent-owned turn was given by the job that owns it (`AgentTurn`): the lane's admission lease, the
    /// completion hook its tools reach and the hook told each tool result.
    pub(super) slot: Option<Arc<dyn mixdog_agent::env::Yielder>>,
    pub(super) notify: Option<mixdog_core_api::domain::tool::ToolNotify>,
    pub(super) on_tool_result: Option<Arc<ToolResultCallback>>,
}

pub(super) async fn drive_outside(outside: Outside) -> RunOutcome {
    let Outside {
        parts,
        agents,
        thread,
        turn,
        header,
        port,
        context,
        surface,
        progress,
        tool_progress,
        hints,
        cancel,
        review,
        input_body,
        input_item,
        stored_ids,
        prior,
        injected,
        goal_reminder,
        notice,
        transcript,
        turn_context,
        unattended,
        generation,
        request,
        asked,
        handover,
        rebound,
        rebind_owed,
        slot,
        notify,
        on_tool_result,
    } = outside;
    let surface_now = surface.borrow().clone();
    let assembled = parts
        .assemble_outside(AssembleInput {
            thread: &thread,
            turn: &turn,
            header: &header,
            surface: surface_now,
            port: &port,
            surface_rx: surface.clone(),
            slot: None,
            skill_selection: None,
            prior: &prior,
            generation,
            request: &request,
            injected,
            cancel: &cancel,
            unattended,
            notify,
            progress: tool_progress,
            agent_refusal: None,
        })
        .await;
    let OutsideAssembled {
        header,
        tools,
        mut tool_env,
        gate,
        worktree,
        clock,
        guards,
        hooks,
        reuse,
        blobs,
        hidden_agent,
        live_cwd,
        artifacts,
        images,
        failures,
        repeat,
        handoff_budget_tokens,
        compact,
        context_tokens,
    } = match assembled {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    // The turn's tools publish each edit's card diff to the turn's review, and the agent edits with tools of its own:
    // the baseline is taken over the turn's workspace before either runs.
    tool_env.review = Some(review.api());
    review.start(&worktree);
    let input_body = if agents.prompts(&input_body) {
        let carried = carry_turn(Carry {
            parts: &parts,
            thread: &thread,
            header: &header,
            port: &port,
            stored_ids: &stored_ids,
            prior: &prior,
            input_item: &input_item,
            input_body,
            injected,
            turn_context: &turn_context,
            goal_reminder: goal_reminder.as_ref(),
            notice: &notice,
            hidden_agent,
            config: None,
            clock: &clock,
            blobs: &blobs,
            guards: &guards,
            rebound,
            rebind_owed,
        })
        .await;
        match carried {
            Ok((input_body, _)) => input_body,
            Err(outcome) => return outcome,
        }
    } else {
        input_body
    };
    let observer: Arc<dyn RunObserver> = Arc::new(HandedObserver { progress: progress.clone(), clock: clock.clone() });
    let asks = mixdog_agent::handed::JudgedAsks::over(Arc::new(port.clone()));
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(
        review,
        gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: asks.clone() }),
    ));
    let calls = Arc::new(HandedCalls::new(HandedParts {
        tools,
        tool_env,
        gate,
        hooks,
        guards: guards.clone(),
        reuse,
        clock: clock.clone(),
        observer,
        mcp: Some(Arc::new(ThreadMcp { parts: parts.clone(), thread: thread.clone(), surface })),
        live_cwd,
        artifacts,
        images,
        failures: failures.map(|inner| Arc::new(SensitiveFailures { inner, context }) as Arc<dyn mixdog_agent::env::ToolFailureLog>),
        repeat,
        cancel: cancel.clone(),
        slot,
        asks: Some(asks),
    }));
    let history = History {
        port: port.clone(),
        rows: stored_ids.into_iter().zip(prior).collect(),
        input: (input_item, input_body.clone()),
        budget_tokens: handoff_budget_tokens,
        clock,
        due: due(compact.as_ref(), context_tokens),
    };
    // From here the turn's stop is the agent's turn's to close, as the loop closes its own.
    asked.store(true, Ordering::SeqCst);
    handover.reached.store(true, Ordering::SeqCst);
    let end_port = port.clone();
    let begun = OutsideTurn {
        thread,
        turn,
        header,
        input: input_body,
        port,
        cancel: cancel.clone(),
        progress,
        transcript,
        calls: calls.clone(),
        history,
        on_tool_result,
    };
    let outcome = agents.run(begun).await;
    hints.finish().await;
    // The guard state that outlives one turn lives on the session record, as the loop leaves it.
    let mut set = calls.repeat_saved().await;
    if let Some(check) = guards.saved() {
        set.insert("todoCheck".to_owned(), check);
    }
    if !set.is_empty() {
        let end_port = if cancel.is_cancelled() { end_port.closing() } else { end_port };
        let _ = end_port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() }).await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A context that holds only the summary a compaction left (a session moved onto the agent right after one) hands
    /// that summary over as it stands; one the user spoke in since is summarized anew, and an empty one hands nothing.
    #[test]
    fn a_context_that_holds_only_a_compaction_summary_hands_that_summary_over() {
        let summary =
            json!({ "role": "user", "content": format!("{}the user asked for a parser; it is half written", mixdog_agent::compact::fresh::SUMMARY_PREFIX) });
        let system = json!({ "role": "system", "content": "rules" });
        let kept = json!({ "role": "assistant", "content": "I will finish the parser." });
        let said = json!({ "role": "user", "content": "go on" });

        let handed = History::standing_summary(&[&system, &summary, &kept]).expect("a summary stands").expect("readable rows");
        assert!(handed.starts_with("## User\n"), "{handed}");
        assert!(handed.contains("the user asked for a parser; it is half written"), "{handed}");
        assert!(handed.ends_with("## Assistant\nI will finish the parser."), "{handed}");
        assert!(!handed.contains("rules"), "the session's prompt is no part of the summary: {handed}");

        assert!(History::standing_summary(&[&summary, &kept, &said]).is_none(), "a conversation since the summary is summarized anew");
        assert!(History::standing_summary(&[&system]).is_none());
    }

    /// An agent's session compacts on the reading a provider's does: what its context holds, against the trigger of
    /// the session's policy over the window the session holds. At the trigger it is due; below it, with no reading
    /// (none yet, or one a compaction left behind) and with automatic compaction off it is not.
    #[test]
    fn a_context_is_due_for_compaction_once_the_agents_reading_reaches_the_sessions_trigger() {
        use mixdog_agent::boundary::CompactPolicy;
        use mixdog_agent::boundary::CompactSettings;
        let settings = |auto: bool| CompactSettings { auto, context_window: Some(1_048_576), token_calibration: 1.0, ..CompactSettings::default() };
        let policy = CompactPolicy::resolve(&settings(true)).expect("a policy over the agent's window");
        let trigger = policy.trigger_tokens;
        assert_eq!(due(Some(&policy), Some(trigger)), Some((trigger, trigger)));
        assert_eq!(due(Some(&policy), Some(trigger + 9)), Some((trigger + 9, trigger)));
        assert_eq!(due(Some(&policy), Some(trigger - 1)), None);
        assert_eq!(due(Some(&policy), None), None);
        assert_eq!(due(CompactPolicy::resolve(&settings(false)).as_ref(), Some(trigger)), None);
        // An explicit limit below the window is the trigger, as it is for a provider's session.
        let limited = CompactPolicy::resolve(&CompactSettings { auto_limit: Some(200_000), ..settings(true) }).expect("a policy");
        assert_eq!(due(Some(&limited), Some(200_000)), Some((200_000, 200_000)));
    }

    struct At(i64);

    impl Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    /// The approval wait of a call an outside agent's turn runs is a counted wait of the session's progress for as
    /// long as it is open: what the agent's turn reads to mark the spinner.
    #[test]
    fn the_approval_wait_of_a_handed_call_is_counted_in_the_progress_while_it_is_open() {
        let (progress, watched) = watch::channel(RunProgress::default());
        progress.send_modify(|progress| progress.ask_start(1));
        let observer = HandedObserver { progress, clock: Arc::new(At(2)) };
        let awaiting = || watched.borrow().snapshot(3).is_some_and(|snapshot| snapshot.awaiting_user);

        observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: true }));
        assert!(awaiting());
        observer.event(RunEvent::Stage(Stage::ApprovalWait { waiting: false }));
        assert!(!awaiting());
    }
}
