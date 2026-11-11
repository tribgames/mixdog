//! The transcript an aborted or failed turn leaves behind: what the
//! interrupted response produced but the transcript does not hold yet, every
//! unanswered tool call closed as cancelled, and the interruption marker.

use crate::message::AgentMessage;
use crate::message::ToolKind;
use crate::repair::sanitize_tool_pairs;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;

const INTERRUPT_MESSAGE: &str = "[Request interrupted by user]";
const INTERRUPT_MESSAGE_FOR_TOOL_USE: &str = "[Request interrupted by user for tool use]";
const PROCESS_RESTART_INTERRUPT_MESSAGE: &str = "[Request interrupted by process restart]";
const SESSION_INTERRUPT_MESSAGE: &str = "[Request interrupted]";
/// Short result body for any unfinished call closed by cancel or crash.
const INTERRUPTED_TOOL_RESULT: &str = "Cancelled";

/// Why the turn stopped. Only explicit user cancellations rewind a
/// not-yet-answered user turn out of history: nothing restores the prompt
/// after any other stop, so rewinding would erase the user's message.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AbortReason {
    CliAbort,
    UserCancel,
    TurnAbort,
    /// A user cancel the host will not answer with the prompt back in the
    /// input box: the unanswered prompt stays in the stored transcript.
    UserCancelKeepPrompt,
    /// A queued user submission interrupted the active request.
    Interrupt,
    ProviderError,
    ProcessCrash,
    /// Engine shutdown, idle sweep, runner crash: not a user cancel.
    Other,
    /// Node's null `closeReason` (a wrapped abort that names none): the legacy user-cancel treatment.
    Unnamed,
}

impl AbortReason {
    /// The close/abort reason name Node passes (`abortRuntime(reason)`, `closeSession(id, reason)`) as
    /// `finalizeInterruptedTurn` reads it: the user's stops are `USER_CANCEL_ABORT_REASONS`, `interrupt`,
    /// `provider-error` and `process-crash` are named, and any other reason (`cli-agent-close`, a delete, a
    /// shutdown) is a non-user stop.
    pub fn from_name(name: &str) -> Self {
        match name {
            "cli-abort" => Self::CliAbort,
            "user-cancel" => Self::UserCancel,
            "turn-abort" => Self::TurnAbort,
            "user-cancel-keep-prompt" => Self::UserCancelKeepPrompt,
            "interrupt" => Self::Interrupt,
            "provider-error" => Self::ProviderError,
            "process-crash" => Self::ProcessCrash,
            _ => Self::Other,
        }
    }

    fn user_cancel(self) -> bool {
        matches!(
            self,
            Self::CliAbort | Self::UserCancel | Self::TurnAbort | Self::UserCancelKeepPrompt | Self::Unnamed
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Streaming,
    Tools,
}

pub struct Interrupted {
    /// The transcript at the stop.
    pub transcript: Vec<AgentMessage>,
    /// Text of the user turn this ask started with.
    pub current_user_text: String,
    pub response_started: bool,
    pub partial_assistant: String,
    pub partial_reasoning: String,
    pub observed_tool_calls: Vec<ToolCall>,
    pub observed_tool_results: Vec<AgentMessage>,
    pub phase: Phase,
    pub reason: AbortReason,
}

#[derive(Debug, PartialEq)]
pub struct Finalized {
    pub transcript: Vec<AgentMessage>,
    pub response_preserved: bool,
    pub user_turn_preserved: bool,
    /// The message `finalizeInterruptedTurn` stamps `meta.sentRequestTail` on: killed with a request on the
    /// wire, the provider received the transcript up to it. Its index in `transcript`.
    pub sent_request_tail: Option<usize>,
}

fn provisional_user_turn(messages: &[AgentMessage], current_text: &str) -> Option<usize> {
    messages
        .iter()
        .rposition(|m| m.role() == Role::User && m.text() == current_text)
}

pub fn finalize_interrupted_turn(input: Interrupted) -> Finalized {
    let Interrupted {
        transcript,
        current_user_text,
        response_started,
        partial_assistant,
        partial_reasoning,
        observed_tool_calls,
        observed_tool_results,
        phase,
        reason,
    } = input;
    let mut messages = transcript;
    let user_cancelled = reason.user_cancel();
    let provisional = provisional_user_turn(&messages, &current_user_text);
    // A turn cancelled while the model was only thinking produced no
    // model-visible message. Anything the model said or did keeps the turn.
    let produced_output = !mixdog_js::js_trim(&partial_assistant).is_empty()
        || !observed_tool_calls.is_empty()
        || !observed_tool_results.is_empty()
        || provisional.is_some_and(|index| index + 1 < messages.len());
    let preserve_response = response_started && (produced_output || !user_cancelled);
    if !preserve_response {
        if !user_cancelled || reason == AbortReason::UserCancelKeepPrompt {
            if reason == AbortReason::UserCancelKeepPrompt && provisional.is_some() {
                messages.push(AgentMessage::user(SESSION_INTERRUPT_MESSAGE));
            }
            return Finalized {
                transcript: messages,
                response_preserved: false,
                user_turn_preserved: true,
                sent_request_tail: None,
            };
        }
        // The prompt goes back to the input box: remove the provisional user
        // turn plus pre-send hooks appended after it, keeping any compaction
        // rewrite before it.
        if let Some(index) = provisional {
            messages.truncate(index);
        }
        return Finalized {
            transcript: messages,
            response_preserved: false,
            user_turn_preserved: false,
            sent_request_tail: None,
        };
    }
    let sent_tail = messages
        .last()
        .filter(|last| phase == Phase::Streaming && matches!(last.role(), Role::Tool | Role::User))
        .cloned();
    append_observed_output(
        &mut messages,
        &partial_assistant,
        &partial_reasoning,
        observed_tool_calls,
        &observed_tool_results,
    );
    let mut paired = sanitize_tool_pairs(&messages);
    // The marker is omitted when a queued user submission interrupted the
    // request: that message is the boundary.
    if !matches!(
        reason,
        AbortReason::Interrupt | AbortReason::ProviderError
    ) {
        let content = if reason == AbortReason::ProcessCrash {
            PROCESS_RESTART_INTERRUPT_MESSAGE
        } else if user_cancelled {
            if phase == Phase::Tools {
                INTERRUPT_MESSAGE_FOR_TOOL_USE
            } else {
                INTERRUPT_MESSAGE
            }
        } else {
            SESSION_INTERRUPT_MESSAGE
        };
        paired.push(AgentMessage::user(content));
    }
    let sent_request_tail = sent_tail.and_then(|tail| paired.iter().rposition(|m| *m == tail));
    Finalized {
        transcript: paired,
        response_preserved: true,
        user_turn_preserved: true,
        sent_request_tail,
    }
}

/// One row of a turn recovered after the process died in it.
#[derive(Debug, PartialEq)]
pub enum RecoveredRow {
    /// The stored row at `index`, as stored (with `meta.sentRequestTail` when the request ended with it).
    Kept { index: usize, body: serde_json::Value },
    /// A row the recovery adds: a call closed as cancelled, or the restart line.
    New { role: &'static str, body: serde_json::Value },
}

/// Node's restart recovery of a turn the process died in (`recoverTurnCheckpoint`, `finalizeInterruptedTurn` with
/// `process-crash`): every unanswered call closed as cancelled, the restart line, and `sentRequestTail` on the row
/// the request ended with. `rows` are the stored model rows of the context. The core keeps no partial stream, so the
/// cut turn is what its committed rows show: it had started a response when a row follows its prompt, and was in its
/// tool phase when the last row is a call batch.
pub fn recover_after_restart(rows: &[serde_json::Value]) -> Result<Vec<RecoveredRow>, String> {
    let known = rows.iter().map(crate::message_row::message_of).collect::<Result<Vec<_>, _>>()?;
    let last = known.last();
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: known.clone(),
        current_user_text: String::new(),
        response_started: last.is_some_and(|message| message.role() != Role::User),
        partial_assistant: String::new(),
        partial_reasoning: String::new(),
        observed_tool_calls: Vec::new(),
        observed_tool_results: Vec::new(),
        phase: if last.is_some_and(|message| !message.assistant_call_ids().is_empty()) { Phase::Tools } else { Phase::Streaming },
        reason: AbortReason::ProcessCrash,
    });
    let mut out = Vec::with_capacity(finalized.transcript.len());
    for (index, message) in finalized.transcript.iter().enumerate() {
        let tail = finalized.sent_request_tail == Some(index);
        let stamp = |mut body: serde_json::Value| {
            if tail && let Some(object) = body.as_object_mut() {
                let meta = object.entry("meta").or_insert_with(|| serde_json::json!({}));
                if let Some(meta) = meta.as_object_mut() {
                    meta.insert("sentRequestTail".into(), serde_json::Value::Bool(true));
                }
            }
            body
        };
        if known.get(index).is_some_and(|was| was == message) {
            out.push(RecoveredRow::Kept { index, body: stamp(rows[index].clone()) });
        } else {
            let role = match message.role() {
                Role::Assistant => "assistant",
                Role::Tool => "tool",
                _ => "user",
            };
            out.push(RecoveredRow::New { role, body: stamp(crate::message_row::row_of(message)) });
        }
    }
    Ok(out)
}

fn append_observed_output(
    messages: &mut Vec<AgentMessage>,
    partial_assistant: &str,
    partial_reasoning: &str,
    observed_calls: Vec<ToolCall>,
    observed_results: &[AgentMessage],
) {
    let represented: Vec<String> = messages
        .iter()
        .flat_map(AgentMessage::assistant_call_ids)
        .collect();
    let unrepresented: Vec<ToolCall> = observed_calls
        .into_iter()
        .filter(|call| !call.id.is_empty() && !represented.contains(&call.id))
        .collect();
    if !partial_assistant.is_empty() || !partial_reasoning.is_empty() || !unrepresented.is_empty() {
        let mut assistant = AgentMessage::assistant(partial_assistant, unrepresented);
        if !partial_reasoning.is_empty() {
            assistant.reasoning = Some(partial_reasoning.to_owned());
        }
        messages.push(assistant);
    }
    let mut answered: Vec<String> = messages
        .iter()
        .filter(|m| m.role() == Role::Tool)
        .filter_map(|m| m.tool_call_id().map(str::to_owned))
        .collect();
    for result in observed_results {
        let Some(id) = result.tool_call_id() else {
            continue;
        };
        if answered.iter().any(|a| a == id) {
            continue;
        }
        answered.push(id.to_owned());
        // `recordToolResult` keeps of an early notice its role, content, call id and kind (an error flag stands for the kind it
        // lacks), nothing more (`turn-interruption.mjs:291`).
        let kind = result.tool_kind.or(result.message.is_error.then_some(ToolKind::Error));
        let mut kept = AgentMessage::tool_result(id, result.message.content.clone(), kind.unwrap_or(ToolKind::Normal));
        kept.tool_kind = kind;
        messages.push(kept);
    }
    let all_calls: Vec<String> = messages
        .iter()
        .flat_map(AgentMessage::assistant_call_ids)
        .collect();
    for id in all_calls {
        if answered.contains(&id) {
            continue;
        }
        messages.push(AgentMessage::tool_text(
            id.clone(),
            INTERRUPTED_TOOL_RESULT,
            ToolKind::Error,
        ));
        answered.push(id);
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::JsonValue;

    use super::*;

    fn input(transcript: Vec<AgentMessage>) -> Interrupted {
        Interrupted {
            transcript,
            current_user_text: "go".into(),
            response_started: true,
            partial_assistant: String::new(),
            partial_reasoning: String::new(),
            observed_tool_calls: Vec::new(),
            observed_tool_results: Vec::new(),
            phase: Phase::Streaming,
            reason: AbortReason::UserCancel,
        }
    }

    #[test]
    fn thinking_only_cancel_rewinds_the_prompt() {
        let mut turn = input(vec![AgentMessage::user("earlier"), AgentMessage::user("go")]);
        turn.partial_reasoning = "hmm".into();
        let done = finalize_interrupted_turn(turn);
        assert_eq!(done.transcript.len(), 1);
        assert!(!done.user_turn_preserved && !done.response_preserved);
    }

    #[test]
    fn partial_text_is_kept_with_the_interruption_marker() {
        let mut turn = input(vec![AgentMessage::user("go")]);
        turn.partial_assistant = "half an ans".into();
        let done = finalize_interrupted_turn(turn);
        let texts: Vec<String> = done.transcript.iter().map(AgentMessage::text).collect();
        assert_eq!(texts, ["go", "half an ans", INTERRUPT_MESSAGE]);
        assert_eq!(done.sent_request_tail, Some(0), "killed with the request on the wire: the prompt is the sent tail");
    }

    fn message_from(row: &serde_json::Value) -> AgentMessage {
        let text = row["content"].as_str().unwrap_or_default();
        match row["role"].as_str().unwrap() {
            "user" => AgentMessage::user(text),
            "assistant" => {
                let calls = row["toolCalls"].as_array().into_iter().flatten().map(call_from).collect();
                AgentMessage::assistant(text, calls)
            }
            _ => {
                let mut message = AgentMessage::tool_text(row["toolCallId"].as_str().unwrap(), text, ToolKind::Normal);
                message.tool_kind = (row["toolKind"] == "error").then_some(ToolKind::Error);
                message
            }
        }
    }

    fn call_from(call: &serde_json::Value) -> ToolCall {
        ToolCall { id: call["id"].as_str().unwrap().into(), name: call["name"].as_str().unwrap().into(), arguments: JsonValue::Null, native_type: None }
    }

    /// What Node's `finalizeTurnInterruptionSnapshot` gave these interruptions
    /// (`fixtures/interrupt/golden.json`, `record-interrupt.mjs`): the finalized transcript, which message carries
    /// `sentRequestTail`, and whether the response and the user turn were kept.
    #[test]
    fn every_interruption_is_finalized_as_node_does() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/interrupt/golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 17);
        for case in cases {
            let snapshot = &case["snapshot"];
            let phase = if snapshot["phase"] == "tools" { Phase::Tools } else { Phase::Streaming };
            let pairs = |key: &str| snapshot[key].as_array().into_iter().flatten().map(|pair| pair[1].clone()).collect::<Vec<_>>();
            let done = finalize_interrupted_turn(Interrupted {
                transcript: case["transcript"].as_array().unwrap().iter().map(message_from).collect(),
                current_user_text: case["current"].as_str().unwrap().into(),
                response_started: snapshot["responseStarted"] == true,
                partial_assistant: snapshot["partialAssistantContent"].as_str().unwrap().into(),
                partial_reasoning: snapshot["partialReasoningContent"].as_str().unwrap().into(),
                observed_tool_calls: pairs("observedToolCalls").iter().map(|entry| call_from(&entry["call"])).collect(),
                observed_tool_results: pairs("observedToolResults").iter().map(message_from).collect(),
                phase,
                reason: AbortReason::from_name(case["reason"].as_str().unwrap()),
            });
            let shown: Vec<serde_json::Value> = done
                .transcript
                .iter()
                .map(|m| {
                    let role = match m.role() {
                        Role::User => "user",
                        Role::Assistant => "assistant",
                        _ => "tool",
                    };
                    serde_json::json!([role, m.text(), m.tool_call_id(), (m.tool_kind == Some(ToolKind::Error)).then_some("error")])
                })
                .collect();
            let want: Vec<serde_json::Value> = case["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| serde_json::json!([m["role"], m["content"], m.get("toolCallId").cloned().unwrap_or_default(), m.get("toolKind").filter(|k| *k == "error").cloned().unwrap_or_default()]))
                .collect();
            let name = &case["name"];
            assert_eq!(shown, want, "{name}");
            assert_eq!((done.response_preserved, done.user_turn_preserved), (case["responsePreserved"] == true, case["userTurnPreserved"] == true), "{name}");
            let stamped = case["messages"].as_array().unwrap().iter().position(|m| m.pointer("/meta/sentRequestTail") == Some(&serde_json::Value::Bool(true)));
            assert_eq!(done.sent_request_tail, stamped, "{name}: sentRequestTail");
        }
    }

    #[test]
    fn an_abort_carries_its_typed_reason_from_the_name_node_gives_it() {
        use crate::cancel::{Abort, Cancel, CLI_ABORT};
        assert_eq!(Abort::runtime_abort("s", CLI_ABORT).reason, AbortReason::CliAbort);
        assert_eq!(Abort::close_session("s", "cli-agent-close").reason, AbortReason::Other);
        assert_eq!(Abort::runtime_abort("s", "user-cancel-keep-prompt").reason, AbortReason::UserCancelKeepPrompt);
        assert_eq!(Abort::runtime_abort("s", "interrupt").reason, AbortReason::Interrupt);
        assert_eq!(Abort::runtime_close("s", "cli-exit").reason, AbortReason::Other);
        let signal = Cancel::new();
        signal.abort_with(&Abort::abort_session_turn("s", "user-cancel"));
        signal.abort_with(&Abort::close_session("s", "cli-agent-close"));
        assert_eq!((signal.close_reason(), Abort::of_signal(&signal).reason), (AbortReason::UserCancel, AbortReason::UserCancel), "the first abort keeps its reason");
        let bare = Cancel::new();
        bare.abort("parent aborted");
        assert_eq!(bare.close_reason(), AbortReason::Unnamed, "a source with no close reason is Node's null reason");
    }
    #[test]
    fn a_stop_in_the_tool_phase_stamps_no_sent_tail() {
        let mut turn = input(vec![AgentMessage::user("go")]);
        turn.partial_assistant = "x".into();
        turn.phase = Phase::Tools;
        assert_eq!(finalize_interrupted_turn(turn).sent_request_tail, None);
    }

    #[test]
    fn unanswered_calls_are_closed_as_cancelled() {
        let call = ToolCall {
            id: "c1".into(),
            name: "shell".into(),
            arguments: JsonValue::Null,
            native_type: None,
        };
        let mut turn = input(vec![
            AgentMessage::user("go"),
            AgentMessage::assistant("", vec![call]),
        ]);
        turn.phase = Phase::Tools;
        let done = finalize_interrupted_turn(turn);
        let last_two: Vec<String> = done.transcript[2..].iter().map(AgentMessage::text).collect();
        assert_eq!(last_two, [INTERRUPTED_TOOL_RESULT, INTERRUPT_MESSAGE_FOR_TOOL_USE]);
        assert_eq!(done.transcript[2].tool_kind, Some(ToolKind::Error));
    }

    #[test]
    fn a_non_user_stop_keeps_the_prompt() {
        let mut turn = input(vec![AgentMessage::user("go")]);
        turn.response_started = false;
        turn.reason = AbortReason::Other;
        let done = finalize_interrupted_turn(turn);
        assert_eq!(done.transcript.len(), 1);
        assert!(done.user_turn_preserved);
    }
}
