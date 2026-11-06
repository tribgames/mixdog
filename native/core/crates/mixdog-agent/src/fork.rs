//! The fork of a request the main loop already sent (Node `request-fork.mjs`): its messages unchanged,
//! then the reply that request produced with a stub result per tool call, then one appended user turn.
//! Reusing the saved options keeps the model, system prompt, tools and cache-relevant options identical,
//! so the provider's prompt cache serves the prefix.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::TransportFault;
use tokio_util::sync::CancellationToken;

use crate::compact::estimate::MessageMeter;
use crate::compact::tool_schema::RequestTools;
use crate::compact::tool_schema::estimate_request_reserve_tokens;
use crate::env::or_cancelled;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;
use crate::repair::ToolCallIds;
use crate::response::ModelResponse;
use crate::response::ResponseBuilder;
use crate::response::intermediate_message;
use crate::response::tool_call_message;

/// `FORK_TOOL_STUB`: each call of the reply only needs an answer so the request stays well-formed.
pub const FORK_TOOL_STUB: &str = "Result omitted from this summary request; the call and its result are kept after the summary.";

/// `buildForkedRequest`: `saved` with `reply` (when its send settled) and `prompt` as the final user
/// turn. The provider continuation state follows the reply when there is one; the shared prefix count
/// keeps an Anthropic message breakpoint on the prefix, so the fork reads the saved request's cache
/// entry and writes none for its suffix. What belongs to the loop's send (the logical send, an
/// escalated output ceiling, a tool choice other than `none`) does not carry over.
pub fn fork_options(saved: &RequestOptions) -> RequestOptions {
    let mut options = saved.clone();
    options.send_group = None;
    options.max_output_tokens_override = None;
    if options.tool_choice.as_deref() != Some("none") {
        options.tool_choice = None;
    }
    options
}

/// `buildForkedRequest`'s request.
pub fn forked_request(saved: &ModelRequest, reply: Option<&ModelResponse>, prompt: &str) -> ModelRequest {
    forked_request_stubbed(saved, reply, prompt, FORK_TOOL_STUB)
}

/// [`forked_request`] with the text that answers each tool call of the reply (a side question's own
/// stub, `SIDE_QUESTION_TOOL_STUB`).
pub fn forked_request_stubbed(saved: &ModelRequest, reply: Option<&ModelResponse>, prompt: &str, tool_stub: &str) -> ModelRequest {
    let mut options = fork_options(&saved.options);
    let mut messages = saved.messages.clone();
    let reply_message = reply.and_then(|r| if r.tool_calls.is_empty() { intermediate_message(r) } else { Some(tool_call_message(r)) });
    if let (Some(message), Some(reply)) = (reply_message, reply) {
        let ids = message.assistant_call_ids();
        messages.push(message.wire());
        for id in ids {
            messages.push(AgentMessage::tool_text(id, tool_stub, ToolKind::Normal).wire());
        }
        if reply.provider_state.is_some() {
            options.provider_state = reply.provider_state.clone();
        }
    }
    if !saved.messages.is_empty() {
        options.shared_cache_prefix_count = Some(saved.messages.len());
    }
    // A user interjection keeps its own turn, so the prefix's last block reaches the provider unchanged.
    messages.push(AgentMessage::sourced(Source::Steering, prompt).wire());
    ModelRequest { model: saved.model.clone(), messages, tools: saved.tools.clone(), options }
}

/// `estimateMessagesTokens(messages) + estimateRequestReserveTokens(tools)` of `request`: what the fork
/// weighs against the summary route's window. The request carries no provider-native tool prefix.
pub fn prompt_tokens(request: &ModelRequest, meter: &MessageMeter<'_>) -> u64 {
    let messages: Vec<AgentMessage> = request.messages.iter().cloned().map(AgentMessage::new).collect();
    meter.messages(&messages) + estimate_request_reserve_tokens(&RequestTools { native: &[], defined: &request.tools })
}

/// One attempt of `request` on `provider`, folded into the whole response. No retry: a fork that fails
/// falls back to the isolated summary request.
pub async fn send_forked(
    provider: &Arc<dyn ProviderAdapter>,
    request: ModelRequest,
    cancel: &CancellationToken,
) -> Result<Option<ModelResponse>, ProviderError> {
    let model = request.model.clone();
    let Some(attempt) = or_cancelled(cancel, provider.attempt(Arc::new(request))).await else { return Ok(None) };
    let mut stream = attempt?;
    let mut builder = ResponseBuilder::new(&model, ToolCallIds::new(&[]));
    loop {
        let Some(next) = or_cancelled(cancel, stream.next()).await else { return Ok(None) };
        match next {
            None => break,
            Some(Err(error)) => return Err(error),
            Some(Ok(event)) => builder.push(event),
        }
    }
    if !builder.completed() {
        return Err(ProviderError::transport(TransportFault::TruncatedStream, stream.delivery()));
    }
    Ok(Some(builder.finish()))
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::ToolCall;

    use super::*;

    fn saved() -> ModelRequest {
        let options = RequestOptions {
            send_group: Some("g".into()),
            max_output_tokens_override: Some(9),
            tool_choice: Some("auto".into()),
            ..RequestOptions::default()
        };
        ModelRequest { model: "m".into(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: Vec::new(), options }
    }

    #[test]
    fn a_settled_tool_call_reply_is_answered_with_stubs_and_the_prompt_closes_the_request() {
        let reply = ModelResponse {
            content: "looking".into(),
            tool_calls: vec![ToolCall { id: "c1".into(), name: "Read".into(), arguments: serde_json::json!({}), native_type: None }],
            ..ModelResponse::default()
        };
        let fork = forked_request(&saved(), Some(&reply), "summarize");
        let roles: Vec<Role> = fork.messages.iter().map(|m| m.role).collect();
        assert_eq!(roles, vec![Role::User, Role::Assistant, Role::Tool, Role::User]);
        assert_eq!(fork.messages[2].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(fork.options.shared_cache_prefix_count, Some(1));
        assert_eq!(fork.options.send_group, None);
        assert_eq!(fork.options.max_output_tokens_override, None);
        assert_eq!(fork.options.tool_choice, None);
    }

    #[test]
    fn a_request_with_no_settled_reply_forks_to_its_messages_and_the_prompt() {
        let fork = forked_request(&saved(), None, "summarize");
        assert_eq!(fork.messages.len(), 2);
    }
}