//! How a turn that did not complete ends: a stop before the loop, a cancelled run, a crashed run's recovery.

use super::*;

/// What a run that ended before its model loop reads as ([`setup_end`]).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum SetupEnd {
    /// The outcome as the setup reported it.
    AsReported,
    /// The progress watchdog's stop: a stalled failure whose sentence is the error, as after the loop.
    Stalled,
    /// A stop: a stopped turn, closed as `finalizeCancelledTurn` closes one that produced nothing.
    Stopped,
}

/// Node's abort rejects the turn wherever it stands and `askSession` closes it as stopped (`finalizeCancelledTurn`,
/// `ask-turn-failure.mjs`; the stop itself takes the prompt back, `abort.mjs` `reclaimInFlightPrompt`). The run's own
/// waits here end with its fired token (`RunPort::scoped`), so a setup step that was waiting on a save reports a
/// failure of its own ("the session's title could not be saved"): a failure reported before the model was asked
/// (`asked`) by a run whose token has fired is that stop, not a failed turn.
pub(super) fn setup_end(failed: bool, asked: bool, cancelled: bool, abort_reason: Option<&str>) -> SetupEnd {
    if !failed || asked || !cancelled {
        return SetupEnd::AsReported;
    }
    if abort_reason.is_some_and(is_watchdog_abort) {
        return SetupEnd::Stalled;
    }
    SetupEnd::Stopped
}

/// What `finalizeInterruptedTurn` leaves of a prompt whose turn was stopped before anything was asked of the model, for
/// the stop's reason: whether the prompt's row leaves (a user's stop that hands it back), and the rows that follow it
/// when it stays (the interruption line of a stop that keeps the prompt).
pub(super) fn stopped_prompt(input: &AgentMessage, reason: mixdog_agent::interrupt::AbortReason) -> (bool, Vec<AgentMessage>) {
    use mixdog_agent::interrupt::{Interrupted, Phase, finalize_interrupted_turn};
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: vec![input.clone()],
        current_user_text: input.text(),
        response_started: false,
        partial_assistant: String::new(),
        partial_reasoning: String::new(),
        observed_tool_calls: Vec::new(),
        observed_tool_results: Vec::new(),
        phase: Phase::Streaming,
        reason,
    });
    (!finalized.user_turn_preserved, finalized.transcript.into_iter().skip(1).collect())
}

/// `finalizeCancelledTurn` (`ask-turn-failure.mjs`): the transcript of a stopped turn as `finalizeInterruptedTurn`
/// leaves it for the stop's reason: the partial reply, every unanswered call closed as cancelled, the interruption
/// line, and `sentRequestTail` on the message the request ended with; a user cancel that produced nothing hands the
/// prompt back (it leaves the context), a kept prompt or a non-user stop keeps it. The new rows are committed and the
/// model context restarts on the finalized transcript, which also drops the provider's continuation.
pub(super) async fn close_cancelled(
    port: &RunPort,
    sink: &PortSink,
    rows: &StoredRows,
    history: &[(ItemId, HistoryRow)],
    input: (&ItemId, &str),
    observed: &Mutex<Observed>,
    reason: mixdog_agent::interrupt::AbortReason,
) {
    use mixdog_agent::compact::execution_tail::MessageRows as _;
    use mixdog_agent::interrupt::{Interrupted, Phase, finalize_interrupted_turn};
    let (input_item, input_text) = input;
    let seen = std::mem::take(&mut *lock(observed));
    let mut known: Vec<(ItemId, AgentMessage)> = history.iter().map(|(iid, row)| (iid.clone(), row.message())).collect();
    for (index, message) in lock(&sink.turn).iter().enumerate() {
        known.push((if index == 0 { input_item.clone() } else { sink.iid_of(message) }, AgentMessage::clone(message)));
    }
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: known.iter().map(|(_, message)| message.clone()).collect(),
        current_user_text: input_text.to_owned(),
        response_started: seen.started,
        partial_assistant: seen.text,
        partial_reasoning: seen.reasoning,
        observed_tool_calls: seen.calls,
        observed_tool_results: seen.results,
        phase: if seen.tools { Phase::Tools } else { Phase::Streaming },
        reason,
    });
    // A user cancel that produced nothing hands the prompt back: the rewind record at its row.
    if !finalized.user_turn_preserved {
        if let Err(error) = port.prompt_rewound(input_item.clone()).await {
            tracing::warn!("[session] rewound prompt save failed: {error:?}");
        }
        return;
    }
    let mut replacement: Vec<(ItemId, Value)> = Vec::new();
    for (index, message) in finalized.transcript.iter().enumerate() {
        let mut body;
        let iid;
        if let Some((known_iid, _)) = known.get(index).filter(|(_, was)| was == message) {
            iid = known_iid.clone();
            body = rows.row(message);
        } else {
            // The shown reply is the item of the partial text it ends as, with the segments it was shown as.
            let shown = if message.role() == Role::Assistant { lock(&sink.streaming).take() } else { None };
            body = row_of(message);
            iid = match shown {
                Some((iid, named)) => {
                    with_shown(&mut body, named);
                    iid
                }
                None => new_item_id(),
            };
            rows.record(message, body.clone());
            let role = match message.role() {
                Role::Assistant => "assistant",
                Role::Tool => "tool",
                _ => "user",
            };
            let item = ItemCommit {
                iid: iid.clone(),
                role: Some(role.to_owned()),
                model: true,
                visible: message.role() != Role::User,
                body: body.clone(),
                prompt: None,
            };
            if let Err(error) = port.commit_item(item).await {
                tracing::warn!("[session] interrupted turn row save failed: {error:?}");
            }
        }
        if finalized.sent_request_tail == Some(index)
            && let Some(object) = body.as_object_mut()
        {
            let meta = object.entry("meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("sentRequestTail".into(), Value::Bool(true));
            }
        }
        replacement.push((iid, body));
    }
    if let Err(error) = port.context_rewound(replacement).await {
        tracing::warn!("[session] interrupted turn context save failed: {error:?}");
    }
}

/// The result of each call of `turn` (the turn's committed messages) that none of them answers, in call order: the
/// result `early` holds for it (settled, not yet committed in call order), else one that says the turn stalled.
pub(super) fn stalled_results(turn: &[Arc<AgentMessage>], early: &[AgentMessage]) -> Vec<AgentMessage> {
    use mixdog_agent::message::ToolKind;
    let answered: Vec<&str> = turn.iter().filter(|message| message.role() == Role::Tool).filter_map(|message| message.tool_call_id()).collect();
    let mut results: Vec<AgentMessage> = Vec::new();
    for call in turn.iter().flat_map(|message| message.assistant_call_ids()) {
        if answered.contains(&call.as_str()) || results.iter().any(|result| result.tool_call_id() == Some(call.as_str())) {
            continue;
        }
        results.push(match early.iter().find(|result| result.tool_call_id() == Some(call.as_str())) {
            Some(result) => {
                let kind = result.tool_kind.or(result.message.is_error.then_some(ToolKind::Error));
                let mut kept = AgentMessage::tool_result(call, result.message.content.clone(), kind.unwrap_or(ToolKind::Normal));
                kept.tool_kind = kind;
                kept
            }
            None => AgentMessage::tool_text(call, mixdog_agent::agent_tool::watchdog::WATCHDOG_STOP_ERROR, ToolKind::Error),
        });
    }
    results
}

/// A turn the progress watchdog stopped: every call it left running is closed with a stored result
/// ([`stalled_results`]), as [`close_cancelled`] closes a stopped turn's, so no call of an ended turn is without one.
/// Nothing else is added: the turn failed, and its failure is its end.
pub(super) async fn close_stalled(port: &RunPort, sink: &PortSink, rows: &StoredRows, observed: &Mutex<Observed>) {
    let early = std::mem::take(&mut lock(observed).results);
    let results = stalled_results(&lock(&sink.turn), &early);
    for message in results {
        let body = row_of(&message);
        rows.record(&message, body.clone());
        let item = ItemCommit { iid: new_item_id(), role: Some("tool".to_owned()), model: true, visible: true, body, prompt: None };
        if let Err(error) = port.commit_item(item).await {
            tracing::warn!("[session] stalled turn result save failed: {error:?}");
        }
    }
}

/// `recoverTurnCheckpoint` of a run the process died in. A sealed turn (its answer committed, stamped with the turn's
/// completion) stays as it is. Otherwise its draft is finalized as `finalizeTurnInterruptionSnapshot(.., 'process-crash')`
/// finalizes the checkpoint: the partial reply, every unanswered call closed as cancelled and the restart line are
/// committed, and the model context restarts on the finalized transcript, with `sentRequestTail` on the message the
/// request ended with (as [`close_cancelled`] leaves a stopped turn).
pub(super) fn crashed_rows(run: mixdog_core_session::session::CrashedRun) -> mixdog_core_session::session::CrashedRows {
    use mixdog_agent::interrupt::{AbortReason, Interrupted, Phase, finalize_interrupted_turn};
    use mixdog_core_session::session::CrashedRows;
    use mixdog_protocol::message_class::RowFacts;
    use mixdog_protocol::message_class::user_text::{Blobs, ReadError};
    struct NoAttachments;
    impl Blobs for NoAttachments {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, ReadError> {
            Ok(None)
        }
    }
    let mut known: Vec<(ItemId, AgentMessage)> = Vec::with_capacity(run.context.len());
    for (iid, body) in &run.context {
        match message_of(body) {
            Ok(message) => known.push((iid.clone(), message)),
            Err(error) => {
                tracing::error!("[turn-checkpoint] the crashed turn is not finalized: its context holds a row this build cannot read: {error}");
                return CrashedRows::default();
            }
        }
    }
    let input = run.input.as_ref().and_then(|input| known.iter().position(|(iid, _)| iid == input));
    // The turn's own rows follow its input row: any of them is output (`responseStarted`).
    let answered = input.is_some_and(|at| at + 1 < known.len());
    let sealed = answered
        && run
            .context
            .last()
            .is_some_and(|(_, body)| body.get("role").and_then(Value::as_str) == Some("assistant") && body.pointer("/meta/transcript/completion").is_some());
    if sealed {
        return CrashedRows { sealed: true, ..CrashedRows::default() };
    }
    // The turn was sealed (its final reply drafted) but the reply's row never landed: the reply is committed as that row
    // and the turn ends finished, as Node brings a sealed checkpoint back (`turn-checkpoint-recovery.mjs`).
    if let Some(row) = run.draft.sealed.clone() {
        return CrashedRows {
            sealed: true,
            rows: vec![ItemCommit { iid: new_item_id(), role: Some("assistant".to_owned()), model: true, visible: true, body: row, prompt: None }],
            ..CrashedRows::default()
        };
    }
    // A recovery whose rows landed but whose end record did not (the process died again in between) left the restart line
    // closing the turn: finalized again, the turn is rebuilt with that line at the same place, which is kept, not added again.
    let restart = |message: &AgentMessage| message.role() == Role::User && message.text() == mixdog_agent::interrupt::PROCESS_RESTART_INTERRUPT_MESSAGE;
    let mut transcript: Vec<AgentMessage> = known.iter().map(|(_, message)| message.clone()).collect();
    if answered && transcript.last().is_some_and(restart) {
        transcript.pop();
    }
    let draft = run.draft;
    let calls =
        message_of(&json!({ "role": "assistant", "content": "", "toolCalls": draft.calls })).map(|message| message.tool_calls().to_vec()).unwrap_or_default();
    let results = draft.results.iter().filter_map(|row| message_of(row).ok()).collect();
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript,
        current_user_text: input.map(|at| known[at].1.text()).unwrap_or_default(),
        response_started: draft.started || answered,
        partial_assistant: draft.text,
        partial_reasoning: draft.reasoning,
        observed_tool_calls: calls,
        observed_tool_results: results,
        phase: if draft.tools { Phase::Tools } else { Phase::Streaming },
        reason: AbortReason::ProcessCrash,
    });
    if !finalized.response_preserved {
        return CrashedRows::default();
    }
    let mut rows = Vec::new();
    let mut replacement: Vec<(ItemId, Value)> = Vec::new();
    for (index, message) in finalized.transcript.iter().enumerate() {
        let (iid, mut body) = match known.get(index).filter(|(_, was)| was == message || (restart(was) && restart(message))) {
            Some((iid, _)) => (iid.clone(), run.context[index].1.clone()),
            None => {
                let (iid, mut body) = (new_item_id(), row_of(message));
                let role = match message.role() {
                    Role::Assistant => "assistant",
                    Role::Tool => "tool",
                    _ => "user",
                };
                // The restart line is classified as a live commit's is (a cancel line shows as the turn's end); it names
                // no attachment, so no attachment is read.
                let facts = row_facts(&mut body, &mut UserText::new(&NoAttachments)).unwrap_or(RowFacts { visible: true, prompt: None });
                rows.push(ItemCommit {
                    iid: iid.clone(),
                    role: Some(role.to_owned()),
                    model: true,
                    visible: facts.visible,
                    body: body.clone(),
                    prompt: facts.prompt,
                });
                (iid, body)
            }
        };
        if finalized.sent_request_tail == Some(index)
            && let Some(object) = body.as_object_mut()
        {
            let meta = object.entry("meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("sentRequestTail".into(), Value::Bool(true));
            }
        }
        replacement.push((iid, body));
    }
    CrashedRows { sealed: false, rows, context: Some(replacement), context_tokens: None }
}
