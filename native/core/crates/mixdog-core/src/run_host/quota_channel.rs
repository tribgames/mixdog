//! The production [`QuotaChannel`]: Node's `getModelProxyChannel().request({ provider, method:
//! 'quotaUsable', model })`, the daemon half of the model-proxy channel, over the host channel.
//!
//! In proxy-client mode the daemon asks the PC that declared `capabilities.modelProxy` for the
//! answer: one `model/proxy/execute` request carrying `ProxyCall::QuotaUsable` (the Rust form of
//! Node's published `{ provider, method, model }`), answered by `ProxyAnswer::Usable`. Node's
//! claim and lease run on the request itself (`HostCapability::lease`: the PC claims it with its
//! first `model/proxy/heartbeat` inside 10 s and keeps it alive inside 20 s); a PC that does not,
//! ends the request, and dropping this future tells the PC to stop (`CancelOnDrop`).
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
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    use mixdog_app_protocol::v2::model_proxy::{ProxyDelivery, ProxyErrorKind, ProxyOutcome};
    use mixdog_core_api::CoreError;

    use super::*;

    // Read at run time: an `include_str!` put the 1.3 MB recording into every test build of the crate.
    #[allow(clippy::disallowed_methods)] // test fixture loading
    static TWIN: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/quota-usable/quota-usable-twin.json")).unwrap()
    });

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

        async fn request_streamed(&self, capability: HostCapability, method: Method, params: Value, _: &mut (dyn FnMut(Value) + Send)) -> Result<Value, HostError> {
            self.asked.lock().unwrap().push((capability, method.as_str().to_owned(), params));
            self.reply.lock().unwrap().take().expect("one question per channel")
        }
    }

    fn unavailable(detail: &str) -> HostError {
        HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: detail.into() })
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
    async fn the_exchange_and_the_disconnected_pc_read_as_nodes_model_proxy_channel_does() {
        let twin: Value = serde_json::from_str(&TWIN).unwrap();
        let cases = twin["proxy"].as_array().unwrap();
        assert!(cases.len() > 70);
        let mut skipped = BTreeSet::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let (provider, model) = (case["provider"].as_str().unwrap(), case["model"].as_str().unwrap());
            let message = case.get("error").map(|error| error["message"].as_str().unwrap().to_owned());
            let (reply, expected) = match (name, &message) {
                ("no client connected" | "the client is marked absent", Some(message)) => (Err(unavailable("noClaimant")), Err(ChannelError::Unavailable(message.clone()))),
                ("the client goes away mid-call", Some(message)) => (Err(unavailable("claimantClosed")), Err(ChannelError::Unavailable(message.clone()))),
                // The claim window and the lease of the outgoing router end the request this way.
                ("nobody claims the call", Some(message)) => (Err(unavailable("notClaimed")), Err(ChannelError::Unavailable(message.clone()))),
                ("the PC stops answering", Some(message)) => (Err(unavailable("leaseLapsed")), Err(ChannelError::Unavailable(message.clone()))),
                ("PC fails the call", Some(message)) => (rpc(Some(serde_json::to_value(failure("PC broke")).unwrap())), Err(ChannelError::Failed(message.clone()))),
                ("PC fails with a bad error record", Some(message)) => (rpc(Some(json!("not json"))), Err(ChannelError::Failed(message.clone()))),
                (name, None) => match name.strip_prefix("PC answers ").map(|raw| serde_json::from_str::<Value>(raw).unwrap()) {
                    Some(Value::Bool(usable)) => (answer(ProxyAnswer::Usable { usable }), Ok(case["value"].clone())),
                    // A string, a number, null or an object: the typed wire cannot carry them.
                    Some(_) => {
                        skipped.insert(name.to_owned());
                        continue;
                    }
                    None => panic!("a recorded case with no mapping: {case}"),
                },
                _ => panic!("a recorded case with no mapping: {case}"),
            };
            let pc = Pc::answering(reply);
            let got = HostQuotaChannel::new(pc.clone()).quota_usable(provider, model).await;
            match (&got, &expected) {
                (Ok(got), Ok(expected)) => assert_eq!(got, expected, "{case}"),
                (Err(ChannelError::Unavailable(got)), Err(ChannelError::Unavailable(expected))) | (Err(ChannelError::Failed(got)), Err(ChannelError::Failed(expected))) => {
                    assert_eq!(got, expected, "{case}")
                }
                _ => panic!("{got:?} is not {expected:?}: {case}"),
            }
            let asked = pc.asked.lock().unwrap();
            let [(capability, method, params)] = asked.as_slice() else { panic!("one question: {case}") };
            assert_eq!((*capability, method.as_str()), (HostCapability::ModelProxy, "model/proxy/execute"), "{case}");
            // What Node published to the client for the call: the same question, in the Rust wire's shape.
            let published = case["published"].as_array().unwrap();
            assert!(published.is_empty() || *params == json!({ "call": published[0] }), "{case}");
        }
        // Only the four answers that are not a bool: the typed wire carries a bool.
        assert_eq!(skipped.len(), 4, "{skipped:?}");
    }

    #[tokio::test]
    async fn an_answer_that_is_not_a_usable_is_not_usable_and_a_blank_failure_has_nodes_text() {
        let ask = |reply| async move { HostQuotaChannel::new(Pc::answering(reply)).quota_usable("openai-oauth", "").await };
        assert!(matches!(ask(answer(ProxyAnswer::Sent { attempts: 1 })).await, Ok(Value::Null)));
        assert!(matches!(ask(Ok(json!({ "unexpected": true }))).await, Ok(Value::Null)));
        assert!(matches!(ask(rpc(Some(serde_json::to_value(failure("")).unwrap()))).await, Err(ChannelError::Failed(text)) if text == "model proxy call failed"));
        assert!(matches!(ask(answer(ProxyAnswer::Failed { failure: failure("PC broke") })).await, Err(ChannelError::Failed(text)) if text == "PC broke"));
    }
}
