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
}

impl AbortReason {
    fn user_cancel(self) -> bool {
        matches!(
            self,
            Self::CliAbort | Self::UserCancel | Self::TurnAbort | Self::UserCancelKeepPrompt
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
    /// `None` keeps the user-cancel treatment.
    pub reason: Option<AbortReason>,
}

#[derive(Debug, PartialEq)]
pub struct Finalized {
    pub transcript: Vec<AgentMessage>,
    pub response_preserved: bool,
    pub user_turn_preserved: bool,
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
    let user_cancelled = reason.is_none_or(AbortReason::user_cancel);
    let provisional = provisional_user_turn(&messages, &current_user_text);
    // A turn cancelled while the model was only thinking produced no
    // model-visible message. Anything the model said or did keeps the turn.
    let produced_output = !mixdog_js::js_trim(&partial_assistant).is_empty()
        || !observed_tool_calls.is_empty()
        || !observed_tool_results.is_empty()
        || provisional.is_some_and(|index| index + 1 < messages.len());
    let preserve_response = response_started && (produced_output || !user_cancelled);
    if !preserve_response {
        if !user_cancelled || reason == Some(AbortReason::UserCancelKeepPrompt) {
            if reason == Some(AbortReason::UserCancelKeepPrompt) && provisional.is_some() {
                messages.push(AgentMessage::user(SESSION_INTERRUPT_MESSAGE));
            }
            return Finalized {
                transcript: messages,
                response_preserved: false,
                user_turn_preserved: true,
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
        };
    }
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
        Some(AbortReason::Interrupt | AbortReason::ProviderError)
    ) {
        let content = if reason == Some(AbortReason::ProcessCrash) {
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
    Finalized {
        transcript: paired,
        response_preserved: true,
        user_turn_preserved: true,
    }
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
        messages.push(result.clone());
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
            reason: Some(AbortReason::UserCancel),
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
        turn.reason = Some(AbortReason::Other);
        let done = finalize_interrupted_turn(turn);
        assert_eq!(done.transcript.len(), 1);
        assert!(done.user_turn_preserved);
    }
}
