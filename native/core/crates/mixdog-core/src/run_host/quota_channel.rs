//! The production [`QuotaChannel`]: Node's `getModelProxyChannel().request({ provider, method:
//! 'quotaUsable', model })`, the daemon half of the model-proxy channel, over the host channel.
//!
//! In proxy-client mode the daemon asks the PC that declared `capabilities.modelProxy` for the
//! answer: one `model/proxy/execute` request carrying `ProxyCall::QuotaUsable` (the Rust form of
//! Node's published `{ provider, method, model }`), answered by `ProxyAnswer::Usable`. Node's
//! claim and lease run on the request itself (`HostCapability::lease`: the PC claims it with its
//! first `model/proxy/heartbeat` inside 10 s and keeps it alive inside 20 s); a PC that does not,
//! ends the request, and dropping this future tells the PC to stop (`model/proxy/cancel`).
//!
//! A PC that is gone is `ChannelError::Unavailable` with Node's `ModelProxyUnavailableError`
//! text (`model proxy unavailable: <detail>`), the one table of `model_proxy_unavailable_text`
//! (no client, disconnected, did not pick up, stopped responding). The PC's own failure is
//! `ChannelError::Failed` with the PC error's message.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::ModelProxyResult;
use mixdog_app_protocol::v2::model_proxy::{ProxyAnswer, ProxyCall, ProxyFailure};
use mixdog_core_api::ids::Method;
use mixdog_core_api::{HostCapability, HostChannel, HostError, model_proxy_unavailable_text};
use serde_json::{Value, json};

use super::quota_usage::{ChannelError, QuotaChannel};

pub(super) const EXECUTE: Method = Method("model/proxy/execute");
/// `modelProxyErrorFromWire`: an error record that cannot be read, and one without a message.
const UNREADABLE_FAILURE: &str = "model proxy call failed on the desktop client";
const EMPTY_FAILURE: &str = "model proxy call failed";

pub struct HostQuotaChannel {
    host: Arc<dyn HostChannel>,
}

impl HostQuotaChannel {
    pub fn new(host: Arc<dyn HostChannel>) -> Self {
        Self { host }
    }
}

pub(super) fn message_of(failure: ProxyFailure) -> String {
    if failure.message.is_empty() { EMPTY_FAILURE.to_owned() } else { failure.message }
}

/// The message of the PC's failed call: the `ProxyFailure` its JSON-RPC error carries as data.
pub(super) fn failure_message(data: Option<Value>) -> String {
    data.and_then(|data| serde_json::from_value::<ProxyFailure>(data).ok()).map_or_else(|| UNREADABLE_FAILURE.to_owned(), message_of)
}

#[async_trait]
impl QuotaChannel for HostQuotaChannel {
    async fn quota_usable(&self, provider: &str, model: &str) -> Result<Value, ChannelError> {
        let call = ProxyCall::QuotaUsable { provider: provider.to_owned(), model: model.to_owned() };
        let call = serde_json::to_value(call).expect("a typed call serializes");
        // A quota answer streams nothing; the streamed request is the one the PC cancels when this future is dropped.
        let mut no_events = |_: Value| {};
        let reply = self.host.request_streamed(HostCapability::ModelProxy, EXECUTE, json!({ "call": call }), &mut no_events).await;
        match reply {
            Ok(result) => match serde_json::from_value::<ModelProxyResult>(result).map(|result| result.result) {
                Ok(ProxyAnswer::Usable { usable }) => Ok(Value::Bool(usable)),
                Ok(ProxyAnswer::Failed { failure }) => Err(ChannelError::Failed(message_of(failure))),
                // Node reads any answer but `true` as not usable.
                _ => Ok(Value::Null),
            },
            Err(HostError::Core(error)) => Err(ChannelError::Unavailable(model_proxy_unavailable_text(&error).to_owned())),
            Err(HostError::Rpc { data, .. }) => Err(ChannelError::Failed(failure_message(data))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_app_protocol::v2::model_proxy::{ProxyDelivery, ProxyErrorKind, ProxyOutcome};
    use mixdog_core_api::CoreError;

    use super::*;

    /// Answers the one streamed request it is given and keeps what it was asked.
    struct Pc {
        reply: Mutex<Option<Result<Value, HostError>>>,
        asked: Mutex<Vec<(HostCapability, String, Value)>>,
    }

    impl Pc {
        fn answering(reply: Result<Value, HostError>) -> Arc<Self> {
            Arc::new(Self { reply: Mutex::new(Some(reply)), asked: Mutex::default() })
        }
    }

    #[async_trait]
    impl HostChannel for Pc {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a quota question is a streamed request")
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a quota question sends no notification")
        }

        async fn request_streamed(
            &self,
            capability: HostCapability,
            method: Method,
            params: Value,
            _: &mut (dyn FnMut(Value) + Send),
        ) -> Result<Value, HostError> {
            self.asked.lock().unwrap().push((capability, method.as_str().to_owned(), params));
            self.reply.lock().unwrap().take().expect("one question per channel")
        }
    }
    fn answer(answer: ProxyAnswer) -> Result<Value, HostError> {
        Ok(serde_json::to_value(ModelProxyResult { result: answer }).unwrap())
    }

    fn failure(message: &str) -> ProxyFailure {
        ProxyFailure {
            outcome: ProxyOutcome::Provider,
            kind: ProxyErrorKind::Unknown,
            code: Some("EPC".into()),
            status: None,
            retry_after_ms: None,
            reset_at_ms: None,
            quota_scope: None,
            reauth_required: false,
            should_retry: None,
            text_emitted: false,
            tool_dispatched: false,
            tool_input_cut: false,
            delivery: ProxyDelivery::NotSent,
            transport: None,
            message: message.into(),
            partial_usage: None,
            partial_model: None,
            verification_url: None,
            rejected_tool: None,
            account_blocked: false,
            unsafe_to_retry: false,
            quota_limit: None,
            notices: Vec::new(),
        }
    }

    fn rpc(data: Option<Value>) -> Result<Value, HostError> {
        Err(HostError::Rpc { code: -32000, message: "model proxy call failed".into(), data })
    }

    #[tokio::test]
    async fn an_answer_that_is_not_a_usable_is_not_usable_and_a_blank_failure_has_nodes_text() {
        let ask = |reply| async move { HostQuotaChannel::new(Pc::answering(reply)).quota_usable("openai-oauth", "").await };
        assert!(matches!(ask(answer(ProxyAnswer::Sent { attempts: 1 })).await, Ok(Value::Null)));
        assert!(matches!(ask(Ok(json!({ "unexpected": true }))).await, Ok(Value::Null)));
        assert!(
            matches!(ask(rpc(Some(serde_json::to_value(failure("")).unwrap()))).await, Err(ChannelError::Failed(text)) if text == "model proxy call failed")
        );
        assert!(matches!(ask(answer(ProxyAnswer::Failed { failure: failure("PC broke") })).await, Err(ChannelError::Failed(text)) if text == "PC broke"));
    }
}
