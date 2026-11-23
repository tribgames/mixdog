//! The destination matrix as the registry hands it out: each test goes through the provider the registry returns, by the method a
//! caller uses (attempt, spent re-issue, cache warm, the model proxy's broker send), against an adapter that records what it was
//! given and a supply double over the real validator.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::cache_warm::Deadlines;
use mixdog_core_api::domain::cache_warm::GateTarget;
use mixdog_core_api::domain::cache_warm::WarmGate;
use mixdog_core_api::domain::image_supply::SupplyError;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ImageSource as PartSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_image_egress::Choice;
use mixdog_image_egress::Manifest;
use mixdog_image_egress::Outcome;
use mixdog_image_egress::Reason;
use mixdog_image_egress::Rendition;
use mixdog_image_egress::admission::Cancel;
use mixdog_image_egress::admission::global;
use mixdog_image_egress::route::Vision;
use mixdog_image_egress::route::WireBranch;
use mixdog_imaging::Format;
use mixdog_imaging::Raster;
use mixdog_imaging::encode::encode_in_format;
use mixdog_imaging::validate::validate;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;

use super::*;
use crate::registry::providers::ProviderBuilder;
use crate::registry::providers::ProviderRegistry;

struct Codec;

impl WireCodec for Codec {
    fn transport(&self) -> mixdog_core_api::domain::keepalive::TransportKind {
        mixdog_core_api::domain::keepalive::TransportKind::Http1
    }
    fn encode(&self, _: &ModelRequest) -> Result<mixdog_core_api::domain::provider::WireRequest, ProviderError> {
        unreachable!()
    }
    fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
        unreachable!()
    }
    fn classify(&self, _: &ErrorResponse) -> ProviderError {
        unreachable!()
    }
}

/// An adapter that keeps every request it is given and ends each in a refusal; its route is set per test.
struct Recording {
    base: Arc<dyn ProviderAdapter>,
    codec: Codec,
    seen: Mutex<Vec<ModelRequest>>,
    route: Mutex<(WireBranch, Vision)>,
}

fn not_sent() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = "recorded".into();
    error
}

#[async_trait]
impl CacheWarmSend for Recording {
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        _: &WarmContext<'_>,
        _: &CancellationToken,
        _: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        self.seen.lock().unwrap().push(request.clone());
        Ok(WarmUsage::default())
    }
}

#[async_trait]
impl ProviderAdapter for Recording {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        self.base.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.base.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.base.keepalive()
    }
    fn cache_warm(&self) -> Option<&dyn CacheWarmSend> {
        Some(self)
    }
    async fn image_route(&self, request: &ModelRequest) -> RouteFacts {
        let (branch, vision) = *self.route.lock().unwrap();
        RouteFacts {
            endpoint: "test".into(),
            account: "a".into(),
            model: request.model.clone(),
            branch,
            operation: "send".into(),
            capability_revision: 1,
            vision,
        }
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.seen.lock().unwrap().push((*request).clone());
        Err(not_sent())
    }
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.seen.lock().unwrap().push((*request).clone());
        Err(not_sent())
    }
}

struct Builds(Arc<Recording>);

#[async_trait]
impl ProviderBuilder for Builds {
    async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        Ok(self.0.clone())
    }
    async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _name: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// The attachment store as the guard sees it: verdicts from the real validator, bytes by digest, no disk.
#[derive(Default)]
struct Supply {
    blobs: Mutex<HashMap<String, Arc<[u8]>>>,
    manifests: Mutex<HashMap<String, Manifest>>,
    down: Mutex<bool>,
    reads: Mutex<u32>,
}

fn hex_of(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

impl Supply {
    /// Import `bytes` as `name`, as the store does: the verdict recorded, the original and the rendition kept.
    fn put(&self, bytes: &[u8], name: &str) -> Manifest {
        let original = hex_of(bytes);
        if let Some(found) = self.manifests.lock().unwrap().get(&original) {
            return found.clone();
        }
        let outcome = match validate(bytes, global(), &Cancel::default()) {
            Ok(v) => {
                self.blobs.lock().unwrap().insert(original.clone(), Arc::from(bytes));
                let rendition = v.rendition.map(|(kind, png)| {
                    let digest = hex_of(&png);
                    let size = mixdog_imaging::decoded_dimensions(&png).unwrap_or((0, 0));
                    let r = Rendition { kind, digest: digest.clone(), width: size.0, height: size.1, encoded_len: png.len() as u64 };
                    self.blobs.lock().unwrap().insert(digest, Arc::from(png));
                    r
                });
                Outcome::Accepted { kind: v.kind, width: v.width, height: v.height, frames: v.frames, rendition }
            }
            Err(_) => Outcome::Refused { text: "its data is damaged or incomplete".into() },
        };
        let manifest = Manifest { validator_version: 1, original: original.clone(), name: name.into(), encoded_len: bytes.len() as u64, outcome };
        self.manifests.lock().unwrap().insert(original, manifest.clone());
        manifest
    }
}

#[async_trait]
impl ImageSupply for Supply {
    async fn inline(&self, base64: &str) -> Result<Manifest, SupplyError> {
        if *self.down.lock().unwrap() {
            return Err(SupplyError::Unavailable("the queue is full".into()));
        }
        let bytes = STANDARD.decode(base64).map_err(|_| SupplyError::NotAnImage("not base64".into()))?;
        Ok(self.put(&bytes, ""))
    }
    async fn stored(&self, reference: &str) -> Result<Manifest, SupplyError> {
        self.manifests.lock().unwrap().get(reference).cloned().ok_or(SupplyError::Missing)
    }
    async fn bytes(&self, manifest: &Manifest, choice: Choice) -> Result<Arc<[u8]>, SupplyError> {
        *self.reads.lock().unwrap() += 1;
        let key = match (&manifest.outcome, choice) {
            (Outcome::Accepted { .. }, Choice::Original) => manifest.original.clone(),
            (Outcome::Accepted { rendition: Some(r), .. }, Choice::Rendition) => r.digest.clone(),
            _ => return Err(SupplyError::Missing),
        };
        self.blobs.lock().unwrap().get(&key).cloned().ok_or(SupplyError::Missing)
    }
}

/// The provider the registry hands out (on the Messages branch, vision yes), the adapter under it, and the installed supply.
async fn registered() -> (Arc<Recording>, Arc<dyn ProviderAdapter>, Arc<Supply>) {
    let recording = Arc::new(Recording {
        base: crate::registry::multiwire::tests::refusing("base", 400, "x"),
        codec: Codec,
        seen: Mutex::new(Vec::new()),
        route: Mutex::new((WireBranch::AnthropicMessages, Vision::Yes)),
    });
    let supply = Arc::new(Supply::default());
    mixdog_core_api::domain::image_supply::install(supply.clone());
    let registry = ProviderRegistry::new(Arc::new(Builds(recording.clone())));
    registry.init_providers(json!({"openai": {"enabled": true}}).as_object().unwrap()).await.unwrap();
    (recording, registry.get("openai").await.expect("registered"), supply)
}

fn picture(format: Format) -> Vec<u8> {
    let data = (0..40 * 30).flat_map(|n| [(n % 251) as u8, (n % 241) as u8, 90]).collect();
    encode_in_format(&Raster { width: 40, height: 30, has_alpha: false, data }, format).unwrap()
}

const HEIC: &[u8] = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic";

fn inline(bytes: &[u8], label: &str) -> ContentPart {
    ContentPart::Image(PartSource::Base64 { data: STANDARD.encode(bytes), mime_type: label.into(), width: None, height: None })
}

fn user_with(parts: Vec<ContentPart>) -> ModelRequest {
    ModelRequest { model: "m".into(), messages: vec![Message::new(Role::User, Content::Parts(parts))], tools: Vec::new(), options: RequestOptions::default() }
}

fn with_image(bytes: &[u8], label: &str) -> ModelRequest {
    user_with(vec![ContentPart::Text("look".into(), None), inline(bytes, label)])
}

/// (mime, bytes) of every image part of every message, in order.
fn sent_images(request: &ModelRequest) -> Vec<(String, Vec<u8>)> {
    request
        .messages
        .iter()
        .flat_map(|m| match &m.content {
            Content::Parts(parts) => parts.clone(),
            Content::Text(_) => Vec::new(),
        })
        .filter_map(|part| match part {
            ContentPart::Image(PartSource::Base64 { mime_type, data, .. }) => Some((mime_type, STANDARD.decode(data).unwrap())),
            ContentPart::Image(other) => panic!("not inline: {other:?}"),
            _ => None,
        })
        .collect()
}

fn refusal_of(error: &ProviderError) -> &mixdog_image_egress::NotSent {
    assert_eq!(error.delivery, DeliveryState::NotSent);
    error.image_refusal.as_deref().expect("a typed refusal")
}

#[tokio::test]
async fn an_agent_turn_attempt_carries_a_stored_tiff_as_its_png_rendition() {
    let (recording, provider, _) = registered().await;
    let _ = provider.attempt(Arc::new(with_image(&picture(Format::Tiff), "image/tiff"))).await;
    let seen = recording.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let images = sent_images(&seen[0]);
    assert_eq!(images.len(), 1);
    assert_eq!(images[0].0, "image/png");
    assert_eq!(Format::sniff(&images[0].1), Some(Format::Png));
}

#[tokio::test]
async fn the_type_is_what_the_bytes_are_not_what_the_label_says() {
    let (recording, provider, _) = registered().await;
    let jpeg = picture(Format::Jpeg);
    let _ = provider.attempt(Arc::new(with_image(&jpeg, "image/png"))).await;
    assert_eq!(sent_images(&recording.seen.lock().unwrap()[0]), vec![("image/jpeg".to_owned(), jpeg)]);
}

#[tokio::test]
async fn an_unreadable_image_is_refused_naming_it_before_the_adapter_sees_anything() {
    let (recording, provider, _) = registered().await;
    let error = provider.attempt(Arc::new(with_image(HEIC, "image/png"))).await.err().expect("refused");
    assert!(error.message.starts_with("Nothing was sent."), "{}", error.message);
    assert!(error.message.contains("refused when attached") && error.message.contains("continue without it"), "{}", error.message);
    assert_eq!(refusal_of(&error).blockers.len(), 1);
    assert!(recording.seen.lock().unwrap().is_empty());
    // A payload that is not base64 is refused the same way, never sent.
    let broken =
        user_with(vec![ContentPart::Image(PartSource::Base64 { data: "!!not base64!!".into(), mime_type: "image/png".into(), width: None, height: None })]);
    assert!(provider.attempt(Arc::new(broken)).await.is_err());
    assert!(recording.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn every_blocker_of_the_request_is_reported_together_with_its_place() {
    let (recording, provider, _) = registered().await;
    let mut request = user_with(vec![inline(&picture(Format::Png), "image/png"), inline(HEIC, "image/heic")]);
    let mut assistant = Message::new(Role::Assistant, Content::Text(String::new().into()));
    assistant.tool_calls.push(ToolCall { id: "c1".into(), name: "Read".into(), arguments: Value::Null, native_type: None });
    let mut tool = Message::new(
        Role::Tool,
        Content::Parts(vec![
            ContentPart::Text("x".into(), None),
            inline(b"junk", "image/png"),
            ContentPart::Image(PartSource::Url("https://example.com/a.png".into())),
        ]),
    );
    tool.tool_call_id = Some("c1".into());
    request.messages.push(assistant);
    request.messages.push(tool);
    let error = provider.attempt(Arc::new(request)).await.err().expect("refused");
    let blockers = &refusal_of(&error).blockers;
    assert_eq!(blockers.len(), 3, "{}", error.message);
    let ids: Vec<String> = blockers.iter().map(|b| b.origin.stable_id()).collect();
    assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 3, "stable distinct origins: {ids:?}");
    assert!(error.message.contains("tool result 'Read'"), "{}", error.message);
    assert!(!error.message.contains("example.com"), "a link is never printed: {}", error.message);
    assert!(recording.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_non_first_tool_image_a_duplicate_and_the_order_of_images_survive_exactly() {
    let (recording, provider, _) = registered().await;
    let (png, jpeg) = (picture(Format::Png), picture(Format::Jpeg));
    let request = user_with(vec![inline(&png, "image/png"), ContentPart::Text("between".into(), None), inline(&jpeg, "image/jpeg"), inline(&png, "image/png")]);
    let _ = provider.attempt(Arc::new(request.clone())).await;
    let sent = recording.seen.lock().unwrap()[0].clone();
    assert_eq!(sent_images(&sent), vec![("image/png".to_owned(), png.clone()), ("image/jpeg".to_owned(), jpeg), ("image/png".to_owned(), png)]);
    // Images that were already right come back as they were: nothing is added, dropped or reordered around them.
    assert_eq!(sent.messages[0].content, request.messages[0].content);
}

#[tokio::test]
async fn a_route_that_cannot_see_or_is_not_known_takes_no_image() {
    let (recording, provider, _) = registered().await;
    for (branch, vision) in
        [(WireBranch::AnthropicMessages, Vision::No), (WireBranch::Unknown, Vision::Yes), (WireBranch::Local, Vision::No), (WireBranch::CompatChat, Vision::No)]
    {
        *recording.route.lock().unwrap() = (branch, vision);
        let error = provider.attempt(Arc::new(with_image(&picture(Format::Png), "image/png"))).await.err().expect("refused");
        assert!(error.message.contains("cannot read images"), "{branch:?}: {}", error.message);
    }
    assert!(recording.seen.lock().unwrap().is_empty());
    // The same image on a seeing route reaches the adapter.
    *recording.route.lock().unwrap() = (WireBranch::AnthropicMessages, Vision::Yes);
    let _ = provider.attempt(Arc::new(with_image(&picture(Format::Png), "image/png"))).await;
    assert_eq!(recording.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_inline_only_route_refuses_a_link_and_a_chat_route_a_provider_file_id() {
    let (recording, provider, _) = registered().await;
    *recording.route.lock().unwrap() = (WireBranch::InlineOnly, Vision::Yes);
    let link = user_with(vec![ContentPart::Image(PartSource::Url("https://example.com/a.png".into()))]);
    assert!(refusal_of(&provider.attempt(Arc::new(link)).await.err().unwrap()).blockers[0].reason == Reason::SourceFormNotCarried);
    *recording.route.lock().unwrap() = (WireBranch::CompatChat, Vision::Yes);
    let id = user_with(vec![ContentPart::Image(PartSource::FileId("file-abc".into()))]);
    assert!(provider.attempt(Arc::new(id)).await.is_err());
    assert!(recording.seen.lock().unwrap().is_empty(), "nothing reached the adapter");
}

#[tokio::test]
async fn a_data_url_is_judged_like_inline_bytes_whatever_its_label_or_scheme_case() {
    let (recording, provider, _) = registered().await;
    let tiff = picture(Format::Tiff);
    for scheme in ["data", "DATA"] {
        let url = format!("{scheme}:image/png;base64,{}", STANDARD.encode(&tiff));
        let _ = provider.attempt(Arc::new(user_with(vec![ContentPart::Image(PartSource::Url(url))]))).await;
    }
    let seen = recording.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    for request in seen.iter() {
        assert_eq!(sent_images(request)[0].0, "image/png");
    }
    drop(seen);
    for bad in ["data:image/png,%89PNG", "data:image/png;base64", "data:image/png;base64,@@@@"] {
        assert!(provider.attempt(Arc::new(user_with(vec![ContentPart::Image(PartSource::Url(bad.into()))]))).await.is_err(), "{bad}");
    }
    assert_eq!(recording.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_stored_reference_is_resolved_by_the_guard_with_no_decoding_of_its_own() {
    let (recording, provider, supply) = registered().await;
    let png = picture(Format::Png);
    let manifest = supply.put(&png, "scan.png");
    let decodes = global().stats().decodes;
    let part = ContentPart::File {
        source: BinarySource::AttachmentRef(manifest.original.clone()),
        mime_type: "image/png".into(),
        filename: Some("scan.png".into()),
        text: None,
    };
    let _ = provider.attempt(Arc::new(user_with(vec![part]))).await;
    assert_eq!(sent_images(&recording.seen.lock().unwrap()[0]), vec![("image/png".to_owned(), png)]);
    assert_eq!(global().stats().decodes, decodes, "the send read a verdict and bytes, nothing more");
    // A reference the store does not know is a named refusal, never an unverified fallback.
    let missing =
        ContentPart::File { source: BinarySource::AttachmentRef("0".repeat(64)), mime_type: "image/png".into(), filename: Some("gone.png".into()), text: None };
    let error = provider.attempt(Arc::new(user_with(vec![missing]))).await.err().expect("refused");
    assert!(error.message.contains("`gone.png`") && error.message.contains("missing"), "{}", error.message);
}

#[tokio::test]
async fn a_store_that_cannot_answer_sends_nothing_and_claims_nothing_of_the_image() {
    let (recording, provider, supply) = registered().await;
    *supply.down.lock().unwrap() = true;
    let error = provider.attempt(Arc::new(with_image(&picture(Format::Png), "image/png"))).await.err().expect("not sent");
    assert!(error.image_refusal.is_none() && error.message.contains("could not be checked just now"), "{}", error.message);
    assert_eq!(error.delivery, DeliveryState::NotSent);
    assert!(recording.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_image_a_destination_takes_as_it_is_goes_byte_for_byte_with_its_own_type() {
    let (recording, provider, _) = registered().await;
    let gif = picture(Format::Gif);
    for branch in [WireBranch::CompatChat, WireBranch::AnthropicMessages, WireBranch::OpenAiResponses] {
        *recording.route.lock().unwrap() = (branch, Vision::Yes);
        let request = with_image(&gif, "image/gif");
        let _ = provider.attempt(Arc::new(request.clone())).await;
        let sent = recording.seen.lock().unwrap().last().cloned().expect("sent");
        assert_eq!(sent.messages, request.messages, "{branch:?}: the history the request already held is what is sent");
    }
    // Where GIF is not a type the destination reads, its stored rendition goes instead.
    *recording.route.lock().unwrap() = (WireBranch::GeminiNative, Vision::Yes);
    let _ = provider.attempt(Arc::new(with_image(&gif, "image/gif"))).await;
    assert_eq!(sent_images(recording.seen.lock().unwrap().last().unwrap())[0].0, "image/png");
}

#[tokio::test]
async fn an_image_in_a_messages_recorded_form_is_prepared_like_any_other_and_refused_when_it_cannot_go() {
    let (recording, provider, _) = registered().await;
    let tiff = picture(Format::Tiff);
    let recorded = |data: &[u8], media_type: &str| {
        let mut assistant = Message::new(Role::Assistant, Content::Text("here".into()));
        assistant.assistant_blocks = Some(
            json!([{ "type": "text", "text": "here" }, { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": STANDARD.encode(data) } }]),
        );
        let mut request = user_with(vec![ContentPart::Text("draw".into(), None)]);
        request.messages.push(assistant);
        request
    };
    let _ = provider.attempt(Arc::new(recorded(&tiff, "image/tiff"))).await;
    let blocks = recording.seen.lock().unwrap()[0].messages[1].assistant_blocks.clone().expect("kept");
    assert_eq!(blocks[1]["source"]["media_type"], "image/png", "the block an encoder copies holds the prepared rendition");
    assert_eq!(Format::sniff(&STANDARD.decode(blocks[1]["source"]["data"].as_str().unwrap()).unwrap()), Some(Format::Png));
    // An image there that cannot go is refused, named as the assistant's, and may only be left out.
    let error = provider.attempt(Arc::new(recorded(HEIC, "image/png"))).await.err().expect("refused");
    let blocker = &refusal_of(&error).blockers[0];
    assert!(blocker.origin.in_recorded_form() && blocker.actions == vec![mixdog_image_egress::RecoveryAction::ContinueWithout], "{blocker:?}");
    assert!(error.message.contains("an assistant message"), "{}", error.message);
    assert_eq!(recording.seen.lock().unwrap().len(), 1, "the refused request reached no adapter");
}

#[tokio::test]
async fn a_request_with_no_image_is_passed_on_untouched() {
    let (recording, provider, supply) = registered().await;
    *supply.down.lock().unwrap() = true;
    let request = Arc::new(user_with(vec![ContentPart::Text("hi".into(), None)]));
    let _ = provider.attempt(request.clone()).await;
    assert_eq!(recording.seen.lock().unwrap()[0], *request);
}

#[tokio::test]
async fn the_reissue_of_a_spent_send_carries_the_prepared_image_and_refuses_the_unreadable_one() {
    let (recording, provider, _) = registered().await;
    let _ = provider.recover_spent(Arc::new(with_image(&picture(Format::Tiff), "image/tiff"))).await;
    assert_eq!(sent_images(&recording.seen.lock().unwrap()[0])[0].0, "image/png");
    assert!(provider.recover_spent(Arc::new(with_image(HEIC, "image/heic"))).await.err().is_some_and(|e| e.image_refusal.is_some()));
    assert_eq!(recording.seen.lock().unwrap().len(), 1);
}

struct Open;

#[async_trait]
impl WarmGate for Open {
    async fn block(&self, _: &GateTarget) -> Option<String> {
        None
    }
    async fn record_refusal(&self, _: &GateTarget, _: &ProviderError, _: bool) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn a_cache_warm_sends_the_saved_request_with_its_images_prepared_and_a_refused_one_cancels_only_that_warm() {
    let (recording, provider, _) = registered().await;
    let warm = provider.cache_warm().expect("a warm mode");
    let target = GateTarget::default();
    let report = |_: &str| {};
    let ctx = WarmContext { gate: &Open, target: &target, deadlines: Deadlines::DEFAULT, report: &report };
    warm.send_cache_warm(&with_image(&picture(Format::Tiff), "image/tiff"), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap();
    assert_eq!(sent_images(&recording.seen.lock().unwrap()[0])[0].0, "image/png");
    let failure = warm.send_cache_warm(&with_image(HEIC, "image/png"), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert!(failure.message.starts_with("Nothing was sent."), "{}", failure.message);
    assert_eq!(recording.seen.lock().unwrap().len(), 1);
}

#[derive(Default)]
struct Quiet;

impl crate::broker::AttemptSink for Quiet {
    fn event(&mut self, _: mixdog_core_api::domain::provider::StreamEvent) {}
    fn discard(&mut self) {}
}

#[tokio::test(start_paused = true)]
async fn the_model_proxys_broker_send_goes_through_the_same_guard() {
    use crate::admission::Admission;
    use crate::admission::AdmissionRequest;
    use crate::admission::LaneKey;
    use crate::admission::LaneSettings;
    use crate::broker::ModelBroker;
    use crate::broker::SendError;
    use crate::broker::SendRequest;
    use crate::retry::StandardRetryDecider;

    mixdog_rt::testing::tokens();
    let (recording, provider, _) = registered().await;
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new("mock".into(), "default"), LaneSettings::default());
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    let send = |request: ModelRequest| SendRequest { request: Arc::new(request), lane: lane.clone(), admission: AdmissionRequest::default() };
    let refused = broker.send(provider.as_ref(), send(with_image(HEIC, "image/png")), &mut Quiet, &CancellationToken::new()).await;
    assert!(matches!(&refused, Err(SendError::Provider(error) | SendError::Exhausted(error)) if error.image_refusal.is_some()), "{refused:?}");
    assert!(recording.seen.lock().unwrap().is_empty());
    let _ = broker.send(provider.as_ref(), send(with_image(&picture(Format::Tiff), "image/tiff")), &mut Quiet, &CancellationToken::new()).await;
    assert_eq!(sent_images(&recording.seen.lock().unwrap()[0])[0].0, "image/png");
}
