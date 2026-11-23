use super::*;

/// A system row an earlier build stored at the head of the context is not read back: the header's prompt is the request's
/// system set, so the next rewrite leaves the request's lead as it was.
#[test]
fn a_stored_leading_system_row_is_not_part_of_the_loaded_context() {
    let header = mixdog_store::schema::record::Header::new();
    let rows =
        [json!({ "role": "system", "content": "old prompt" }), json!({ "role": "user", "content": "hello" }), json!({ "role": "system", "content": "later" })];
    let loaded = session_messages(&header, &rows).expect("messages");
    let roles: Vec<Role> = loaded.iter().skip(system_messages(&header).len()).map(|m| m.role()).collect();
    assert_eq!(roles, [Role::User, Role::System]);
}

/// A failure the run's setup reports after its token fired is the stop that fired it (`setup_end`): Node's abort rejects
/// the turn wherever it stands, and `askSession` closes it as stopped. A failure with no stop stays the failure, the loop
/// closes its own stops, and the progress watchdog's stop stays a stalled failure.
#[test]
fn a_setup_failure_after_a_stop_is_that_stop() {
    let stop = mixdog_agent::cancel::runtime_abort_reason("sess_1", mixdog_agent::cancel::USER_CANCEL);
    assert_eq!(setup_end(true, false, true, Some(&stop)), SetupEnd::Stopped);
    assert_eq!(setup_end(true, false, true, None), SetupEnd::Stopped);
    assert_eq!(setup_end(true, true, true, Some(&stop)), SetupEnd::AsReported, "the loop closes a stop that lands inside it");
    assert_eq!(setup_end(true, false, false, None), SetupEnd::AsReported, "a failure with no stop is the failure");
    assert_eq!(setup_end(false, false, true, Some(&stop)), SetupEnd::AsReported, "an outcome that is no failure is itself");
    assert_eq!(setup_end(true, false, true, Some("agent task stale (no progress for 600s)")), SetupEnd::Stalled);
}

/// A turn the watchdog stopped: each call none of its messages answers gets one result, in call order, the one that
/// settled early when there is one and else the stall; an answered call gets none, and no other row is added.
#[test]
fn a_stalled_turns_open_calls_each_get_one_result() {
    use mixdog_agent::message::ToolKind;
    use mixdog_core_api::domain::provider::ToolCall;
    let call = |id: &str| ToolCall { id: id.into(), name: "shell".into(), arguments: mixdog_protocol::JsonValue::Null, native_type: None };
    let turn: Vec<Arc<AgentMessage>> = [
        AgentMessage::user("go"),
        AgentMessage::assistant("", vec![call("done"), call("early"), call("running")]),
        AgentMessage::tool_text("done", "ok", ToolKind::Normal),
    ]
    .into_iter()
    .map(Arc::new)
    .collect();
    let early = [AgentMessage::tool_text("early", "settled", ToolKind::Normal)];
    let results = stalled_results(&turn, &early);
    let told: Vec<(Option<&str>, String, Option<ToolKind>)> = results.iter().map(|r| (r.tool_call_id(), r.text(), r.tool_kind)).collect();
    assert_eq!(
        told,
        [
            (Some("early"), "settled".to_owned(), Some(ToolKind::Normal)),
            (Some("running"), mixdog_agent::agent_tool::watchdog::WATCHDOG_STOP_ERROR.to_owned(), Some(ToolKind::Error)),
        ]
    );
    assert!(results.iter().all(|result| result.role() == Role::Tool));
    assert!(stalled_results(&turn[..1], &early).is_empty(), "a turn with no call gets no row");
}

/// What a stop before the model was asked leaves of the prompt, by its reason (`finalizeInterruptedTurn` over a turn
/// that produced nothing): a user's stop hands it back, a stop that keeps it adds the interruption line, any other
/// stop leaves it as it is.
#[test]
fn a_prompt_stopped_before_the_model_is_asked_is_left_as_the_interruption_leaves_it() {
    use mixdog_agent::interrupt::AbortReason;
    let prompt = AgentMessage::user("give it back");
    let texts = |rows: Vec<AgentMessage>| rows.iter().map(AgentMessage::text).collect::<Vec<_>>();
    let (rewound, following) = stopped_prompt(&prompt, AbortReason::UserCancel);
    assert!(rewound && following.is_empty(), "a user's stop hands the prompt back: {:?}", texts(following));
    let (rewound, following) = stopped_prompt(&prompt, AbortReason::UserCancelKeepPrompt);
    assert!(!rewound);
    assert_eq!(texts(following), ["[Request interrupted]"]);
    let (rewound, following) = stopped_prompt(&prompt, AbortReason::Other);
    assert!(!rewound && following.is_empty(), "a stop that is not the user's keeps the prompt: {:?}", texts(following));
}

/// `PROVIDER_TIMEOUT_CODES` and `streamStalled` (`turn-reap.mjs`): the three codes, a stream watchdog's expiry and a
/// stream cut after it showed text; nothing else.
#[test]
fn only_a_timeout_or_stall_error_is_one() {
    use mixdog_core_api::domain::provider::{ErrorKind, StreamTimeoutPhase, TransportFault};
    let plain = || ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    for code in ["ESTREAMSTALL", "EPROVIDERTIMEOUT", "EGEMINITIMEOUT"] {
        let mut error = plain();
        error.code = Some(code.to_owned());
        assert!(super::super::provider_timeout_or_stall(&error), "{code}");
    }
    let mut watchdog = plain();
    watchdog.timeout_phase = Some(StreamTimeoutPhase::Idle);
    assert!(super::super::provider_timeout_or_stall(&watchdog));
    let mut cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    assert!(!super::super::provider_timeout_or_stall(&cut), "a cut stream that showed nothing is no stall");
    cut.exposure.text_emitted = true;
    assert!(super::super::provider_timeout_or_stall(&cut));
    let mut other = plain();
    other.code = Some("ECONNRESET".to_owned());
    other.timed_out = true;
    assert!(!super::super::provider_timeout_or_stall(&other));
    assert!(!super::super::provider_timeout_or_stall(&plain()));
}

/// A throttled draft takes the streamed text while the message's row commits on another thread: the draft is queued
/// before the row (a draft after it would recover the message a second time). The row's commit runs at the first moment
/// it can: at once if nothing holds the draft between taking and queuing it, else once the draft lets go.
#[test]
fn a_draft_taken_while_its_message_commits_is_queued_before_the_row() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let observed = Observed { started: true, text: "reading".into(), ..Observed::default() };
    let jobs = Arc::new(Jobs { observed: Arc::new(Mutex::new(observed)), seq: AtomicU64::new(0), tx, shown: None, taken: Mutex::default() });
    let later: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
    let (committer, pending) = (jobs.clone(), later.clone());
    *lock(&jobs.taken) = Some(Box::new(move || {
        let free = jobs_free(&committer);
        let commit = move || {
            let item = ItemCommit {
                iid: ItemId::from("row"),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "content": "reading" }),
                prompt: None,
            };
            committer.row(true, None, item);
        };
        if free {
            commit();
        } else {
            *lock(&pending) = Some(std::thread::spawn(commit));
        }
    }));
    jobs.draft();
    if let Some(thread) = lock(&later).take() {
        thread.join().expect("the commit");
    }
    let mut order = Vec::new();
    while let Ok(job) = rx.try_recv() {
        order.push(match job {
            Job::Draft(_, body) => format!("draft {}", body["text"].as_str().unwrap_or_default()),
            Job::Commit(_, item, _) => format!("row {}", item.iid.as_str()),
            Job::Compact(..) => "compact".to_owned(),
            Job::Rewound(..) => "rewound".to_owned(),
        });
    }
    assert_eq!(order, ["draft reading", "row row"]);
}

/// The process died again after a recovery's rows landed and before its end record: the next recovery keeps the restart
/// line where it stands and adds no second one.
#[test]
fn a_recovery_whose_rows_landed_adds_no_second_restart_line() {
    use mixdog_agent::interrupt::PROCESS_RESTART_INTERRUPT_MESSAGE;
    let row = |role: &str, text: &str| json!({ "role": role, "content": text });
    let context = vec![
        (ItemId::from("in"), row("user", "do the task")),
        (ItemId::from("partial"), row("assistant", "partial streamed answer")),
        (ItemId::from("restart"), row("user", PROCESS_RESTART_INTERRUPT_MESSAGE)),
    ];
    let draft = mixdog_core_session::session::turn_draft::RunDraft { started: true, input: Some("in".into()), ..Default::default() };
    let left = crashed_rows(mixdog_core_session::session::CrashedRun { context, input: Some(ItemId::from("in")), draft });
    assert!(!left.sealed);
    assert!(left.rows.is_empty(), "no row is added: {:?}", left.rows.iter().map(|row| row.body.clone()).collect::<Vec<_>>());
    let kept: Vec<String> = left.context.expect("the context restarts on the turn").into_iter().map(|(iid, _)| iid.as_str().to_owned()).collect();
    assert_eq!(kept, ["in", "partial", "restart"]);
}

/// A run that died with nothing drafted (only its draft's opening body) is finalized from its rows alone, as Node's reconnect
/// recovery finalizes it (`recover_after_restart`, which the session crate's scripted runs answer a crash with): the same
/// rows are added, in the same order.
#[test]
fn a_draftless_crash_is_finalized_as_the_reconnect_recovery_finalizes_it() {
    let context = vec![
        (ItemId::from("in"), json!({ "role": "user", "content": "read a" })),
        (
            ItemId::from("call"),
            json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] }),
        ),
    ];
    let bodies: Vec<Value> = context.iter().map(|(_, body)| body.clone()).collect();
    let reconnect: Vec<(String, Value)> = mixdog_agent::interrupt::recover_after_restart(&bodies)
        .expect("recovered")
        .into_iter()
        .filter_map(|row| match row {
            mixdog_agent::interrupt::RecoveredRow::New { role, body } => Some((role.to_owned(), body)),
            mixdog_agent::interrupt::RecoveredRow::Kept { .. } => None,
        })
        .collect();
    assert!(!reconnect.is_empty());
    let draft = mixdog_core_session::session::turn_draft::RunDraft { input: Some("in".into()), ..Default::default() };
    let left = crashed_rows(mixdog_core_session::session::CrashedRun { context, input: Some(ItemId::from("in")), draft });
    assert!(!left.sealed);
    let added: Vec<(String, Value)> = left.rows.into_iter().map(|row| (row.role.unwrap_or_default(), row.body)).collect();
    let shape =
        |rows: &[(String, Value)]| rows.iter().map(|(role, body)| (role.clone(), body["content"].clone(), body["toolCallId"].clone())).collect::<Vec<_>>();
    assert_eq!(shape(&added), shape(&reconnect));
}

/// A run whose first submission is Google's (its chunks report progress, its deltas none) and whose second is a provider that
/// reports text only as text deltas: the second's text is progress again, its first delta stamping the visible text.
#[test]
fn a_chunk_reporting_send_leaves_the_next_sends_text_deltas_counted() {
    let (tx, rx) = tokio::sync::watch::channel(mixdog_core_run::run_host::progress::RunProgress::default());
    let clock = Arc::new(Moving(AtomicI64::new(1_000)));
    let progress = ProgressPublisher::new(tx, clock.clone());
    progress.ask_start();
    let reporting = super::super::observer::ChunkReporting::default();
    let visible_text_at = || rx.borrow().snapshot(clock.now_ms()).expect("a run entry").last_visible_text_at;

    reporting.submission_started();
    reporting.chunk();
    clock.0.store(2_000, std::sync::atomic::Ordering::SeqCst);
    reporting.delta(&progress, StreamKind::Text);
    assert_eq!(visible_text_at(), 0, "a chunk-reporting stream's delta is not progress of its own");

    reporting.submission_started();
    clock.0.store(3_000, std::sync::atomic::Ordering::SeqCst);
    reporting.delta(&progress, StreamKind::Text);
    assert_eq!(visible_text_at(), 3_000);
}
