//! One turn's drive: setup, the loop run and its outcome.

use super::*;

pub(super) async fn flush_buffered_switches(switch_bus: Option<&Arc<RouteSwitchBus>>, port: &RunPort) {
    if let Some(bus) = switch_bus {
        let closing = port.closing();
        for event in bus.drain_buffered() {
            let _ = closing.stage("route_switch".to_owned(), Some(event.to_value())).await;
        }
    }
}

/// What a stop that lands before the model loop needs of the run: the loop closes a stop that lands inside it
/// ([`close_cancelled`]); this closes one that ends the run's setup.
pub(super) struct BeforeLoop {
    pub(super) port: RunPort,
    pub(super) input_item: ItemId,
    pub(super) input_body: Value,
    pub(super) cancel: tokio_util::sync::CancellationToken,
    pub(super) signal: mixdog_agent::cancel::Cancel,
    /// Set once the run reaches its model loop.
    pub(super) asked: Arc<std::sync::atomic::AtomicBool>,
}

impl BeforeLoop {
    pub(super) async fn settle(self, outcome: RunOutcome) -> RunOutcome {
        let reported_failure = matches!(outcome, RunOutcome::Failed(_));
        let reason = self.signal.is_aborted().then(|| self.signal.reason());
        match setup_end(reported_failure, self.asked.load(Ordering::SeqCst), self.cancel.is_cancelled(), reason.as_deref()) {
            SetupEnd::AsReported => outcome,
            SetupEnd::Stalled => failed(reason.unwrap_or_default(), Value::Null),
            SetupEnd::Stopped => {
                // The run's token has fired: what closes the stopped turn is saved on a port whose waits outlive it.
                close_stopped_prompt(&self.port.closing(), &self.input_item, &self.input_body, self.signal.close_reason()).await;
                RunOutcome::Interrupted
            }
        }
    }
}

/// Closes a turn stopped before anything of it reached the conversation, for the stop's reason, on `port`: a user's stop
/// hands the prompt back (the rewind record at its row), and a stop that keeps it writes the interruption line after it.
pub(super) async fn close_stopped_prompt(port: &RunPort, input_item: &ItemId, input_body: &Value, reason: mixdog_agent::interrupt::AbortReason) {
    let Ok(input) = message_of(input_body) else { return };
    let (rewound, following) = stopped_prompt(&input, reason);
    if rewound {
        // A row the thread shows under another id is taken by the actor when the turn closes (`apply_reclaim`).
        if let Err(error) = port.prompt_rewound(input_item.clone()).await {
            tracing::warn!("[session] rewound prompt save failed: {error:?}");
        }
    }
    for message in &following {
        let item = ItemCommit { iid: new_item_id(), role: Some("user".to_owned()), model: true, visible: false, body: row_of(message), prompt: None };
        if let Err(error) = port.commit_item(item).await {
            tracing::warn!("[session] interrupted turn row save failed: {error:?}");
        }
    }
}

/// Where the skills a prompt loaded are stamped: the thread's row of that prompt.
pub(super) struct AppliedSkills {
    pub(super) parts: Arc<dyn RunParts>,
    pub(super) thread: ThreadId,
    /// The turn's input row, which the actor committed, and the message id it carries.
    pub(super) input: (Option<String>, ItemId),
}

/// What `beginTurn` (`tui/session/turn.mjs`) gave the turn, as its assistant rows and its completion take it.
pub(super) struct TurnStamp {
    /// `attemptId` and the route fields of the input row's `meta.transcript`
    /// (`persistedAssistantTranscriptMetadata`: the attempt and `transcriptRouteMetadataFields`).
    pub(super) carried: serde_json::Map<String, Value>,
    /// `rawTranscriptMeta.at`, else the ask's start.
    pub(super) started_at: i64,
    /// The turn's change-record key, which its completion names.
    pub(super) checkpoint_id: Option<String>,
    /// `pickDoneVerb(stats.turns)`.
    pub(super) verb: &'static str,
}

impl TurnStamp {
    pub(super) fn of(input_body: &Value, verb: &'static str, asked_at: i64) -> Option<Self> {
        let transcript = input_body.pointer("/meta/transcript")?.as_object()?;
        let text = |key: &str| transcript.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let carried = ["attemptId", "modelId", "model", "provider", "agent"]
            .into_iter()
            .filter_map(|key| text(key).map(|value| (key.to_owned(), json!(value))))
            .collect();
        Some(Self {
            carried,
            started_at: transcript.get("at").and_then(Value::as_i64).filter(|at| *at != 0).unwrap_or(asked_at),
            checkpoint_id: text("checkpointId").map(str::to_owned),
            verb,
        })
    }
}

/// A task that carries a turn's events to its session (the run's shown events, its commits): a replay's settled signal counts
/// it with the turn (mixdog-ai `replay_bytes::in_run`), so the turn is not settled while an event it sent is still on the way.
pub(super) fn turn_task<F: std::future::Future>(task: F) -> impl std::future::Future<Output = F::Output> {
    #[cfg(feature = "replay-bytes")]
    return mixdog_ai::transport::replay_bytes::in_run(task);
    #[cfg(not(feature = "replay-bytes"))]
    task
}

/// A [`turn_task`]'s wait for the turn's next event: a wait on the turn, parked for a replay's settled signal.
pub(super) fn turn_input<F: std::future::Future>(wait: F) -> impl std::future::Future<Output = F::Output> {
    #[cfg(feature = "replay-bytes")]
    return mixdog_ai::transport::replay_bytes::parked(wait);
    #[cfg(not(feature = "replay-bytes"))]
    wait
}

/// Whether a provider error is one of the runtime's own timeout or stall errors (`armTurnTimeoutOnProviderError`,
/// `turn-reap.mjs`): a code of `PROVIDER_TIMEOUT_CODES`, or Node's `streamStalled` flag. The flag is not a field
/// here; its producers are a stream watchdog's expiry (`timeout_phase`) and a stream cut after it showed text (a
/// truncated stream whose text was emitted).
pub(super) fn provider_timeout_or_stall(error: &mixdog_core_api::domain::provider::ProviderError) -> bool {
    use mixdog_core_api::domain::provider::TransportFault;
    matches!(error.code.as_deref(), Some("ESTREAMSTALL" | "EPROVIDERTIMEOUT" | "EGEMINITIMEOUT"))
        || error.timeout_phase.is_some()
        || (matches!(error.transport, Some(TransportFault::TruncatedStream)) && error.exposure.text_emitted)
}

/// What the progress watchdog of an unattended turn judges by.
pub(super) struct Watched<'a> {
    pub(super) parts: &'a Arc<dyn RunParts>,
    pub(super) thread: &'a ThreadId,
    /// The header the turn runs on: its agent's deadlines.
    pub(super) header: &'a mixdog_store::schema::record::Header,
    pub(super) hidden_agent: bool,
    /// The routed model's first-response budget; none for a turn no provider of Mixdog's answers.
    pub(super) budget: Option<mixdog_core_api::domain::provider::FirstResponseBudget>,
    pub(super) signal: &'a mixdog_agent::cancel::Cancel,
    pub(super) clock: &'a Arc<dyn Clock>,
    pub(super) failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
    /// When the ask started: the shells started from then on are the turn's.
    pub(super) asked_at: i64,
}

/// Arms the progress watchdog of an unattended turn, whoever answers it, over `snapshot`, the turn's progress as whoever does
/// its work marks it: a stall stops the turn with its shells reaped and the stop recorded.
pub(super) async fn arm_watchdog(watched: Watched<'_>, snapshot: impl Fn(i64) -> Option<Snapshot> + Send + 'static) -> Option<Watchdog> {
    let Watched { parts, thread, header, hidden_agent, budget, signal, clock, failures, asked_at } = watched;
    let agent = header.get("agent").and_then(Value::as_str).filter(|name| !name.is_empty());
    // `agentWatchdogOverrides`: the agent definition's first-response deadline and the routed
    // model's first-response budget.
    let overrides = Overrides {
        first_transport_timeout_ms: match agent {
            Some(name) => parts.first_response_timeout_ms(name).await,
            None => None,
        },
        provider_first_byte_timeout_ms: budget.map(|b| b.transport_ms),
        provider_first_output_timeout_ms: budget.map(|b| b.semantic_ms),
        ..Overrides::default()
    };
    let kind = AgentKind { name: agent, hidden: hidden_agent, stall_cap_idle_seconds: parts.stall_cap_idle_seconds(agent) };
    let policy = resolve_policy(kind, overrides, &|name: &str| std::env::var(name).ok());
    let (reaper, reaped_thread) = (parts.clone(), thread.clone());
    // The worker-turn registry's stop (`abortOnTimeout`, `agent-watchdog-registry.mjs:30-33`): the reap is armed, then the stop is
    // recorded with what the sweep judged, then the abort.
    let (stall_agent, site) = (agent.map(str::to_owned), StallSite::Registry { registration_id: registration_id() });
    let anchor_ts = clock.now_ms();
    Watchdog::arm(true, policy, signal.clone(), clock.clone(), snapshot, move |snapshot: &Snapshot, message: &str, now: i64| {
        reaper.reap_turn_shells(&reaped_thread, asked_at);
        if let Some(log) = failures {
            log.stall_abort(stall_abort_ctx(reaped_thread.as_str(), stall_agent.as_deref(), &site, &policy, anchor_ts, snapshot, message, now));
        }
    })
}

pub(super) async fn drive_turn(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
    asked: Arc<std::sync::atomic::AtomicBool>,
) -> RunOutcome {
    // A turn that begins on an outside agent's route and ends before it is that agent's (its start failed or was
    // stopped) leaves what the agent queued for it unanswered: the agent is told the turn was not run.
    // The route is the agent's where the turn starts on it, and where the turn's own start (a pick held for it, a
    // setting that moved) brings the session onto it.
    let agents = parts.outside_agents();
    let thread = run.thread.clone();
    let handover = Arc::new(AgentReach {
        begun: std::sync::atomic::AtomicBool::new(agents.as_ref().is_some_and(|agents| agents.serves(&run.header))),
        reached: std::sync::atomic::AtomicBool::new(false),
    });
    let outcome = drive_boxed(parts, liveness, search_usage, run, asked, handover.clone()).await;
    if let Some(agents) = agents
        && handover.begun.load(Ordering::SeqCst)
        && !handover.reached.load(Ordering::SeqCst)
    {
        let why = match &outcome {
            RunOutcome::Failed(error) => error.message.clone(),
            _ => "the turn was stopped before it started".to_owned(),
        };
        agents.unrun(&thread, &why).await;
    }
    outcome
}

const LEAVE_FAILED: &str = "the agent's session could not be removed from the session";

fn apply_header_change(header: &mut mixdog_store::schema::record::Header, change: mixdog_store::schema::record::HeaderChange) {
    for key in change.unset {
        header.shift_remove(&key);
    }
    header.extend(change.set);
}

/// A turn of the loop begins on `header`: the agent is told, and the session leaves it once its header no longer names
/// the agent's own session (one that stayed would be resumed later without the turns the loop ran meanwhile). A change
/// the store could not write is held by the session and written ahead of every record this turn stores; `Err(())` only
/// for a turn that is no longer the session's.
pub(super) async fn leave_agent(
    agents: &dyn OutsideAgents,
    thread: &ThreadId,
    header: &mixdog_store::schema::record::Header,
    port: &RunPort,
    handover: &AgentReach,
) -> Result<Option<mixdog_store::schema::record::HeaderChange>, ()> {
    let change = agents.loop_turn(thread, header);
    if let Some(change) = &change
        && port.save_header(change.clone()).await.is_err()
    {
        return Err(());
    }
    handover.reached.store(true, Ordering::SeqCst);
    Ok(change)
}

/// How far a turn got towards an outside agent.
pub(super) struct AgentReach {
    /// The turn was on an agent's route at some point of its start.
    pub(super) begun: std::sync::atomic::AtomicBool,
    /// The turn was handed to the agent, or the agent was told a turn of the loop began.
    pub(super) reached: std::sync::atomic::AtomicBool,
}

/// What a run of the loop left of its turn, for the agent a route hop hands the turn to.
struct LeftTurn {
    /// The rows the model context holds ahead of the turn's input.
    ahead: Vec<(ItemId, Value)>,
    /// The turn's input as it was sent.
    input: Value,
    /// The whole model context, the input in its place, when the run added to it; empty when it added nothing.
    taken_over: Vec<(ItemId, Value)>,
    /// Hidden rows already committed after the input before the loop ran (e.g. preloaded skill rows from an earlier ACP hop).
    committed_after_input: Vec<(ItemId, Value)>,
    /// The loop already produced work in this turn (committed at least one row after the turn's input).
    produced: bool,
}

/// The model context as the run left it, read as [`close_cancelled`] reads it: the context its last rewrite left ([`Base`])
/// and the turn's messages after it, each as the body it is stored as.
fn left_turn(sink: &PortSink, rows: &StoredRows, input_item: &ItemId, preloaded_after_input: &[(ItemId, Value)]) -> LeftTurn {
    use mixdog_agent::compact::execution_tail::MessageRows as _;
    let stored = |message: &AgentMessage| match rows.row(message) {
        Value::Null => row_of(message),
        body => body,
    };
    let base = lock(&sink.base);
    let turn = lock(&sink.turn);
    let mut context: Vec<(ItemId, Value)> = base.rows.iter().map(|(iid, row)| (iid.clone(), Base::body(row))).collect();
    let input = stored(&turn[0]);
    let input_msg_id = turn[0].message_id.as_deref();
    // The input is the turn's first message: a rewrite during the run (a replay strip on an earlier hop, or a
    // compaction) holds it among the rows it left.
    let at = if base.held == 0 {
        Some(context.len())
    } else {
        context.iter().rposition(|(iid, row)| {
            iid == input_item
                || input_msg_id.is_some_and(|id| message_of(row).ok().and_then(|m| m.message_id).as_deref() == Some(id))
                || (input_msg_id.is_none() && row == &input)
        })
    };
    let produced = turn.len() > 1;
    for (index, message) in turn.iter().enumerate().skip(base.held) {
        context.push((if index == 0 { input_item.clone() } else { sink.iid_of(message) }, stored(message)));
        if index == 0 && produced {
            context.extend(preloaded_after_input.iter().cloned());
        }
    }
    let len = context.len();
    match at {
        Some(at) if !produced && at + 1 == len => {
            context.truncate(at);
            let carried = if base.held == 0 { preloaded_after_input.to_vec() } else { Vec::new() };
            LeftTurn { ahead: context, input, taken_over: Vec::new(), committed_after_input: carried, produced: false }
        }
        Some(at)
            if !produced
                && !preloaded_after_input.is_empty()
                && context[at + 1..].len() == preloaded_after_input.len()
                && context[at + 1..].iter().zip(preloaded_after_input.iter()).all(|((iid, row), (piid, prow))| iid == piid || row == prow) =>
        {
            let carried = context[at + 1..].to_vec();
            context.truncate(at);
            LeftTurn { ahead: context, input, taken_over: Vec::new(), committed_after_input: carried, produced: false }
        }
        Some(at) => {
            LeftTurn { ahead: context[..at].to_vec(), input, taken_over: context, committed_after_input: Vec::new(), produced: produced || at + 1 < len }
        }
        None => LeftTurn { ahead: context.clone(), input, taken_over: context, committed_after_input: Vec::new(), produced },
    }
}

#[inline(never)]
fn drive_boxed(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
    asked: Arc<std::sync::atomic::AtomicBool>,
    handover: Arc<AgentReach>,
) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
    Box::pin(drive(parts, liveness, search_usage, run, asked, handover))
}

#[inline(never)]
fn drive_outside_boxed(outside: Outside) -> Pin<Box<dyn Future<Output = super::outside::OutsideOutcome> + Send>> {
    Box::pin(drive_outside(outside))
}

#[inline(never)]
fn run_agent_boxed(run: Run) -> Pin<Box<dyn Future<Output = Result<mixdog_agent::run::RunOutput, mixdog_agent::run::RunFailure>> + Send>> {
    Box::pin(run.run())
}

async fn drive(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
    asked: Arc<std::sync::atomic::AtomicBool>,
    handover: Arc<AgentReach>,
) -> RunOutcome {
    let RunStart {
        prefix_guard,
        cache_tail,
        thread,
        turn,
        input_body,
        header,
        port,
        context,
        surface,
        progress,
        turn_messages,
        cancel,
        signal,
        review,
        agent_turn,
        unattended,
        verb,
        skill_selection: routine_selection,
        input: submitted,
        input_item,
        goal_reminder,
        notice: carried_notice,
        transcripts,
        lifecycle,
    } = run;
    // whileTurnDispatched and the runtime entry (`runtime-state.mjs`): the run is live from here to the end of the drive.
    let _live = super::super::turn_liveness::TurnLiveness::begin(&liveness, &thread, &header, progress.subscribe(), cancel.clone());
    // The turn's own context (`options.context`: an agent spawn's or send's `context` argument).
    // A queued follow-up carries it in its submission options (`drain.mjs` `turnOptionsForBatch`).
    let own_context = agent_turn
        .as_ref()
        .and_then(|turn| turn.context.as_ref())
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| submitted.options.as_ref().and_then(|options| options.context.clone()));
    let (slot, skill_selection, on_tool_result, notify) = match agent_turn {
        Some(turn) => {
            let hook = turn.hooks.notify;
            let notify = mixdog_core_api::domain::tool::ToolNotify(Arc::new(move |text, meta| hook(text, meta)));
            (turn.slot, turn.skill_selection, Some(turn.hooks.on_tool_result), Some(notify))
        }
        None => (None, routine_selection, None, None),
    };
    parts.reset_turn_shells(&thread);
    let hints = ToolHints::start(progress.subscribe(), port.clone());
    let tool_progress = RunToolProgress::new(progress.clone());
    // The generation of the history the rows are, read as one load with them: a rewrite commits its rows and moves the
    // generation in one step of the session, and none can start while this turn runs.
    let generation = cache_tail.generation(thread.as_str(), header.get("cacheTailBook"));
    let mut stored = match context.read().await {
        Ok(stored) => stored,
        Err(error) => return failed(format!("model context unreadable: {error:?}"), Value::Null),
    };
    let request = prompt_text(&input_body);
    // A failed-turn retry starts without the stale copy of its prompt (`prepareAskTurn`). The
    // context is restarted durably (the chained provider state re-baselines with it), at the rows
    // that remain and this run's input, so the next turn reads the prompt once.
    let stale = match failed_turn_rewind::rewound(&mut stored, submitted.options.as_ref(), &request) {
        Ok(stale) => stale,
        Err(text) => return failed(text, Value::Null),
    };
    if !stale.is_empty() {
        let mut restart = stored.clone();
        restart.push((input_item.clone(), input_body.clone()));
        if port.context_rewound(restart).await.is_err() {
            return failed("the failed prompt could not be removed from the model context", Value::Null);
        }
    }
    // The rows' bodies are read where they are, not copied: the context since the last compaction can be tens of MB, and a
    // copy held for the whole run was one of the turn's several (Codex keeps one shared history). The ids are rejoined only
    // for the rare rewrites below.
    let (mut stored_ids, mut prior): (Vec<ItemId>, Vec<Value>) = stored.into_iter().unzip();
    let injected = is_injected(&input_body);
    // Node's `await reconcileTurnSettings()` of the turn preparation: a gate that moved since the last turn
    // reaches this one through the header, before the request is assembled.
    let header = match parts.reconcile_turn(&thread, header, mixdog_core_session::session::thread_settings::has_conversation_messages(&prior)).await {
        Ok(header) => header,
        Err(error) => return RunOutcome::Failed(error),
    };
    if parts.outside_agents().is_some_and(|agents| agents.serves(&header)) {
        handover.begun.store(true, Ordering::SeqCst);
    }
    // A prefix that moved under the stored conversation (a rebuilt prompt) leaves the thinking it stored bound to the old
    // one (`markToolSurfaceMigrated` with the transcript). The fold records that owed in the header, in the write that moves
    // the prefix; the rows are rebound and written with this turn's input below, and only then is the debt cleared, so a turn
    // that fails first (or a restart) leaves it to the next turn.
    let rebind_owed = header.get("thinkingRebindPending") == Some(&Value::Bool(true));
    let mut rebound = false;
    if rebind_owed {
        let (rows, changed, closing) = super::super::thinking_binding::rebind_to_changed_prefix_at(&prior);
        if changed {
            if let Some(at) = closing {
                stored_ids.insert(at, ItemId::from(uuid::Uuid::now_v7().to_string()));
            }
            prior = rows;
            rebound = true;
        }
    }
    // `refreshSessionBp3Environment` (`ask-turn-execute.mjs`): the first turn of a session whose prompt has not
    // taken its `# Session` block yet adds it, and the session records that it did.
    let mut header = header;
    if header.get("sessionStartMetaInjected") != Some(&Value::Bool(true)) && !mixdog_core_session::session::route_session::has_user_conversation(&prior) {
        let patch = super::super::prompt_session::refresh_environment(&header, &mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header));
        for key in &patch.change.unset {
            header.shift_remove(key);
        }
        for (key, value) in &patch.change.set {
            header.insert(key.clone(), value.clone());
        }
        if port.save_header(patch.change).await.is_err() {
            return failed("the session's prompt could not be saved", Value::Null);
        }
    }
    // `ensureSessionTranscriptWriter(); transcript.appendUser(prompt)` (`turn-prepare.mjs:162-163`): the prompt as submitted,
    // before the turn's reminders ride it.
    // The session's record names the folder its transcript is written in before the writer opens, so a delete finds the file.
    if let Some(recorded) = transcripts.as_ref().and_then(|files| files.cwds_to_record(&header)) {
        let key = mixdog_core_session::session::transcript_writer::TRANSCRIPT_CWDS;
        let mut set = serde_json::Map::new();
        set.insert(key.to_owned(), Value::from(recorded.clone()));
        if port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() }).await.is_err() {
            return failed("the session's transcript folder could not be saved", Value::Null);
        }
        header.insert(key.to_owned(), Value::from(recorded));
    }
    let turn_transcript = transcripts.as_ref().and_then(|files| files.turn(thread.as_str(), &header, &prior));
    if let Some(transcript) = &turn_transcript {
        transcript.user(input_body.get("content").unwrap_or(&Value::Null));
    }
    // `dispatchPromptSubmit` (`turn-prepare.mjs:185-208`), after the prompt row and before the model is asked: a handler's
    // block refuses the turn (`prompt blocked by hook: <reason>`), a hook failure decides nothing, and the context the
    // handlers add joins the turn's own as the context this turn carries. The wait ends with the turn (`turn.awaitTurn`):
    // a turn stopped meanwhile ends as stopped: in the loop, or by `BeforeLoop` when a later setup wait ends with the fired token.
    let submitted_prompt = input_body.get("content").cloned().unwrap_or(Value::Null);
    let verdict = tokio::select! {
        verdict = lifecycle.prompt_submit(&thread, &header, &submitted_prompt) => verdict,
        () = cancel.cancelled() => Default::default(),
    };
    if verdict.blocked {
        // The refusal throws before `askSession` (`turn-run.mjs` `runTurn`): `session.messages` never takes the prompt and
        // keeps a retry's stale copy, so the model context restarts at the rows it held before this turn.
        let mut stored = rejoined(&stored_ids, &prior);
        stored.extend(stale);
        if let Err(error) = port.context_restored(stored).await {
            tracing::warn!("[session] the refused prompt could not be removed from the model context: {error:?}");
        }
        return failed(format!("prompt blocked by hook: {}", verdict.reason.as_deref().unwrap_or_default()), Value::Null);
    }
    let turn_context = super::super::lifecycle_hooks::turn_context(own_context.as_deref(), &verdict.context);
    // Single-pass pre-flight route selection: awaits cold ACP readiness, checks primary recovery across HTTP↔ACP, and
    // dispatches directly onto whichever runner (Outside or Loop) was selected without double-scanning.
    struct LoopState {
        header: mixdog_store::schema::record::Header,
        input_body: Value,
        stored_ids: Vec<ItemId>,
        prior: Vec<Value>,
        goal_reminder: Option<mixdog_core_session::session::goal_reminder::GoalReminder>,
        carried_notice: mixdog_core_session::session::prompt_notice::CarriedNotice,
        hints: ToolHints,
        rebound: bool,
        rebind_owed: bool,
        preflight_loop: Option<super::PreflightLoop>,
        agent_refusal: Option<String>,
        already_carried: bool,
        committed_after_input: Vec<(ItemId, Value)>,
        carried_guards: Option<Arc<dyn TurnGuards>>,
        switch_notice: Option<String>,
    }
    enum NextPhase {
        Outside(Box<Outside>),
        Loop(Box<LoopState>),
    }

    let outside = parts.outside_agents();
    let mut phase = match parts.preflight_turn(&thread, &turn, &header, &cancel).await {
        Ok(super::PreflightTurn::Cancelled { switch_events }) => {
            if !switch_events.is_empty() {
                let closing = port.closing();
                for event in switch_events {
                    let _ = closing.stage("route_switch".to_owned(), Some(event.to_value())).await;
                }
            }
            return RunOutcome::Interrupted;
        }
        Ok(super::PreflightTurn::Outside { header: next_header, notice, switch_events, leave_old_agent }) => {
            if !switch_events.is_empty() {
                let closing = port.closing();
                for event in switch_events {
                    let _ = closing.stage("route_switch".to_owned(), Some(event.to_value())).await;
                }
            }
            if let Some(agents) = outside.clone() {
                let mut next_header = next_header;
                if leave_old_agent {
                    let closing = port.closing();
                    match leave_agent(agents.as_ref(), &thread, &header, &closing, &handover).await {
                        Ok(Some(change)) => apply_header_change(&mut next_header, change),
                        Ok(None) => {}
                        Err(()) => return failed(LEAVE_FAILED, Value::Null),
                    }
                    if cancel.is_cancelled() || signal.is_aborted() {
                        if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                            return failed(signal.reason(), Value::Null);
                        }
                        close_stopped_prompt(&closing, &input_item, &input_body, signal.close_reason()).await;
                        return RunOutcome::Interrupted;
                    }
                }
                if let Some(notice) = notice {
                    let _ = port.notice(notice, mixdog_agent::env::Tone::Info).await;
                }
                let header = next_header;
                if header.get("owner").and_then(Value::as_str) == Some("agent") {
                    let route =
                        ["provider", "model", "effort", "fast"].into_iter().filter_map(|key| Some((key.to_owned(), header.get(key)?.clone()))).collect();
                    liveness.publish_request_route(thread.as_str(), route);
                }
                NextPhase::Outside(Box::new(Outside {
                    parts: parts.clone(),
                    agents,
                    thread: thread.clone(),
                    turn: turn.clone(),
                    header,
                    port: port.clone(),
                    context: context.clone(),
                    surface: surface.clone(),
                    progress: progress.clone(),
                    tool_progress: tool_progress.clone(),
                    hints,
                    cancel: cancel.clone(),
                    signal: signal.clone(),
                    review: review.clone(),
                    input_body,
                    input_item: input_item.clone(),
                    stored_ids,
                    prior,
                    injected,
                    goal_reminder,
                    notice: carried_notice,
                    transcript: turn_transcript.clone(),
                    turn_context: turn_context.clone(),
                    unattended,
                    generation,
                    request: request.clone(),
                    asked: asked.clone(),
                    handover: handover.clone(),
                    rebound,
                    rebind_owed,
                    slot: slot.clone(),
                    notify: notify.clone(),
                    on_tool_result: on_tool_result.clone(),
                    taken_over: None,
                    loop_produced: false,
                    guards: None,
                    skill_selection: skill_selection.clone(),
                    committed_after_input: Vec::new(),
                    already_carried: false,
                }))
            } else {
                return failed("the selected route requires an outside agent host", Value::Null);
            }
        }
        Ok(super::PreflightTurn::Loop(landed)) => NextPhase::Loop(Box::new(LoopState {
            header,
            input_body,
            stored_ids,
            prior,
            goal_reminder,
            carried_notice,
            hints,
            rebound,
            rebind_owed,
            preflight_loop: Some(*landed),
            agent_refusal: None,
            already_carried: false,
            committed_after_input: Vec::new(),
            carried_guards: None,
            switch_notice: None,
        })),
        Ok(super::PreflightTurn::Continue) => {
            let mut agent_refusal = None;
            if let Some(agents) = outside.clone()
                && agents.serves(&header)
            {
                agent_refusal = agents.refusal(&header);
                if agent_refusal.is_none() {
                    if header.get("owner").and_then(Value::as_str) == Some("agent") {
                        let route =
                            ["provider", "model", "effort", "fast"].into_iter().filter_map(|key| Some((key.to_owned(), header.get(key)?.clone()))).collect();
                        liveness.publish_request_route(thread.as_str(), route);
                    }
                    NextPhase::Outside(Box::new(Outside {
                        parts: parts.clone(),
                        agents,
                        thread: thread.clone(),
                        turn: turn.clone(),
                        header,
                        port: port.clone(),
                        context: context.clone(),
                        surface: surface.clone(),
                        progress: progress.clone(),
                        tool_progress: tool_progress.clone(),
                        hints,
                        cancel: cancel.clone(),
                        signal: signal.clone(),
                        review: review.clone(),
                        input_body,
                        input_item: input_item.clone(),
                        stored_ids,
                        prior,
                        injected,
                        goal_reminder,
                        notice: carried_notice,
                        transcript: turn_transcript.clone(),
                        turn_context: turn_context.clone(),
                        unattended,
                        generation,
                        request: request.clone(),
                        asked: asked.clone(),
                        handover: handover.clone(),
                        rebound,
                        rebind_owed,
                        slot: slot.clone(),
                        notify: notify.clone(),
                        on_tool_result: on_tool_result.clone(),
                        taken_over: None,
                        loop_produced: false,
                        guards: None,
                        skill_selection: skill_selection.clone(),
                        committed_after_input: Vec::new(),
                        already_carried: false,
                    }))
                } else {
                    NextPhase::Loop(Box::new(LoopState {
                        header,
                        input_body,
                        stored_ids,
                        prior,
                        goal_reminder,
                        carried_notice,
                        hints,
                        rebound,
                        rebind_owed,
                        preflight_loop: None,
                        agent_refusal,
                        already_carried: false,
                        committed_after_input: Vec::new(),
                        carried_guards: None,
                        switch_notice: None,
                    }))
                }
            } else {
                NextPhase::Loop(Box::new(LoopState {
                    header,
                    input_body,
                    stored_ids,
                    prior,
                    goal_reminder,
                    carried_notice,
                    hints,
                    rebound,
                    rebind_owed,
                    preflight_loop: None,
                    agent_refusal,
                    already_carried: false,
                    committed_after_input: Vec::new(),
                    carried_guards: None,
                    switch_notice: None,
                }))
            }
        }
        Err(error) => return RunOutcome::Failed(error),
    };

    'drive: loop {
        let LoopState {
            header,
            input_body,
            stored_ids,
            prior,
            goal_reminder,
            carried_notice,
            hints,
            rebound,
            rebind_owed,
            preflight_loop,
            agent_refusal,
            already_carried,
            committed_after_input,
            carried_guards,
            mut switch_notice,
        } = match phase {
            NextPhase::Outside(mut outside_run) => loop {
                match drive_outside_boxed(*outside_run).await {
                    super::outside::OutsideOutcome::Done(outcome) => return outcome,
                    super::outside::OutsideOutcome::SwitchOutside { header: mut next_header, notice, switch_bus, state } => {
                        let closing = port.closing();
                        if let Some(agents) = outside.clone() {
                            match leave_agent(agents.as_ref(), &thread, &state.old_header, &closing, &handover).await {
                                Ok(Some(change)) => apply_header_change(&mut next_header, change),
                                Ok(None) => {}
                                Err(()) => {
                                    flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                                    return failed(LEAVE_FAILED, Value::Null);
                                }
                            }
                            flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                            if cancel.is_cancelled() || signal.is_aborted() {
                                if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                                    return failed(signal.reason(), Value::Null);
                                }
                                close_stopped_prompt(&closing, &input_item, &state.input_body, signal.close_reason()).await;
                                return RunOutcome::Interrupted;
                            }
                            if let Some(notice) = notice {
                                let _ = port.notice(notice, mixdog_agent::env::Tone::Info).await;
                            }
                            if next_header.get("owner").and_then(Value::as_str) == Some("agent") {
                                let route = ["provider", "model", "effort", "fast"]
                                    .into_iter()
                                    .filter_map(|key| Some((key.to_owned(), next_header.get(key)?.clone())))
                                    .collect();
                                liveness.publish_request_route(thread.as_str(), route);
                            }
                            *outside_run = Outside {
                                parts: parts.clone(),
                                agents,
                                thread: thread.clone(),
                                turn: turn.clone(),
                                header: next_header,
                                port: port.clone(),
                                context: context.clone(),
                                surface: surface.clone(),
                                progress: progress.clone(),
                                tool_progress: tool_progress.clone(),
                                hints: ToolHints::start(progress.subscribe(), port.clone()),
                                cancel: cancel.clone(),
                                signal: signal.clone(),
                                review: review.clone(),
                                input_body: state.input_body,
                                input_item: input_item.clone(),
                                stored_ids: state.stored_ids,
                                prior: state.prior,
                                injected,
                                goal_reminder: state.goal_reminder,
                                notice: state.notice,
                                transcript: turn_transcript.clone(),
                                turn_context: turn_context.clone(),
                                unattended,
                                generation,
                                request: request.clone(),
                                asked: asked.clone(),
                                handover: handover.clone(),
                                rebound: false,
                                rebind_owed: false,
                                slot: slot.clone(),
                                notify: notify.clone(),
                                on_tool_result: on_tool_result.clone(),
                                taken_over: None,
                                loop_produced: false,
                                guards: Some(state.guards),
                                skill_selection: skill_selection.clone(),
                                committed_after_input: state.committed_after_input,
                                already_carried: true,
                            };
                        } else {
                            flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                            return failed("the selected route requires an outside agent host", Value::Null);
                        }
                    }
                    super::outside::OutsideOutcome::SwitchLoop { preflight, notice, state } => {
                        if cancel.is_cancelled() || signal.is_aborted() {
                            let closing = port.closing();
                            if let Some(agents) = &outside
                                && preflight.leave_old_agent
                            {
                                let _ = leave_agent(agents.as_ref(), &thread, &state.old_header, &closing, &handover).await;
                            }
                            flush_buffered_switches(Some(&preflight.switch_bus), &closing).await;
                            if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                                return failed(signal.reason(), Value::Null);
                            }
                            close_stopped_prompt(&closing, &input_item, &state.input_body, signal.close_reason()).await;
                            return RunOutcome::Interrupted;
                        }
                        break LoopState {
                            header: state.old_header,
                            input_body: state.input_body,
                            stored_ids: state.stored_ids,
                            prior: state.prior,
                            goal_reminder: state.goal_reminder,
                            carried_notice: state.notice,
                            hints: ToolHints::start(progress.subscribe(), port.clone()),
                            rebound: false,
                            rebind_owed: false,
                            preflight_loop: Some(*preflight),
                            agent_refusal: None,
                            already_carried: true,
                            committed_after_input: state.committed_after_input,
                            carried_guards: Some(state.guards),
                            switch_notice: notice,
                        };
                    }
                }
            },
            NextPhase::Loop(state) => *state,
        };
        let quiet_changes = progress.subscribe();
        let watched = progress.subscribe();
        let switch_bus = preflight_loop.as_ref().map(|p| p.switch_bus.clone());
        // A route that hops off an agent leaves it once the hop is made: with no fallback the turn fails, and the session
        // keeps the agent's own session for the turn the agent can run.
        let mut header = header;
        let leave_after_assemble = preflight_loop.as_ref().map_or_else(|| agent_refusal.is_some(), |p| p.leave_old_agent);
        if let Some(agents) = &outside
            && !leave_after_assemble
        {
            match leave_agent(agents.as_ref(), &thread, &header, &port, &handover).await {
                Ok(Some(change)) => apply_header_change(&mut header, change),
                Ok(None) => {}
                Err(()) => {
                    flush_buffered_switches(switch_bus.as_ref(), &port).await;
                    return failed(LEAVE_FAILED, Value::Null);
                }
            }
        }
        let surface_now = surface.borrow().clone();
        let assemble_input = AssembleInput {
            thread: &thread,
            turn: &turn,
            header: &header,
            surface: surface_now,
            port: &port,
            surface_rx: surface.clone(),
            slot: slot.clone(),
            skill_selection: skill_selection.clone(),
            prior: &prior,
            generation,
            request: &request,
            injected,
            cancel: &cancel,
            unattended,
            notify: notify.clone(),
            progress: tool_progress.clone(),
            agent_refusal: agent_refusal.as_deref(),
            guards: carried_guards,
        };
        let landed_leave = preflight_loop.as_ref().is_some_and(|p| p.landed && p.leave_old_agent);
        let assembled = match preflight_loop {
            Some(preflight) => parts.assemble_preflight(assemble_input, preflight).await,
            None => parts.assemble(assemble_input).await,
        };
        let mut assembled = match assembled {
            Ok(assembled) => assembled,
            Err(error) => {
                let closing = port.closing();
                if let Some(agents) = &outside
                    && landed_leave
                {
                    let _ = leave_agent(agents.as_ref(), &thread, &header, &closing, &handover).await;
                }
                flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                return RunOutcome::Failed(error);
            }
        };
        if let Some(agents) = &outside
            && leave_after_assemble
        {
            let closing = port.closing();
            match leave_agent(agents.as_ref(), &thread, &header, &closing, &handover).await {
                Ok(Some(change)) => apply_header_change(&mut assembled.header, change),
                Ok(None) => {}
                Err(()) => {
                    flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                    return failed(LEAVE_FAILED, Value::Null);
                }
            }
            if cancel.is_cancelled() || signal.is_aborted() {
                flush_buffered_switches(switch_bus.as_ref(), &closing).await;
                if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                    return failed(signal.reason(), Value::Null);
                }
                close_stopped_prompt(&closing, &input_item, &input_body, signal.close_reason()).await;
                return RunOutcome::Interrupted;
            }
        }
        if let Some(notice) = switch_notice.take() {
            let _ = port.notice(notice, mixdog_agent::env::Tone::Info).await;
        }
        // From here the turn is on the header it was assembled on: a preflight fallback landed it on another route.
        let Assembled {
            header,
            provider,
            tools,
            tool_env,
            gate,
            worktree,
            mut config,
            clock,
            decider,
            guards,
            compactor,
            route,
            skills,
            hooks,
            reuse,
            reactions,
            reaction_scope: _reaction_scope,
            rows,
            tail,
            side,
            step_judge,
            artifacts,
            images,
            failures,
            blobs,
            carry,
        } = assembled;
        // The actor incarnation's guard: the request its last completed turn settled on, on this lineage (a route switch or a
        // rewrite names a new one); a replacement actor holds none.
        let mut carry = carry;
        carry.prefix_guard = prefix_guard.for_header(&header);
        let failures = failures.map(|inner| Arc::new(SensitiveFailures { inner, context: context.clone() }) as Arc<dyn mixdog_agent::env::ToolFailureLog>);
        // The turn's tools publish each edit's card diff to the same review (`registerEditToolUiDiff`).
        let mut tool_env = tool_env;
        tool_env.review = Some(review.api());
        // The turn's workspace is final: take the baseline in the background; no tool runs before it.
        review.start(&worktree);
        let (input_body, retried) = if already_carried {
            let mut input_body = input_body;
            stamp_outgoing_effort(&mut input_body, &config);
            (input_body, false)
        } else {
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
                notice: &carried_notice,
                hidden_agent: config.hidden_agent,
                config: Some(&config),
                clock: &clock,
                blobs: &blobs,
                guards: &guards,
                rebound,
                rebind_owed,
            })
            .await;
            match carried {
                Ok(carried) => carried,
                Err(outcome) => {
                    flush_buffered_switches(switch_bus.as_ref(), &port).await;
                    return outcome;
                }
            }
        };
        let input = match message_of(&input_body) {
            Ok(input) => input,
            Err(error) => {
                flush_buffered_switches(switch_bus.as_ref(), &port).await;
                return failed(format!("the turn's input row is not a model message: {error}"), input_body);
            }
        };
        let live = LiveTurnPublisher::new(turn_messages.clone());
        let streaming = Arc::new(Mutex::new(Segments::default()));
        let stamp = TurnStamp::of(&input_body, verb, clock.now_ms());
        let observed = Arc::new(Mutex::new(Observed::default()));
        let applied = AppliedSkills { parts: parts.clone(), thread: thread.clone(), input: (input.message_id.clone(), input_item.clone()) };
        let (shown_tx, shown_rx) = mpsc::unbounded_channel::<Shown>();
        let sink = PortSink::spawn(
            port.clone(),
            rows.clone(),
            live.clone(),
            (streaming.clone(), observed.clone()),
            (clock.clone(), blobs),
            (on_tool_result.clone(), shown_tx.clone()),
            (stamp, applied),
        );
        // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
        let mut messages = system_messages(&header);
        // The context before the input row with the item each message is, for the rewrite a cancelled turn ends with: each
        // message as its stored row (shared with the message), read back into the message only if the turn is cancelled, so
        // the turn holds no second copy of the conversation. The sink keeps it, and a rewrite of the context replaces it.
        let mut history: Vec<(ItemId, HistoryRow)> = Vec::new();
        let mut leading = true;
        for (iid, body) in stored_ids.into_iter().zip(prior) {
            // A stored row the codec cannot read fails the turn: dropping it would change the context. The row becomes the
            // message's own `stored` and the turn's registered body at once (one copy, shared).
            let message = match mixdog_agent::message_row::message_of_owned(body) {
                Ok(message) => message,
                Err((error, body)) => {
                    flush_buffered_switches(switch_bus.as_ref(), &port).await;
                    return failed(format!("the model context holds a row this build cannot read: {error}"), body);
                }
            };
            if leading && is_stale_system_row(&message) {
                continue;
            }
            leading = false;
            if let Some(id) = &message.message_id {
                lock(&sink.iids).insert(id.clone(), iid.clone());
            }
            history.push((iid, HistoryRow::held(&message)));
            rows.record_stored(&message);
            messages.push(message);
        }
        sink.restart(history);
        let input_text = input.text();
        if let Some(id) = &input.message_id {
            lock(&sink.iids).insert(id.clone(), input_item.clone());
        }
        rows.record(&input, input_body);
        sink.seed(&input);
        messages.push(input);
        let preloaded_after_input = committed_after_input.clone();
        for (iid, body) in committed_after_input {
            let message = match mixdog_agent::message_row::message_of_owned(body) {
                Ok(message) => message,
                Err((error, body)) => {
                    flush_buffered_switches(switch_bus.as_ref(), &port).await;
                    return failed(format!("the model context holds a row this build cannot read: {error}"), body);
                }
            };
            if let Some(id) = &message.message_id {
                lock(&sink.iids).insert(id.clone(), iid);
            }
            rows.record_stored(&message);
            messages.push(message);
        }

        let progress_pub = Arc::new(ProgressPublisher::new(progress.clone(), clock.clone()));
        progress_pub.ask_start();
        let asked_at = clock.now_ms();
        // The progress watchdog judges the model work from the ask on, and only a run no person is
        // attached to (Node arms it per worker turn once the ask has started).
        let watchdog = if unattended {
            // The assembled route's model and parameters: the provider is the one the assembly chose, which a preflight fallback
            // moved off the header this turn started from.
            let budget = provider.first_response_budget(&config.model, config.options.model_parameters.as_ref().filter(|parameters| parameters.is_object()));
            let watched_turn = Watched {
                parts: &parts,
                thread: &thread,
                header: &header,
                hidden_agent: config.hidden_agent,
                budget,
                signal: &signal,
                clock: &clock,
                failures: failures.clone(),
                asked_at,
            };
            arm_watchdog(watched_turn, move |now| watched.borrow().snapshot(now)).await
        } else {
            None
        };
        // The quiet-time cue of a turn a person watches (`startQuietWatch` in the lead turn, `turn.mjs:781`), against the lead's warn point.
        let quiet_watch = (!unattended).then(|| {
            let warn_ms = mixdog_agent::agent_tool::watchdog::stall_warn_ms(AgentKind { name: Some("lead"), ..AgentKind::default() }, &|name: &str| {
                std::env::var(name).ok()
            });
            QuietWatch::start(quiet_changes, port.clone(), clock.clone(), Arc::new(TimerWait), warn_ms as f64)
        });
        flush_buffered_switches(switch_bus.as_ref(), &port).await;
        if let Some(bus) = &switch_bus {
            bus.attach(shown_tx.clone());
        }
        let forwarder = spawn_forwarder(port.clone(), shown_rx, cancel.clone());
        // `registerNativeWebSearchUsageSink(session.id, options.onNativeWebSearchUsage)` (`turn-run.mjs`): from the first send to the
        // ask's end the newest entry of this thread's session hears every search the turn runs, in the order the other reports reach the port.
        let search_tx = shown_tx.clone();
        let hears_search = search_usage.register(
            thread.as_str(),
            Arc::new(move |delta| {
                let _ = search_tx.send(Shown::SearchUsage(delta));
            }),
        );
        let agent_route = (header.get("owner").and_then(Value::as_str) == Some("agent")).then(|| (liveness.clone(), thread.clone()));
        let observer = Arc::new(PortObserver {
            observed: observed.clone(),
            progress: progress_pub.clone(),
            out: shown_tx,
            streaming,
            reasoning: Mutex::new(None),
            last_send_tools: Mutex::new(Default::default()),
            chunked: Default::default(),
            live: live.clone(),
            rows: rows.clone(),
            cancel: cancel.clone(),
            requests: std::sync::atomic::AtomicU32::new(0),
            streamed_calls: Mutex::new(Vec::new()),
            held_early: Mutex::new(None),
            task_waits: Mutex::default(),
            context: context.clone(),
            sink: sink.clone(),
            transcript: turn_transcript.clone(),
            agent_route,
        });
        let closing = observer.clone();

        config.thread_id = thread.clone();
        config.turn_id = turn.clone();
        config.signal = Some(signal.clone());
        config.first_request_after = Some(Ticket(0));
        config.select_input_skills = !injected && !retried && !already_carried;
        // Only the gate's refusal (a stale request) reloads the history: a run without one has nothing to reload for.
        config.history = config
            .options
            .tail_gate
            .clone()
            .map(|gate| Arc::new(ReloadedHistory { sink: sink.clone(), context: context.clone(), gate }) as Arc<dyn mixdog_agent::env::StoredHistory>);
        let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(
            review.clone(),
            gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: Arc::new(port.clone()) }),
        ));
        let skills = skills.map(|build| build(SkillContext { gate: gate.clone(), env: tool_env.clone(), cancel: cancel.clone() }));
        let guard_state = guards.clone();
        let env = RunEnv {
            clock,
            jitter: Arc::new(RandomJitter),
            waiter: Arc::new(TimerWait),
            decider,
            steer: Arc::new(SteerQueue::new(port.clone())),
            observer,
            sink: sink.clone(),
            gate,
            guards,
            compactor: compactor
                .map(|inner| Arc::new(super::super::goal_reminder_compactor::GoalReminderCompactor::new(inner, port.clone())) as Arc<dyn Compactor>),
            route,
            skills,
            hooks,
            reuse,
            reactions,
            tail,
            mcp: Some(Arc::new(ThreadMcp { parts: parts.clone(), thread: thread.clone(), surface: surface.clone() })),
            side,
            step_judge,
            artifacts,
            images,
            failures,
        };
        // The loop closes a stop from here on (`close_cancelled`); one that ended the setup above is `BeforeLoop`'s.
        asked.store(true, Ordering::SeqCst);
        // Node's `_api_call_with_interrupt` spans `agentLoop`: an abort inside reads "during call".
        progress_pub.model_loop(true);
        let result = run_agent_boxed(Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry)).await;
        progress_pub.model_loop(false);
        // `releaseWebSearchUsage?.()` after `askSession`.
        drop(hears_search);
        // The model work is over: the watchdog, which judges only that, stops here.
        drop(watchdog);
        closing.end_reasoning();
        // No hint is published once the run's outcome is on its way: the run owns the runtime section.
        hints.finish().await;
        if let Some(quiet_watch) = quiet_watch {
            quiet_watch.finish().await;
        }
        // The guard state that outlives one ask lives on the session record (`session.todoCheck`, `session._repeat*`).
        // The run is over: what it leaves is saved whenever its token fires, before or after now (Node saves after the abort,
        // `finalizeCancelledTurn`, and settles a finished ask whatever a later stop does).
        let end_port = port.closing();
        let saved = {
            let carry = match &result {
                Ok(output) => &output.carry,
                Err(failure) => &failure.carry,
            };
            let mut set = carry.to_saved();
            if let Some(check) = guard_state.saved() {
                set.insert("todoCheck".into(), check);
            }
            // The turn's result as its owner gets it, whether or not its last reply has text: what the stored readers return.
            // A turn that did not finish leaves none, so they fall back to its rows.
            let mut unset = Vec::new();
            match &result {
                Ok(output) => {
                    let report = output.response.report_content.as_deref().unwrap_or(&output.response.content);
                    set.insert("lastHandoff".into(), Value::String(context.redact_text(report)));
                    set.insert("lastHandoffTurn".into(), Value::String(turn.as_str().to_owned()));
                }
                Err(_) => unset.extend(["lastHandoff".to_owned(), "lastHandoffTurn".to_owned()]),
            }
            let saved = mixdog_store::schema::record::HeaderChange { set, unset, patch: Default::default() };
            let _ = end_port.save_header(saved.clone()).await;
            let kept = match &result {
                Ok(output) => output.carry.prefix_guard.clone(),
                Err(_) => None,
            };
            prefix_guard.keep(kept);
            saved
        };
        match result {
            Ok(output) => {
                // The loop ends on the terminal answer without committing it (Node's turn commit does):
                // history keeps only the terminal segment.
                let mut terminal = output.response.clone();
                if let Some(segment) = &output.response.history_content {
                    terminal.content.clone_from(segment);
                }
                let mut transcript = output.transcript.clone();
                if let Some(mut message) = mixdog_agent::response::intermediate_message(&terminal) {
                    message.message_id = Some(sink.message_id());
                    message.turn_reminder.clone_from(&output.last_reminder);
                    *lock(&sink.terminal) = Some((output.iterations, output.tool_calls_total));
                    if let Err(error) = sink.commit(&message).await {
                        sink.flush().await;
                        // The turn ends once what it produced is forwarded, its media preparations done ([`Preparation`]).
                        let _ = closing.barrier().await;
                        if cancel.is_cancelled() {
                            let _ = forwarder.await;
                        }
                        flush_buffered_switches(switch_bus.as_ref(), &port).await;
                        sink.live.clear();
                        progress_pub.error();
                        return failed(error.to_string(), Value::Null);
                    }
                    transcript.push(message);
                }
                sink.flush().await;
                // `settleAskTurn`: the ask's usage and transcript reach the header once every call's report
                // has (the port's lane keeps their order). Every media preparation of the turn is done by then ([`Preparation`]).
                let _ = closing.barrier().await;
                if cancel.is_cancelled() {
                    let _ = forwarder.await;
                }
                flush_buffered_switches(switch_bus.as_ref(), &port).await;
                let settled = mixdog_core_session::session::run::Settled {
                    transcript,
                    usage: output.usage.clone(),
                    last_turn_usage: output.last_turn_usage.clone(),
                    tool_calls_total: output.tool_calls_total,
                    send_tools: lock(&closing.last_send_tools).clone(),
                    response_model: output.response.model.clone(),
                    asked_at_ms: asked_at,
                    input_excludes_cache: output.input_excludes_cache,
                };
                let _ = end_port.settled(settled).await;
                // `transcript.appendFinalAssistant(result)` (`turn-settle.mjs:44`): `historyContent ?? content`.
                if let Some(turn_transcript) = &turn_transcript {
                    turn_transcript.final_text(output.response.history_content.as_deref().unwrap_or(&output.response.content));
                }
                // The `Stop` hook is not asked here: the agent loop asks it when the model ends its turn, so a block can
                // continue the turn (owner-approved difference from Node's `completeTurn`).
                sink.live.clear();
                progress_pub.done(output.response.content.trim().is_empty());
                if let Some(state) = output.provider_state.clone() {
                    let _ = end_port.save_provider_state(Some(state)).await;
                }
                return RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                    content: output.response.content.clone(),
                    report_content: output.response.report_content.clone(),
                    termination: output.termination,
                    iterations: output.iterations,
                    tool_calls_total: output.tool_calls_total,
                    stop_reason: output.response.stop.as_ref().map(super::super::message_row::stop_name),
                }));
            }
            Err(failure) => {
                sink.flush().await;
                // The turn ends once what it produced is forwarded, its media preparations done ([`Preparation`]); a cancelled run's
                // forwarder is gone already, and this answers at once.
                let _ = closing.barrier().await;
                if cancel.is_cancelled() {
                    let _ = forwarder.await;
                }
                flush_buffered_switches(switch_bus.as_ref(), &port).await;
                sink.live.clear();
                // The watchdog's abort is a stalled failure, not a user's interrupt: its sentence is
                // the error, and the partial output the sink just flushed goes to the owner.
                if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                    // The turn has unwound: sweep what it registered while stopping (`reapTurnShellJobs`).
                    parts.reap_turn_shells(&thread, asked_at);
                    close_stalled(&end_port, &sink, &rows, &observed).await;
                    progress_pub.error();
                    return failed(signal.reason(), Value::Null);
                }
                if matches!(failure.error, AgentError::Aborted) || cancel.is_cancelled() {
                    progress_pub.cancelling();
                    close_cancelled(&end_port, &sink, &rows, (&input_item, &input_text), &observed, signal.close_reason()).await;
                    return RunOutcome::Interrupted;
                }
                // A route hop moved the session onto an outside agent's route: the turn goes on on that agent, from what the run
                // left of it, as a provider's fallback goes on from it.
                if let AgentError::Outside(moved) = &failure.error
                    && let Some(agents) = outside.clone().filter(|agents| agents.serves(&moved.header))
                {
                    let mut header = moved.header.clone();
                    for key in &saved.unset {
                        header.shift_remove(key);
                    }
                    header.extend(saved.set);
                    if header.get("owner").and_then(Value::as_str) == Some("agent") {
                        let route =
                            ["provider", "model", "effort", "fast"].into_iter().filter_map(|key| Some((key.to_owned(), header.get(key)?.clone()))).collect();
                        liveness.publish_request_route(thread.as_str(), route);
                    }
                    let left = left_turn(&sink, &rows, &input_item, &preloaded_after_input);
                    let (stored_ids, prior) = left.ahead.into_iter().unzip();
                    phase = NextPhase::Outside(Box::new(Outside {
                        parts: parts.clone(),
                        agents,
                        thread: thread.clone(),
                        turn: turn.clone(),
                        header,
                        port: port.clone(),
                        context: context.clone(),
                        surface: surface.clone(),
                        hints: ToolHints::start(progress.subscribe(), port.clone()),
                        progress: progress.clone(),
                        tool_progress: tool_progress.clone(),
                        cancel: cancel.clone(),
                        signal: signal.clone(),
                        review: review.clone(),
                        input_body: left.input,
                        input_item: input_item.clone(),
                        stored_ids,
                        prior,
                        injected,
                        goal_reminder,
                        notice: carried_notice,
                        transcript: turn_transcript.clone(),
                        turn_context: turn_context.clone(),
                        unattended,
                        generation,
                        request: request.clone(),
                        asked: asked.clone(),
                        handover: handover.clone(),
                        rebound: false,
                        rebind_owed: false,
                        slot: slot.clone(),
                        notify: notify.clone(),
                        on_tool_result: on_tool_result.clone(),
                        taken_over: Some(left.taken_over),
                        loop_produced: left.produced,
                        guards: Some(guard_state),
                        skill_selection: skill_selection.clone(),
                        committed_after_input: left.committed_after_input,
                        already_carried: true,
                    }));
                    continue 'drive;
                }
                // The turn's terminal error: a provider timeout or stall that ended it (a retry the turn recovered from never
                // reaches here) stops its shell work, while nothing else stopped the turn first
                // (`armTurnTimeoutOnProviderError` then `reapTurnShellJobs`, `ask-session.mjs`).
                if !signal.is_aborted() && matches!(&failure.error, AgentError::Provider(error) if provider_timeout_or_stall(error)) {
                    parts.reap_turn_shells(&thread, asked_at);
                }
                progress_pub.error();
                let data = if failure.carried_report.is_empty() { Value::Null } else { json!({ "carriedReport": failure.carried_report }) };
                // A provider's refusal keeps what `turnFailureRecord` reads off it: kind, status, code, retry advice and
                // reset (`provider_turn_error`), named for the provider the run ended on; any other failure is its message.
                if let AgentError::Provider(error) = &failure.error {
                    return RunOutcome::Failed(provider_turn_error(error, &failure.provider, data));
                }
                // The guard's refusal reads as `Session state changed unexpectedly.` (`err-text.mjs:274`, by its code).
                if matches!(failure.error, AgentError::PrefixMutation(_)) {
                    return failed("Session state changed unexpectedly.".to_owned(), data);
                }
                return failed(failure.error.to_string(), data);
            }
        }
    }
}
