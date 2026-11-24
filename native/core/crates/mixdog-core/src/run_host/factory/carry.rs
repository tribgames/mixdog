//! What a turn's input carries to whoever answers it, the loop's model or an agent outside the loop: the session's
//! fallback title and its scheduled generated one, the turn's context ahead of the prompt and its reminders behind it.

use super::super::lifecycle_hooks;
use super::super::turn_reminders;
use super::*;

/// What [`carry_turn`] reads of the turn.
pub(super) struct Carry<'a> {
    pub(super) parts: &'a Arc<dyn RunParts>,
    pub(super) thread: &'a ThreadId,
    pub(super) header: &'a mixdog_store::schema::record::Header,
    pub(super) port: &'a RunPort,
    /// The stored rows before the turn's input: the item of each, and its body.
    pub(super) stored_ids: &'a [ItemId],
    pub(super) prior: &'a [Value],
    pub(super) input_item: &'a ItemId,
    pub(super) input_body: Value,
    pub(super) injected: bool,
    /// The turn's own context and what the prompt hooks added.
    pub(super) turn_context: &'a str,
    pub(super) goal_reminder: Option<&'a mixdog_core_session::session::goal_reminder::GoalReminder>,
    pub(super) notice: &'a mixdog_core_session::session::prompt_notice::CarriedNotice,
    pub(super) hidden_agent: bool,
    /// The loop's run configuration, whose effort the outgoing message is stamped with; none for a turn the loop does not run.
    pub(super) config: Option<&'a RunConfig>,
    pub(super) clock: &'a Arc<dyn Clock>,
    pub(super) blobs: &'a Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    pub(super) guards: &'a Arc<dyn TurnGuards>,
    /// The stored rows were rebound to a changed prefix and are written with the input.
    pub(super) rebound: bool,
    pub(super) rebind_owed: bool,
}

/// The stored rows with the item each is: the turn holds the bodies and the ids apart, and joins them only for a rewrite.
pub(super) fn rejoined(ids: &[ItemId], bodies: &[Value]) -> Vec<(ItemId, Value)> {
    ids.iter().cloned().zip(bodies.iter().cloned()).collect()
}

/// A turn the runtime put in (a completion notice, a Goal continuation), not one a person typed: its input row names
/// its `meta.source`.
pub(super) fn is_injected(input_body: &Value) -> bool {
    input_body.pointer("/meta/source").is_some_and(Value::is_string)
}

/// The prompt a session's titles are taken from: the typed turn's content, none for an injected turn.
fn typed_prompt(input_body: &Value) -> Option<Value> {
    (!is_injected(input_body)).then(|| json!({ "role": "user", "content": input_body.get("content").cloned().unwrap_or(Value::Null) }))
}

/// The turn's input row as it is sent, and whether it is a retried turn's own message. A refusal is the turn's outcome.
#[allow(clippy::result_large_err, reason = "the refusal is the turn's outcome, returned by value once per turn")]
pub(super) async fn carry_turn(carry: Carry<'_>) -> Result<(Value, bool), RunOutcome> {
    let Carry {
        parts,
        thread,
        header,
        port,
        stored_ids,
        prior,
        input_item,
        input_body,
        injected,
        turn_context,
        goal_reminder,
        notice,
        hidden_agent,
        config,
        clock,
        blobs,
        guards,
        rebound,
        rebind_owed,
    } = carry;
    // `backfillFallbackSessionTitle` (`precommitUserTurn`, `ask-turn-execute.mjs`): a titleless session is named
    // from the earliest human turn of its history, else this turn's prompt (an injected turn never names it),
    // before the first save.
    let prompt = typed_prompt(&input_body);
    if let Some(change) = mixdog_core_session::session::session_title::fallback_title_change(header, prior, prompt.as_ref(), clock.now_ms())
        && port.save_header(change).await.is_err()
    {
        return Err(failed("the session's title could not be saved", Value::Null));
    }
    // `scheduleFirstTitle`: the first prompt of a session is titled once the turn shows its first output. The title
    // model is the maintainer's, whoever answers the turn.
    port.schedule_title(header, prior, prompt.as_ref());
    // `buildUserTurn` (`ask-turn-prepare.mjs:147-246`): the reminders staged on the conversation (a workflow or an
    // orchestration mode switch, moved settings, a changed agent list or working folder, a prepared worktree, a
    // deferred-tool delta, the Goal) and the ones this prompt earns (the current time, a delegated agent's todo start)
    // ride this turn once, as the user message's reminder suffix. The message is kept as it was sent (the context the
    // next turns replay, and a retry resubmits), and the actor acknowledges the revisions when the turn is accepted
    // (`ask-turn-settle.mjs:148-164`); a failed turn leaves them pending.
    let mut input_body = input_body;
    let current_agents = parts.current_agents(thread, header).await.map_err(RunOutcome::Failed)?;
    // A retried failed turn resends its own message as it is (`retainedUserTurn`, `ask-turn-execute.mjs:38-69`): it
    // keeps the reminders it was built with, learns the agents changed since, and acknowledges its settings notice only.
    let retried = turn_reminders::is_retained(&input_body);
    let (mut carried, revisions) = if retried {
        match turn_reminders::resubmit(&input_body, header, prior, current_agents.as_deref()) {
            Ok(resent) => resent,
            Err(text) => return Err(failed(text, input_body)),
        }
    } else {
        let mode_instructions = match turn_reminders::carried_mode(header) {
            Some(mode) => Some(parts.orchestration_instructions(&mode).await.map_err(RunOutcome::Failed)?),
            None => None,
        };
        // `promptContentText(prompt)`: a stored text attachment is read from the store; one that cannot be read fails the turn.
        let prompt_content = input_body.get("content").cloned().unwrap_or(Value::Null);
        let prompt_text = match with_blobs_if_read(&**blobs, move |store| turn_reminders::prompt_content_text(&prompt_content, store)).await {
            Ok(Ok(text)) => text,
            Ok(Err(text)) => return Err(failed(text, input_body)),
            Err(error) => return Err(failed(error.to_string(), input_body)),
        };
        let facts = turn_reminders::Facts {
            header,
            prior,
            prompt_text: &prompt_text,
            genuine: !injected,
            current_agents: current_agents.as_deref(),
            mode_instructions: mode_instructions.as_deref(),
            goal: goal_reminder.map(|reminder| reminder.content.as_str()),
            hidden_agent,
            now_ms: clock.now_ms() as f64,
        };
        let reminders = match turn_reminders::build(&facts) {
            Ok(reminders) => reminders,
            Err(text) => return Err(failed(text, input_body)),
        };
        // `prefixUserTurnContent(prompt, contextBlock)` (`buildUserTurn`): the turn's context leads the prompt, the reminders
        // trail it. A retried turn resends its message as it was built (`retainedUserTurn` reads no context).
        let Some(carried) = lifecycle_hooks::with_turn_context(&input_body, turn_context).and_then(|message| reminders.carry(&message)) else {
            return Err(failed("the turn's input row cannot carry the turn's reminders".to_owned(), input_body));
        };
        (carried, reminders.revisions)
    };
    if let Some(config) = config {
        stamp_outgoing_effort(&mut carried, config);
    }
    // Told means sent: the one point where the start reminder is on the outgoing message, built now or retained from the
    // failed attempt. A retained message stored without it (an older build) leaves the ten-call reminder to fire.
    if mixdog_core_run::run_host::guards::carries_todo_start(&carried) {
        guards.note_creation_told();
    }
    if carried != input_body || rebound {
        let mut sent = rejoined(stored_ids, prior);
        sent.push((input_item.clone(), carried.clone()));
        if port.context_rewound(sent).await.is_err() {
            return Err(failed("the turn's reminders could not be saved with the turn's input", Value::Null));
        }
        input_body = carried;
    }
    if rebind_owed {
        let spent =
            mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: vec!["thinkingRebindPending".into()], patch: Default::default() };
        if port.save_header(spent).await.is_err() {
            return Err(failed("the session's thinking rebind could not be recorded", Value::Null));
        }
    }
    notice.carry(revisions);
    Ok((input_body, retried))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An injected turn (its input row names a `meta.source`) gives the titles no prompt, so it schedules none; a typed
    /// turn's content is its prompt.
    #[test]
    fn an_injected_turn_gives_the_titles_no_prompt() {
        for source in ["task-notification", "goal-continuation", "schedule-result"] {
            let injected = json!({ "role": "user", "content": "done", "meta": { "source": source } });
            assert!(is_injected(&injected), "{source}");
            assert_eq!(typed_prompt(&injected), None, "{source}");
        }
        let typed = json!({ "role": "user", "content": "Why does the parser crash", "meta": { "transcript": { "at": 1 } } });
        assert!(!is_injected(&typed));
        assert_eq!(typed_prompt(&typed), Some(json!({ "role": "user", "content": "Why does the parser crash" })));
    }
}
