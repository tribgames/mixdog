//! One provider response folded from a stream, stop-reason vocabulary, the
//! assistant messages committed from it, and the termination classification.

use mixdog_core_api::domain::provider::AccountRouting;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::Usage;
use mixdog_protocol::JsonValue;

use crate::message::AgentMessage;
use crate::repair::ToolCallIds;

/// A completed (or recovered) provider turn.
#[derive(Clone, Debug, Default)]
pub struct ModelResponse {
    pub model: String,
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: Option<StopReason>,
    pub usage: Usage,
    pub replay: Vec<ProviderReplay>,
    /// Extended-thinking blocks of a turn without a block replay (Node `thinkingBlocks`); the committed message
    /// echoes them only when no replay or ordered block list stands for them (`assistantEchoFields`).
    pub thinking_blocks: Option<JsonValue>,
    /// Provider-native blocks (server tool use) kept verbatim.
    pub server_blocks: Vec<JsonValue>,
    pub truncated: bool,
    /// The stream was cut after text the owner could not withdraw.
    pub stream_cut: bool,
    /// Runtime notice delivered after this turn's tool results.
    pub recovery_notice: Option<AgentMessage>,
    /// What history stores when `content` is an aggregate of earlier segments.
    pub history_content: Option<String>,
    /// The whole report when the ask carried earlier answers.
    pub report_content: Option<String>,
    pub max_output_recovery_attempts: Option<u32>,
    /// The session's provider state as the provider left it (Node writes
    /// `opts.providerState` back); `None` when the request did not change it.
    /// The run stores it as the pending state for the next request.
    pub provider_state: Option<ProviderState>,
    /// The request's wall time as the usage ledger measured it (Node
    /// `result.response.usageDurationMs`), from `Completed.request_ms`; `None`
    /// when the send was not accounted, and the loop's own clock stands in.
    pub request_ms: Option<u64>,
    /// The roster account that served the answer (Node `providerMetadata.accountRouting`).
    pub account_routing: Option<AccountRouting>,
}

impl ModelResponse {
    pub fn has_content(&self) -> bool {
        !mixdog_js::js_trim(&self.content).is_empty()
    }

    /// The text history stores for this response.
    pub fn history_text(&self) -> &str {
        self.history_content.as_deref().unwrap_or(&self.content)
    }
}

/// Folds stream events into a [`ModelResponse`]. Deltas are hints; the folded
/// result is the truth.
pub struct ResponseBuilder {
    response: ModelResponse,
    ids: ToolCallIds,
    /// The id each live call was resolved to, by the id the provider gave it.
    resolved: std::collections::HashMap<String, String>,
    completed: bool,
}

impl ResponseBuilder {
    pub fn new(model: &str, ids: ToolCallIds) -> Self {
        Self {
            response: ModelResponse {
                model: model.to_owned(),
                ..ModelResponse::default()
            },
            ids,
            resolved: std::collections::HashMap::new(),
            completed: false,
        }
    }

    pub fn push(&mut self, event: StreamEvent) {
        let response = &mut self.response;
        match event {
            StreamEvent::TextDelta(text) => response.content.push_str(&text),
            StreamEvent::ReasoningDelta(text) => response.reasoning.push_str(&text),
            StreamEvent::ReasoningReplay(replay) => response.replay.push(replay),
            StreamEvent::FinalContent(text) => response.content = text,
            StreamEvent::ReturnedCalls(calls) => {
                // A call that also ran live keeps the id it was resolved to then.
                response.tool_calls = calls
                    .into_iter()
                    .map(|mut call| {
                        match self.resolved.get(&call.id) {
                            Some(id) => call.id = id.clone(),
                            None => self.ids.resolve(&mut call),
                        }
                        call
                    })
                    .collect();
            }
            StreamEvent::ThinkingBlocks(blocks) => response.thinking_blocks = Some(blocks),
            StreamEvent::ToolCallDone(mut call) => {
                let original = call.id.clone();
                self.ids.resolve(&mut call);
                self.resolved.insert(original, call.id.clone());
                response.tool_calls.push(call);
            }
            StreamEvent::Usage(usage) => response.usage = usage,
            StreamEvent::ProviderState(state) => response.provider_state = Some(state),
            StreamEvent::ServedModel(model) => response.model = model,
            StreamEvent::AccountRouting(routing) => response.account_routing = Some(routing),
            StreamEvent::ServerToolBlock(block) => response.server_blocks.push(block),
            StreamEvent::Completed { stop, request_ms, .. } => {
                response.stop = stop;
                response.request_ms = request_ms;
                self.completed = true;
            }
            StreamEvent::ItemStart { .. }
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::Refusal(_)
            | StreamEvent::Citation(_)
            | StreamEvent::ProviderKeepalive
            | StreamEvent::Notice { .. }
            | StreamEvent::AccountStage(_)
            | StreamEvent::WireRerouted(_)
            | StreamEvent::Progress(_)
            | StreamEvent::ChunkProgress(_) => {}
        }
    }

    pub fn completed(&self) -> bool {
        self.completed
    }

    pub fn so_far(&self) -> &ModelResponse {
        &self.response
    }

    pub fn finish(self) -> ModelResponse {
        self.response
    }
}

// ---------------------------------------------------------------------------
// Stop-reason vocabulary
// ---------------------------------------------------------------------------

/// The provider-neutral spelling of a stop reason (used in runtime prompts).
pub fn stop_text(stop: &StopReason) -> String {
    match stop {
        StopReason::EndTurn => "end_turn".into(),
        StopReason::ToolUse => "tool_use".into(),
        StopReason::MaxTokens => "max_tokens".into(),
        StopReason::StopSequence => "stop_sequence".into(),
        StopReason::ContentFilter => "content_filter".into(),
        StopReason::Refusal => "refusal".into(),
        StopReason::ContinueTurn => "end_turn_false".into(),
        StopReason::Other(value) => value.clone(),
    }
}

/// True output ceilings. `pause_turn` is a provider-controlled pause and
/// `OTHER` is opaque; neither is a token-cap continuation.
pub fn is_output_limit(stop: Option<&StopReason>) -> bool {
    match stop {
        Some(StopReason::MaxTokens) => true,
        Some(StopReason::Other(value)) => matches!(
            mixdog_js::js_trim(value).to_ascii_lowercase().as_str(),
            "length" | "max_tokens" | "max_output_tokens"
        ),
        _ => false,
    }
}

/// Stops that signal the turn was cut short mid-synthesis (empty-turn nudge
/// semantics); wider than [`is_output_limit`].
pub fn is_incomplete(stop: Option<&StopReason>) -> bool {
    match stop {
        Some(StopReason::MaxTokens) => true,
        Some(StopReason::Other(value)) => {
            matches!(
                value.as_str(),
                "pause_turn" | "max_tokens" | "length" | "MAX_TOKENS" | "OTHER"
            )
        }
        _ => false,
    }
}

/// A provider-declared continuation: the provider intends to keep sampling
/// inside the same user turn. Structural only.
pub fn continuation_signal(stop: Option<&StopReason>) -> Option<&'static str> {
    match stop {
        Some(StopReason::ContinueTurn) => Some("end_turn_false"),
        Some(StopReason::Other(value)) if mixdog_js::js_trim(value).eq_ignore_ascii_case("pause_turn") => {
            Some("pause_turn")
        }
        _ => None,
    }
}

/// Why a loop ended abnormally, so the owner can promote an empty or cut
/// finish to an explicit error instead of a silent "completed".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Termination {
    Refusal,
    Truncated,
    Empty,
}

/// `hidden_agent`: hidden roles legitimately end with text-only or empty turns.
pub fn classify_termination(response: &ModelResponse, hidden_agent: bool) -> Option<Termination> {
    let has_content = response.has_content() || !mixdog_js::js_trim(&response.reasoning).is_empty();
    let stop = response.stop.as_ref();
    if matches!(stop, Some(StopReason::Refusal)) {
        return Some(Termination::Refusal);
    }
    if is_output_limit(stop) || (!has_content && is_incomplete(stop)) {
        return Some(Termination::Truncated);
    }
    if !has_content && !hidden_agent {
        return Some(Termination::Empty);
    }
    None
}

// ---------------------------------------------------------------------------
// Assistant messages
// ---------------------------------------------------------------------------

fn echo(message: &mut AgentMessage, response: &ModelResponse, keep_blocks: bool) {
    for replay in &response.replay {
        message.message.push_replay(replay.clone());
    }
    // Native blocks exist only in this list and are order-bound; a complete
    // provider replay already holds every block, so it wins.
    if keep_blocks && response.replay.is_empty() && !response.server_blocks.is_empty() {
        message.message.assistant_blocks = Some(JsonValue::Array(response.server_blocks.clone()));
    }
    if response.replay.is_empty() && message.message.assistant_blocks.is_none() {
        message.message.thinking_blocks = response.thinking_blocks.clone();
    }
    if !response.reasoning.is_empty() {
        message.reasoning = Some(response.reasoning.clone());
    }
    // `recordServingAccount`: the message stores which account served it (`providerMetadata.accountRouting`).
    if let Some(routing) = &response.account_routing {
        let mut metadata = match message.provider_metadata.take() {
            Some(JsonValue::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        let mut row = serde_json::Map::new();
        row.insert("provider".into(), routing.provider.clone().into());
        row.insert("accountId".into(), routing.account_id.clone().into());
        if let Some(session) = &routing.session_account_id {
            row.insert("sessionAccountId".into(), session.clone().into());
        }
        metadata.insert("accountRouting".into(), JsonValue::Object(row));
        message.provider_metadata = Some(JsonValue::Object(metadata));
    }
}

/// The intermediate (no client tool call) assistant turn: max-output partials,
/// refusal narration, provider continuations, the terminal turn committed
/// before a steering drain. `None` when nothing is committable.
pub fn intermediate_message(response: &ModelResponse) -> Option<AgentMessage> {
    let keep_blocks = response.tool_calls.is_empty();
    let blocks = keep_blocks && response.replay.is_empty() && !response.server_blocks.is_empty();
    if response.content.is_empty()
        && response.reasoning.is_empty()
        && response.replay.is_empty()
        && response.thinking_blocks.is_none()
        && !blocks
    {
        return None;
    }
    let mut message = AgentMessage::assistant(response.content.clone(), Vec::new());
    echo(&mut message, response, keep_blocks);
    message.stop_reason = response.stop.clone();
    Some(message)
}

/// The tool-call assistant turn. Its call list stays authoritative.
pub fn tool_call_message(response: &ModelResponse) -> AgentMessage {
    let mut message = AgentMessage::assistant(response.content.clone(), response.tool_calls.clone());
    echo(&mut message, response, true);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_limit_and_incomplete_vocabulary() {
        assert!(is_output_limit(Some(&StopReason::MaxTokens)));
        assert!(is_output_limit(Some(&StopReason::Other(" Length ".into()))));
        assert!(!is_output_limit(Some(&StopReason::Other("pause_turn".into()))));
        assert!(is_incomplete(Some(&StopReason::Other("pause_turn".into()))));
        assert!(!is_incomplete(Some(&StopReason::Other("other".into()))));
        assert_eq!(
            continuation_signal(Some(&StopReason::Other("pause_turn".into()))),
            Some("pause_turn")
        );
    }

    #[test]
    fn the_ledgers_request_time_rides_the_terminal_event() {
        let fold = |request_ms| {
            let mut builder = ResponseBuilder::new("m", ToolCallIds::new(&[]));
            builder.push(StreamEvent::Completed { stop: None, pricing_model: None, request_ms });
            builder.finish().request_ms
        };
        assert_eq!(fold(Some(1_250)), Some(1_250));
        assert_eq!(fold(None), None);
    }

    #[test]
    fn thinking_blocks_and_a_final_content_reach_the_committed_message() {
        // Both outcomes are what Node recorded (`fixtures/agent/leaked-toolcall/record.mjs`): the thinking blocks of
        // an Anthropic turn whose call leaked as stored on its assistant message, and the content the compatible
        // Responses collector returns when the guard hid all of the text.
        let golden: serde_json::Value =
            serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/leaked-toolcall/golden/leaked_toolcall.json")).unwrap();
        let scenario = |route: &str, name: &str| {
            golden["scenarios"].as_array().unwrap().iter().find(|s| s["route"] == route && s["name"] == name).unwrap().clone()
        };
        let anthropic = scenario("anthropic", "an invoke tag in the answer");
        let stored = &anthropic["stored"]["messages"][0];
        let blocks = stored["thinkingBlocks"].clone();
        let node_call = &stored["toolCalls"][0];
        let compat = scenario("responses-compat", "only leaked calls, nothing else visible");
        let node_content = compat["result"]["content"].as_str().unwrap();

        let mut builder = ResponseBuilder::new("m", ToolCallIds::new(&[]));
        builder.push(StreamEvent::TextDelta(String::new()));
        builder.push(StreamEvent::FinalContent(node_content.to_owned()));
        builder.push(StreamEvent::ThinkingBlocks(blocks.clone()));
        let response = builder.finish();
        assert_eq!(response.content, node_content);
        let call = ToolCall {
            id: "toolu_leaked_0123456789abcdef".into(),
            name: node_call["name"].as_str().unwrap().into(),
            arguments: node_call["arguments"].clone(),
            native_type: None,
        };
        let message = tool_call_message(&ModelResponse { tool_calls: vec![call], ..response });
        assert_eq!(message.message.thinking_blocks.as_ref(), Some(&blocks));
    }
    #[test]
    fn the_serving_key_is_stored_on_the_message_and_read_back_for_the_next_send() {
        // Node's answer from the second key (`fixtures/provider-gateways/custom-keys-switch.json`): its
        // `providerMetadata` is what the session stores on the assistant message.
        let scenario: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/provider-gateways/custom-keys-switch.json")).unwrap();
        let node = &scenario["sends"][0]["result"];
        let routing = &node["providerMetadata"]["accountRouting"];
        let served = AccountRouting {
            provider: routing["provider"].as_str().unwrap().into(),
            account_id: routing["accountId"].as_str().unwrap().into(),
            session_account_id: routing["sessionAccountId"].as_str().map(str::to_owned),
        };
        let mut builder = ResponseBuilder::new("m1", ToolCallIds::new(&[]));
        builder.push(StreamEvent::TextDelta(node["content"].as_str().unwrap().into()));
        builder.push(StreamEvent::AccountRouting(served.clone()));
        let message = intermediate_message(&builder.finish()).unwrap();
        assert_eq!(message.provider_metadata.as_ref(), Some(&node["providerMetadata"]));
        assert_eq!(message.wire().account_routing, Some(served));
    }

    #[test]
    fn termination_follows_content_and_stop() {
        let empty = ModelResponse::default();
        assert_eq!(classify_termination(&empty, false), Some(Termination::Empty));
        assert_eq!(classify_termination(&empty, true), None);
        let cut = ModelResponse {
            content: "x".into(),
            stop: Some(StopReason::MaxTokens),
            ..ModelResponse::default()
        };
        assert_eq!(classify_termination(&cut, false), Some(Termination::Truncated));
    }
}
