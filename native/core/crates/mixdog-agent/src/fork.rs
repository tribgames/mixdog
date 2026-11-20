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
    // A fork is its own logical request: it shares no ids, deadlines or output state with the send it was saved from.
    options.send_identity = Default::default();
    options.max_output_tokens_override = None;
    if options.tool_choice.as_deref() != Some("none") {
        options.tool_choice = None;
    }
    // A fork is an optional reuse of the parent's prefix: its cache owner skips it on a cold prefix rather than compact the
    // parent from inside it. A side question sets its own purpose.
    options.tail_purpose = mixdog_core_api::domain::cache_tail::Purpose::SummaryFork;
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
    // A saved request may still carry the tail reminder it was sent with: the fork starts from the messages before it.
    let kept = crate::send::kept_messages(saved);
    let mut messages = kept.to_vec();
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
    if !kept.is_empty() {
        options.shared_cache_prefix_count = Some(kept.len());
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

/// One provider send, folded into the whole response. Responses WebSocket recovery
/// belongs to the provider, just as for the main loop; no second caller retry
/// precedes the isolated summary request when that recovery fails.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured provider/tool/run failure by value without boxing or changing this API")]
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
        let options =
            RequestOptions { send_group: Some("g".into()), max_output_tokens_override: Some(9), tool_choice: Some("auto".into()), ..RequestOptions::default() };
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

    /// The store keeps the request as sent, its tail reminder included: its fork is the fork of the request without it.
    #[test]
    fn a_sent_request_forks_as_the_request_without_its_tail_reminder() {
        let reply = ModelResponse { content: "done".into(), ..ModelResponse::default() };
        let sent = crate::send::with_tail_reminder(&saved(), Some("remember"));
        assert_eq!(sent.messages.len(), 2, "the reminder rides last");
        assert_eq!(crate::send::kept_messages(&sent), &saved().messages[..]);
        for reply in [None, Some(&reply)] {
            assert_eq!(forked_request(&sent, reply, "summarize"), forked_request(&crate::send::without_tail_reminder(&sent), reply, "summarize"));
        }
    }

    #[test]
    fn a_request_with_no_settled_reply_forks_to_its_messages_and_the_prompt() {
        let fork = forked_request(&saved(), None, "summarize");
        assert_eq!(fork.messages.len(), 2);
    }

    /// An adapter that counts the attempts it is given.
    struct Counting {
        inner: mixdog_core_api::domain::mock::MockProvider,
        attempts: std::sync::atomic::AtomicU32,
    }

    #[async_trait::async_trait]
    impl ProviderAdapter for Counting {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &mixdog_protocol::ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn mixdog_core_api::domain::provider::WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, ProviderError> {
            self.attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.inner.attempt(request).await
        }
    }

    /// Side questions and compaction forks send through `send_forked`, one `attempt` of the registered provider, which is
    /// under the egress guard: an image its route cannot take (here a route that declares none) refuses the fork, naming nothing
    /// as sent, before the adapter is asked.
    #[tokio::test]
    async fn a_fork_carrying_an_image_no_route_declared_is_refused_before_the_adapter_is_asked() {
        use base64::Engine as _;
        let counting = Arc::new(Counting { inner: mixdog_core_api::domain::mock::MockProvider::new([]), attempts: Default::default() });
        let provider: Arc<dyn ProviderAdapter> = mixdog_ai::registry::egress::EgressGuard::wrap(counting.clone());
        let heic = base64::engine::general_purpose::STANDARD.encode(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic");
        let image = mixdog_core_api::domain::provider::ContentPart::Image(mixdog_core_api::domain::provider::ImageSource::Base64 {
            data: heic,
            mime_type: "image/heic".into(),
            width: None,
            height: None,
        });
        let mut request = saved();
        request.messages = vec![Message::new(Role::User, Content::Parts(vec![image]))];
        let fork = forked_request(&request, None, "summarize");
        let error = send_forked(&provider, fork, &CancellationToken::new()).await.unwrap_err();
        assert!(error.message.starts_with("Nothing was sent."), "{}", error.message);
        assert!(!error.message.contains("/compact"), "never prescribe /compact: {}", error.message);
        assert_eq!(counting.attempts.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
