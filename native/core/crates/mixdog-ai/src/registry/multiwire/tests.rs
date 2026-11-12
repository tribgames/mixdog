use std::sync::Mutex;

use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;

use super::*;

struct NoCodec;
impl WireCodec for NoCodec {
    fn transport(&self) -> mixdog_core_api::domain::keepalive::TransportKind {
        mixdog_core_api::domain::keepalive::TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<WireRequest, ProviderError> {
        unreachable!()
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        unreachable!()
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unreachable!()
    }
}

/// Answers every attempt with one fixed refusal and counts the attempts.
pub(crate) struct Refusing {
    id: ProviderId,
    refusal: ProviderError,
    calls: Mutex<u32>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
}

pub(crate) fn refusing(tag: &str, status: u16, message: &str) -> Arc<Refusing> {
    let mut refusal = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
    refusal.status = Some(status);
    refusal.message = format!("{tag}: {message}");
    Arc::new(Refusing {
        id: ProviderId::from("custom-x"),
        refusal,
        calls: Mutex::new(0),
        policy: CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless).retry_policy(),
        keepalive: KeepaliveSchedule::SPEC,
    })
}

#[async_trait]
impl ProviderAdapter for Refusing {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &NoCodec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        *self.calls.lock().unwrap() += 1;
        Err(self.refusal.clone())
    }
}

fn request(model: &str) -> Arc<ModelRequest> {
    Arc::new(ModelRequest { model: model.into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() })
}

fn adapter(chat: &Arc<Refusing>, messages: &Arc<Refusing>, overrides: &[(&str, Wire)]) -> MultiWireAdapter {
    MultiWireAdapter::new(
        ProviderId::from("custom-x"),
        vec![(Wire::Chat, chat.clone() as Arc<dyn ProviderAdapter>), (Wire::Messages, messages.clone() as Arc<dyn ProviderAdapter>)],
        Wire::Chat,
        overrides.iter().map(|(m, w)| ((*m).to_owned(), *w)).collect(),
    )
}

fn message_of(result: Result<Box<dyn ModelStream>, ProviderError>) -> String {
    result.err().expect("a refusal").message
}

#[tokio::test]
async fn a_model_goes_on_its_override_wire_else_the_protocol_wire() {
    let (chat, messages) = (refusing("chat", 500, "x"), refusing("messages", 500, "x"));
    let multi = adapter(&chat, &messages, &[("claude-x", Wire::Messages)]);
    assert!(message_of(multi.attempt(request("claude-x")).await).starts_with("messages"));
    assert!(message_of(multi.attempt(request("other")).await).starts_with("chat"));
}

#[tokio::test]
async fn a_refusal_on_the_selected_wire_is_the_providers_error() {
    // Even a refusal that names the endpoint never moves the request to
    // another wire: the wire is the config's choice.
    let chat = refusing("chat", 404, "Unsupported endpoint: use /v1/messages");
    let messages = refusing("messages", 405, "no");
    let multi = adapter(&chat, &messages, &[]);
    assert!(message_of(multi.attempt(request("m")).await).starts_with("chat"));
    assert_eq!((*chat.calls.lock().unwrap(), *messages.calls.lock().unwrap()), (1, 0));
}
