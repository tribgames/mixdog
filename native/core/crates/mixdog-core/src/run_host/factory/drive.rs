//! One turn's drive: setup, the loop run and its outcome.

use super::*;

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
                let port = self.port.closing();
                if let Ok(input) = message_of(&self.input_body) {
                    let (rewound, following) = stopped_prompt(&input, self.signal.close_reason());
                    if rewound {
                        // A row the thread shows under another id is taken by the actor when the turn closes (`apply_reclaim`).
                        if let Err(error) = port.prompt_rewound(self.input_item.clone()).await {
                            tracing::warn!("[session] rewound prompt save failed: {error:?}");
                        }
                    }
                    for message in &following {
                        let item =
                            ItemCommit { iid: new_item_id(), role: Some("user".to_owned()), model: true, visible: false, body: row_of(message), prompt: None };
                        if let Err(error) = port.commit_item(item).await {
                            tracing::warn!("[session] interrupted turn row save failed: {error:?}");
                        }
                    }
                }
                RunOutcome::Interrupted
            }
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

pub(super) async fn drive_turn(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
    asked: Arc<std::sync::atomic::AtomicBool>,
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
    let quiet_changes = progress.subscribe();
    let watched = progress.subscribe();
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
    let rejoined = |ids: &[ItemId], bodies: &[Value]| -> Vec<(ItemId, Value)> { ids.iter().cloned().zip(bodies.iter().cloned()).collect() };
    let injected = input_body.pointer("/meta/source").is_some_and(Value::is_string);
    // Node's `await reconcileTurnSettings()` of the turn preparation: a gate that moved since the last turn
    // reaches this one through the header, before the request is assembled.
    let header = match parts.reconcile_turn(&thread, header, mixdog_core_session::session::thread_settings::has_conversation_messages(&prior)).await {
        Ok(header) => header,
        Err(error) => return RunOutcome::Failed(error),
    };
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
    let surface_now = surface.borrow().clone();
    let assembled = match parts
        .assemble(AssembleInput {
            thread: &thread,
            turn: &turn,
            header: &header,
            surface: surface_now,
            port: &port,
            surface_rx: surface.clone(),
            slot,
            skill_selection,
            prior: &prior,
            generation,
            request: &request,
            injected,
            cancel: &cancel,
            unattended,
            notify,
            progress: tool_progress,
        })
        .await
    {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    let Assembled {
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
    // `backfillFallbackSessionTitle` (`precommitUserTurn`, `ask-turn-execute.mjs`): a titleless session is named
    // from the earliest human turn of its history, else this turn's prompt (an injected turn never names it),
    // before the first save.
    let prompt = (!injected).then(|| json!({ "role": "user", "content": input_body.get("content").cloned().unwrap_or(Value::Null) }));
    if let Some(change) = mixdog_core_session::session::session_title::fallback_title_change(&header, &prior, prompt.as_ref(), clock.now_ms())
        && port.save_header(change).await.is_err()
    {
        return failed("the session's title could not be saved", Value::Null);
    }
    // The turn's tools publish each edit's card diff to the same review (`registerEditToolUiDiff`).
    let mut tool_env = tool_env;
    tool_env.review = Some(review.api());
    // The turn's workspace is final: take the baseline in the background; no tool runs before it.
    review.start(&worktree);

    // `buildUserTurn` (`ask-turn-prepare.mjs:147-246`): the reminders staged on the conversation (a workflow or an
    // orchestration mode switch, moved settings, a changed agent list or working folder, a prepared worktree, a
    // deferred-tool delta, the Goal) and the ones this prompt earns (the current time, a delegated agent's todo start)
    // ride this turn once, as the user message's reminder suffix. The message is kept as it was sent (the context the
    // next turns replay, and a retry resubmits), and the actor acknowledges the revisions when the turn is accepted
    // (`ask-turn-settle.mjs:148-164`); a failed turn leaves them pending.
    let mut input_body = input_body;
    let current_agents = match parts.current_agents(&thread, &header).await {
        Ok(agents) => agents,
        Err(error) => return RunOutcome::Failed(error),
    };
    // A retried failed turn resends its own message as it is (`retainedUserTurn`, `ask-turn-execute.mjs:38-69`): it
    // keeps the reminders it was built with, learns the agents changed since, and acknowledges its settings notice only.
    let retried = super::super::turn_reminders::is_retained(&input_body);
    let (mut carried, revisions) = if retried {
        match super::super::turn_reminders::resubmit(&input_body, &header, &prior, current_agents.as_deref()) {
            Ok(resent) => resent,
            Err(text) => return failed(text, input_body),
        }
    } else {
        let mode_instructions = match super::super::turn_reminders::carried_mode(&header) {
            Some(mode) => match parts.orchestration_instructions(&mode).await {
                Ok(text) => Some(text),
                Err(error) => return RunOutcome::Failed(error),
            },
            None => None,
        };
        // `promptContentText(prompt)`: a stored text attachment is read from the store; one that cannot be read fails the turn.
        let prompt_content = input_body.get("content").cloned().unwrap_or(Value::Null);
        let prompt_text = match with_blobs_if_read(&*blobs, move |store| super::super::turn_reminders::prompt_content_text(&prompt_content, store)).await {
            Ok(Ok(text)) => text,
            Ok(Err(text)) => return failed(text, input_body),
            Err(error) => return failed(error.to_string(), input_body),
        };
        let facts = super::super::turn_reminders::Facts {
            header: &header,
            prior: &prior,
            prompt_text: &prompt_text,
            genuine: !injected,
            current_agents: current_agents.as_deref(),
            mode_instructions: mode_instructions.as_deref(),
            goal: goal_reminder.as_ref().map(|reminder| reminder.content.as_str()),
            hidden_agent: config.hidden_agent,
            now_ms: clock.now_ms() as f64,
        };
        let reminders = match super::super::turn_reminders::build(&facts) {
            Ok(reminders) => reminders,
            Err(text) => return failed(text, input_body),
        };
        // `prefixUserTurnContent(prompt, contextBlock)` (`buildUserTurn`): the turn's context leads the prompt, the reminders
        // trail it. A retried turn resends its message as it was built (`retainedUserTurn` reads no context).
        let Some(carried) = super::super::lifecycle_hooks::with_turn_context(&input_body, &turn_context).and_then(|message| reminders.carry(&message)) else {
            return failed("the turn's input row cannot carry the turn's reminders".to_owned(), input_body);
        };
        (carried, reminders.revisions)
    };
    stamp_outgoing_effort(&mut carried, &config);
    // Told means sent: the one point where the start reminder is on the outgoing message, built now or retained from the
    // failed attempt. A retained message stored without it (an older build) leaves the ten-call reminder to fire.
    if mixdog_core_run::run_host::guards::carries_todo_start(&carried) {
        guards.note_creation_told();
    }
    if carried != input_body || rebound {
        let mut sent = rejoined(&stored_ids, &prior);
        sent.push((input_item.clone(), carried.clone()));
        if port.context_rewound(sent).await.is_err() {
            return failed("the turn's reminders could not be saved with the turn's input", Value::Null);
        }
        input_body = carried;
    }
    if rebind_owed {
        let spent =
            mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: vec!["thinkingRebindPending".into()], patch: Default::default() };
        if port.save_header(spent).await.is_err() {
            return failed("the session's thinking rebind could not be recorded", Value::Null);
        }
    }
    carried_notice.carry(revisions);
    let input = match message_of(&input_body) {
        Ok(input) => input,
        Err(error) => return failed(format!("the turn's input row is not a model message: {error}"), input_body),
    };
    let live = LiveTurnPublisher::new(turn_messages);
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
        (on_tool_result, shown_tx.clone()),
        (stamp, applied),
    );
    // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
    let mut messages = system_messages(&header);
    // The context before the input row with the item each message is, for the rewrite a cancelled turn ends with: each
    // message as its stored row (shared with the message), read back into the message only if the turn is cancelled, so
    // the turn holds no second copy of the conversation.
    let mut history: Vec<(ItemId, HistoryRow)> = Vec::new();
    let mut leading = true;
    for (iid, body) in stored_ids.into_iter().zip(prior) {
        // A stored row the codec cannot read fails the turn: dropping it would change the context. The row becomes the
        // message's own `stored` and the turn's registered body at once (one copy, shared).
        let message = match mixdog_agent::message_row::message_of_owned(body) {
            Ok(message) => message,
            Err((error, body)) => return failed(format!("the model context holds a row this build cannot read: {error}"), body),
        };
        if leading && is_stale_system_row(&message) {
            continue;
        }
        leading = false;
        if let Some(id) = &message.message_id {
            lock(&sink.iids).insert(id.clone(), iid.clone());
        }
        let row = match &message.stored {
            Some(stored) => HistoryRow::Stored(stored.clone()),
            None => HistoryRow::Message(Box::new(message.clone())),
        };
        history.push((iid, row));
        rows.record_stored(&message);
        messages.push(message);
    }
    let input_text = input.text();
    rows.record(&input, input_body);
    sink.seed(&input);
    messages.push(input);

    let progress = Arc::new(ProgressPublisher::new(progress, clock.clone()));
    progress.ask_start();
    let asked_at = clock.now_ms();
    // The progress watchdog judges the model work from the ask on, and only a run no person is
    // attached to (Node arms it per worker turn once the ask has started).
    let watchdog = if unattended {
        let agent = header.get("agent").and_then(Value::as_str).filter(|name| !name.is_empty());
        // The assembled route's model and parameters: the provider is the one the assembly chose, which a preflight fallback
        // moved off the header this turn started from.
        let budget = provider.first_response_budget(&config.model, config.options.model_parameters.as_ref().filter(|parameters| parameters.is_object()));
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
        let kind = AgentKind { name: agent, hidden: config.hidden_agent, stall_cap_idle_seconds: parts.stall_cap_idle_seconds(agent) };
        let policy = resolve_policy(kind, overrides, &|name: &str| std::env::var(name).ok());
        let (reaper, reaped_thread) = (parts.clone(), thread.clone());
        // The worker-turn registry's stop (`abortOnTimeout`, `agent-watchdog-registry.mjs:30-33`): the reap is armed, then the stop is
        // recorded with what the sweep judged, then the abort.
        let (stall_log, stall_agent, site) = (failures.clone(), agent.map(str::to_owned), StallSite::Registry { registration_id: registration_id() });
        let anchor_ts = clock.now_ms();
        Watchdog::arm(
            true,
            policy,
            signal.clone(),
            clock.clone(),
            move |now| watched.borrow().snapshot(now),
            move |snapshot: &Snapshot, message: &str, now: i64| {
                reaper.reap_turn_shells(&reaped_thread, asked_at);
                if let Some(log) = stall_log {
                    log.stall_abort(stall_abort_ctx(reaped_thread.as_str(), stall_agent.as_deref(), &site, &policy, anchor_ts, snapshot, message, now));
                }
            },
        )
    } else {
        None
    };
    // The quiet-time cue of a turn a person watches (`startQuietWatch` in the lead turn, `turn.mjs:781`), against the lead's warn point.
    let quiet_watch = (!unattended).then(|| {
        let warn_ms =
            mixdog_agent::agent_tool::watchdog::stall_warn_ms(AgentKind { name: Some("lead"), ..AgentKind::default() }, &|name: &str| std::env::var(name).ok());
        QuietWatch::start(quiet_changes, port.clone(), clock.clone(), Arc::new(TimerWait), warn_ms as f64)
    });
    drop(spawn_forwarder(port.clone(), shown_rx, cancel.clone()));
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
        progress: progress.clone(),
        out: shown_tx,
        streaming,
        reasoning: Mutex::new(None),
        last_send_tools: Mutex::new(Vec::new()),
        chunked: std::sync::atomic::AtomicBool::new(false),
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
    config.select_input_skills = !injected && !retried;
    // Only the gate's refusal (a stale request) reloads the history: a run without one has nothing to reload for.
    config.history = config
        .options
        .tail_gate
        .clone()
        .map(|gate| Arc::new(ReloadedHistory { sink: sink.clone(), context: context.clone(), gate }) as Arc<dyn mixdog_agent::env::StoredHistory>);
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(
        review,
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
    progress.model_loop(true);
    let provider_id = provider.id().as_str().to_owned();
    let result = Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry).run().await;
    progress.model_loop(false);
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
    // A cancelled run's token has fired, but Node saves after the abort (`finalizeCancelledTurn`).
    let end_port = if cancel.is_cancelled() { port.closing() } else { port.clone() };
    {
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
            Ok(output) if !cancel.is_cancelled() => {
                let report = output.response.report_content.as_deref().unwrap_or(&output.response.content);
                set.insert("lastHandoff".into(), Value::String(context.redact_text(report)));
                set.insert("lastHandoffTurn".into(), Value::String(turn.as_str().to_owned()));
            }
            _ => unset.extend(["lastHandoff".to_owned(), "lastHandoffTurn".to_owned()]),
        }
        let _ = end_port.save_header(mixdog_store::schema::record::HeaderChange { set, unset, patch: Default::default() }).await;
        let kept = match &result {
            Ok(output) if !cancel.is_cancelled() => output.carry.prefix_guard.clone(),
            _ => None,
        };
        prefix_guard.keep(kept);
    }
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
                    sink.live.clear();
                    progress.error();
                    return failed(error.to_string(), Value::Null);
                }
                transcript.push(message);
            }
            sink.flush().await;
            // `settleAskTurn`: the ask's usage and transcript reach the header once every call's report
            // has (the port's lane keeps their order). Every media preparation of the turn is done by then ([`Preparation`]).
            let _ = closing.barrier().await;
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
            let _ = port.settled(settled).await;
            // `transcript.appendFinalAssistant(result)` (`turn-settle.mjs:44`): `historyContent ?? content`.
            if let Some(turn_transcript) = &turn_transcript {
                turn_transcript.final_text(output.response.history_content.as_deref().unwrap_or(&output.response.content));
            }
            // The `Stop` hook is not asked here: the agent loop asks it when the model ends its turn, so a block can
            // continue the turn (owner-approved difference from Node's `completeTurn`).
            sink.live.clear();
            progress.done(output.response.content.trim().is_empty());
            if let Some(state) = output.provider_state.clone() {
                let _ = port.save_provider_state(Some(state)).await;
            }
            RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                content: output.response.content.clone(),
                report_content: output.response.report_content.clone(),
                termination: output.termination,
                iterations: output.iterations,
                tool_calls_total: output.tool_calls_total,
                stop_reason: output.response.stop.as_ref().map(super::super::message_row::stop_name),
            }))
        }
        Err(failure) => {
            sink.flush().await;
            // The turn ends once what it produced is forwarded, its media preparations done ([`Preparation`]); a cancelled run's
            // forwarder is gone already, and this answers at once.
            let _ = closing.barrier().await;
            sink.live.clear();
            // The watchdog's abort is a stalled failure, not a user's interrupt: its sentence is
            // the error, and the partial output the sink just flushed goes to the owner.
            if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                // The turn has unwound: sweep what it registered while stopping (`reapTurnShellJobs`).
                parts.reap_turn_shells(&thread, asked_at);
                progress.error();
                return failed(signal.reason(), Value::Null);
            }
            if matches!(failure.error, AgentError::Aborted) || cancel.is_cancelled() {
                progress.cancelling();
                close_cancelled(&end_port, &sink, &rows, &history, (&input_item, &input_text), &observed, signal.close_reason()).await;
                return RunOutcome::Interrupted;
            }
            // The turn's terminal error: a provider timeout or stall that ended it (a retry the turn recovered from never
            // reaches here) stops its shell work, while nothing else stopped the turn first
            // (`armTurnTimeoutOnProviderError` then `reapTurnShellJobs`, `ask-session.mjs`).
            if !signal.is_aborted() && matches!(&failure.error, AgentError::Provider(error) if provider_timeout_or_stall(error)) {
                parts.reap_turn_shells(&thread, asked_at);
            }
            progress.error();
            let data = if failure.carried_report.is_empty() { Value::Null } else { json!({ "carriedReport": failure.carried_report }) };
            // A provider's refusal keeps what `turnFailureRecord` reads off it: kind, status, code, retry advice and
            // reset (`provider_turn_error`); any other failure is its message.
            if let AgentError::Provider(error) = &failure.error {
                return RunOutcome::Failed(provider_turn_error(error, &provider_id, data));
            }
            // The guard's refusal reads as `Session state changed unexpectedly.` (`err-text.mjs:274`, by its code).
            if matches!(failure.error, AgentError::PrefixMutation(_)) {
                return failed("Session state changed unexpectedly.".to_owned(), data);
            }
            failed(failure.error.to_string(), data)
        }
    }
}
