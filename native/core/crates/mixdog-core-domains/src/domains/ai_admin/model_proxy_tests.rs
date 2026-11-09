//! The model proxy end to end: a request survives the wire, the PC runs it on its own provider and
//! broker, and the server end sees the same events, retries and failures as a local send.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mixdog_ai::admission::Admission;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
use serde_json::json;

use super::*;

/// A state with the typed Gemini slot and the provider-owned keys that ride beside it.
fn provider_state() -> p::ProviderState {
    let mut state = p::ProviderState {
        gemini: Some(p::GeminiCacheState {
            cache_name: "cachedContents/abc".into(),
            cache_created_at: 1_700_000_000_000,
            cache_created_at_iter: 2,
            cache_expires_at: 1_700_000_300_000,
            cache_model: "gemini-2.5-pro".into(),
            cache_token_size: 4096,
            cache_prefix_content_count: 3,
            cache_prefix_hash: "h".into(),
            cache_credential_fingerprint: "f".into(),
        }),
        ..Default::default()
    };
    state.rest.insert("previousResponseId".into(), json!("r1"));
    state.rest.insert("xaiResponses".into(), json!({ "slot": [1, null, "x"] }));
    state
}

fn request() -> p::ModelRequest {
    let mut assistant = p::Message::new(p::Role::Assistant, p::Content::Text("calling".into()));
    assistant.tool_calls.push(p::ToolCall { id: "c1".into(), name: "read".into(), arguments: json!({ "path": "a" }), native_type: Some("custom_tool_call".into()) });
    assistant.phase = Some(p::Phase::Commentary);
    assistant.thinking_blocks = Some(json!([{ "type": "thinking" }]));
    assistant.turn_reminder = Some("remember".into());
    assistant.push_replay(p::ProviderReplay { owner: "openai".into(), items: json!([1, 2]) });
    let mut user = p::Message::new(
        p::Role::User,
        p::Content::Parts(vec![
            p::ContentPart::Text("hi".into(), None),
            p::ContentPart::Image(p::ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into() }),
            p::ContentPart::File { source: p::BinarySource::Base64("QUJD".into()), mime_type: "text/plain".into(), filename: Some("a.txt".into()), text: None },
            p::ContentPart::Document { source: p::DocumentSource::Text { media_type: None, data: "d".into() }, title: Some("T".into()) },
        ]),
    );
    user.source = Some(p::MessageSource::TailReminder);
    user.cache_tier = Some(p::CacheTier::Env);
    let mut options = p::RequestOptions {
        session_id: Some("s".into()),
        prompt_cache_scope: Some("shared".into()),
        xai_responses_cache_scope: Some("prefix".into()),
        effort: Some("high".into()),
        fast: true,
        iteration: 3,
        temperature: p::Temperature::new(0.5),
        model_parameters: Some(json!({ "serviceTier": "priority" })),
        thread: Some(p::RequestThread { id: ThreadId::from("t1"), window: 2, turn: Some(TurnId::from("u1")) }),
        shared_cache_prefix_count: Some(4),
        provider_state: Some(provider_state()),
        effort_projection: Some(p::EffortProjection { initial_effort: "low".into(), updates: BTreeMap::from([(2, "high".into())]) }),
        ..Default::default()
    };
    options.hosted_tools.push(p::HostedTool::WebSearch(p::HostedWebSearch {
        tool_type: "web_search".into(),
        allowed_domains: vec!["a.com".into()],
        user_location: Some(p::UserLocation { country: Some("KR".into()), ..Default::default() }),
        max_uses: None,
        context_size: Some("low".into()),
        include_sources: true,
    }));
    p::ModelRequest {
        model: "gpt-5".into(),
        messages: vec![user, assistant],
        tools: vec![p::ToolDefinition { name: "read".into(), description: "d".into(), input_schema: json!({ "type": "object" }), defer_loading: true, freeform: None }],
        options,
    }
}

#[test]
fn a_request_survives_the_wire() {
    let sent = request();
    let text = serde_json::to_string(&w::ProxyCall::Send { provider: "openai".into(), request: Box::new(request_out(&sent)) }).unwrap();
    let w::ProxyCall::Send { request, .. } = serde_json::from_str(&text).unwrap() else { panic!("not a send") };
    assert_eq!(request_in(*request).unwrap(), sent);
}

#[test]
fn the_senders_scope_and_unresolved_references_stay_home() {
    let mut sent = request();
    sent.messages[0] = p::Message::new(
        p::Role::User,
        p::Content::Parts(vec![p::ContentPart::File { source: p::BinarySource::AttachmentRef("blob-1".into()), mime_type: "application/pdf".into(), filename: Some("C:\\x\\y.pdf".into()), text: None }]),
    );
    sent.options.transport_scope = Some("sender-scope".into());
    sent.options.model_max_output_tokens = Some(9);
    let text = serde_json::to_string(&request_out(&sent)).unwrap();
    assert!(!text.contains("blob-1") && !text.contains("sender-scope"));
    let got = request_in(serde_json::from_str(&text).unwrap()).unwrap();
    assert_eq!(got.messages[0].content, p::Content::Parts(vec![p::ContentPart::Text("[attachment unavailable: y.pdf]".into(), None)]));
    assert_eq!((got.options.transport_scope, got.options.model_max_output_tokens), (None, None));
}

#[test]
fn a_listed_model_keeps_its_name_window_and_wire_over_the_wire() {
    let mut listed = p::ModelRecord::new("gpt-5.6-sol");
    listed.name = Some("gpt-5.6-sol".into());
    listed.context_window = Some(272_000);
    listed.max_context_window = Some(1_000_000);
    listed.runtime_context_window = Some(16_384);
    listed.input_cost_per_m = Some(0.4);
    listed.output_cost_per_m = Some(1.6);
    listed.cache_read_cost_per_m = Some(0.0);
    // Every fact the `model/list` row reads crosses with the model.
    listed.provider_name = Some("Gateway".into());
    listed.manual = true;
    listed.supports_reasoning_effort_updates = Some(true);
    listed.supports_prompt_caching = Some(true);
    listed.reasoning_content_field = Some("reasoning_content".into());
    listed.picker.tier = Some("version".into());
    listed.picker.latest = true;
    listed.picker.description = Some("a model".into());
    listed.picker.default_service_tier = Some("priority".into());
    listed.picker.default_model_parameters = [("context".to_owned(), "272k".to_owned())].into();
    listed.picker.default_fast = true;
    listed.picker.supports_max_mode = true;
    for wire in [None, Some(p::WireIds::One("sol-wire".into())), Some(p::WireIds::Tiers(vec![("high".into(), "sol-high".into()), ("low".into(), "sol-low".into())]))] {
        listed.wire = wire;
        let text = serde_json::to_string(&model_out(&listed)).unwrap();
        assert_eq!(model_in(serde_json::from_str(&text).unwrap()), listed);
    }
}

#[test]
fn the_wire_ids_are_nodes_row_shape() {
    // Node rows carry `wire` as a bare id or as `{ level: id }`.
    let row = |wire: serde_json::Value| {
        let mut model = serde_json::to_value(model_out(&p::ModelRecord::new("m"))).unwrap();
        model["wire"] = wire;
        model_in(serde_json::from_value(model).unwrap()).wire
    };
    assert_eq!(row(json!("m-wire")), Some(p::WireIds::One("m-wire".into())));
    assert_eq!(row(json!({ "xhigh": "m-x", "low": "m-l" })), Some(p::WireIds::Tiers(vec![("xhigh".into(), "m-x".into()), ("low".into(), "m-l".into())])));
    let mut listed = p::ModelRecord::new("m");
    listed.wire = Some(p::WireIds::Tiers(vec![("xhigh".into(), "m-x".into()), ("low".into(), "m-l".into())]));
    assert_eq!(serde_json::to_value(model_out(&listed)).unwrap()["wire"], json!({ "xhigh": "m-x", "low": "m-l" }));
    listed.wire = Some(p::WireIds::One("m-wire".into()));
    assert_eq!(serde_json::to_value(model_out(&listed)).unwrap()["wire"], json!("m-wire"));
}

#[test]
fn a_bad_temperature_is_refused() {
    let mut wire = request_out(&request());
    wire.options.temperature = Some(-1.0);
    assert_eq!(request_in(wire), Err(Invalid("invalid temperature -1".into())));
}

/// The variant's name. No wildcard: a `StreamEvent` variant added without a wire form (and a sample below) stops compiling here.
fn variant_name(event: &p::StreamEvent) -> &'static str {
    use p::StreamEvent as E;
    match event {
        E::ItemStart { .. } => "ItemStart",
        E::TextDelta(_) => "TextDelta",
        E::ReasoningDelta(_) => "ReasoningDelta",
        E::ReasoningReplay(_) => "ReasoningReplay",
        E::ToolCallStart { .. } => "ToolCallStart",
        E::ToolCallArgsDelta { .. } => "ToolCallArgsDelta",
        E::ToolCallDone(_) => "ToolCallDone",
        E::Usage(_) => "Usage",
        E::Refusal(_) => "Refusal",
        E::Citation(_) => "Citation",
        E::ServerToolBlock(_) => "ServerToolBlock",
        E::ProviderKeepalive => "ProviderKeepalive",
        E::Progress(_) => "Progress",
        E::ChunkProgress(_) => "ChunkProgress",
        E::FinalContent(_) => "FinalContent",
        E::ReturnedCalls(_) => "ReturnedCalls",
        E::ThinkingBlocks(_) => "ThinkingBlocks",
        E::ProviderState(_) => "ProviderState",
        E::Notice { .. } => "Notice",
        E::ServedModel(_) => "ServedModel",
        E::Completed { .. } => "Completed",
    }
}

const STREAM_EVENT_VARIANTS: [&str; 21] = [
    "ItemStart",
    "TextDelta",
    "ReasoningDelta",
    "ReasoningReplay",
    "ToolCallStart",
    "ToolCallArgsDelta",
    "ToolCallDone",
    "Usage",
    "Refusal",
    "Citation",
    "ServerToolBlock",
    "ProviderKeepalive",
    "Progress",
    "ChunkProgress",
    "FinalContent",
    "ReturnedCalls",
    "ThinkingBlocks",
    "ProviderState",
    "Notice",
    "ServedModel",
    "Completed",
];

/// The proxy carries a provider stream to a consumer that runs the same loop, so every `StreamEvent` crosses the wire
/// unchanged, and the new progress, final-content, returned-call and thinking-block events keep their wire form.
#[test]
fn every_stream_event_survives_the_wire() {
    let call = |id: &str| p::ToolCall { id: id.into(), name: "read".into(), arguments: json!({ "path": id }), native_type: None };
    let state = provider_state();
    let events = [
        p::StreamEvent::ItemStart { kind: p::ItemKind::Tool, phase: None },
        p::StreamEvent::ItemStart { kind: p::ItemKind::Text, phase: Some(p::Phase::Commentary) },
        p::StreamEvent::TextDelta("a".into()),
        p::StreamEvent::ReasoningDelta("b".into()),
        p::StreamEvent::ReasoningReplay(p::ProviderReplay { owner: "openai".into(), items: json!([{ "id": "rs1" }]) }),
        p::StreamEvent::ToolCallStart { id: "c1".into(), name: "read".into() },
        p::StreamEvent::ToolCallArgsDelta { id: "c1".into(), delta: "{\"p".into() },
        p::StreamEvent::ToolCallDone(call("c1")),
        p::StreamEvent::Usage(p::Usage { input_tokens: 3, output_tokens: 1, ..Default::default() }),
        p::StreamEvent::Refusal("no".into()),
        p::StreamEvent::Citation(json!({ "url": "u" })),
        p::StreamEvent::ServerToolBlock(json!({ "type": "server_tool_use" })),
        p::StreamEvent::ProviderKeepalive,
        p::StreamEvent::Progress(p::ProgressKind::Semantic),
        p::StreamEvent::Progress(p::ProgressKind::Reasoning),
        p::StreamEvent::Progress(p::ProgressKind::Text),
        p::StreamEvent::Progress(p::ProgressKind::Tool),
        p::StreamEvent::ChunkProgress(None),
        p::StreamEvent::ChunkProgress(Some(p::ProgressKind::Tool)),
        p::StreamEvent::FinalContent("final".into()),
        p::StreamEvent::ReturnedCalls(vec![call("c1"), p::ToolCall { native_type: Some("custom_tool_call".into()), ..call("c2") }]),
        p::StreamEvent::ReturnedCalls(Vec::new()),
        p::StreamEvent::ThinkingBlocks(json!([{ "type": "thinking", "signature": "s" }])),
        p::StreamEvent::ProviderState(state),
        p::StreamEvent::Notice { message: "m".into(), warn: true },
        p::StreamEvent::ServedModel("gemini-3.8-flash".into()),
        p::StreamEvent::Completed { stop: Some(p::StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let mut seen: Vec<&str> = events.iter().map(variant_name).collect();
    seen.sort_unstable();
    seen.dedup();
    let mut all = STREAM_EVENT_VARIANTS.to_vec();
    all.sort_unstable();
    assert_eq!(seen, all, "a sample for every StreamEvent variant");
    for event in events {
        let text = serde_json::to_string(&event_out(&event)).unwrap();
        assert_eq!(event_in(serde_json::from_str(&text).unwrap()).unwrap(), Incoming::Event(event), "{text}");
    }
    let wire = |event: p::StreamEvent| serde_json::to_value(event_out(&event)).unwrap();
    assert_eq!(wire(p::StreamEvent::Progress(p::ProgressKind::Tool)), json!({ "type": "progress", "kind": "tool" }));
    assert_eq!(wire(p::StreamEvent::ChunkProgress(None)), json!({ "type": "chunkProgress", "kind": null }));
    assert_eq!(wire(p::StreamEvent::FinalContent("f".into())), json!({ "type": "finalContent", "text": "f" }));
    assert_eq!(wire(p::StreamEvent::ThinkingBlocks(json!([1]))), json!({ "type": "thinkingBlocks", "value": [1] }));
    assert_eq!(
        wire(p::StreamEvent::ReturnedCalls(vec![call("c1")])),
        json!({ "type": "returnedCalls", "calls": [{ "id": "c1", "name": "read", "arguments": { "path": "c1" }, "nativeType": null }] }),
    );
}

/// The session's provider state crosses the wire whole, in both directions, with no fallback for a state that cannot
/// be written: the JSON built for the wire is what serde writes for the type (so every key Node's `providerState`
/// has is there), the event and the request each carry it, and the other end reads back the same state.
#[test]
fn the_provider_state_crosses_the_wire_whole() {
    let state = provider_state();
    assert_eq!(state.to_json(), serde_json::to_value(&state).unwrap());
    assert_eq!(p::ProviderState::default().to_json(), json!({}));
    assert_eq!(
        state.to_json()["gemini"],
        json!({
            "cacheName": "cachedContents/abc",
            "cacheCreatedAt": 1_700_000_000_000_u64,
            "cacheCreatedAtIter": 2,
            "cacheExpiresAt": 1_700_000_300_000_u64,
            "cacheModel": "gemini-2.5-pro",
            "cacheTokenSize": 4096,
            "cachePrefixContentCount": 3,
            "cachePrefixHash": "h",
            "cacheCredentialFingerprint": "f",
        }),
    );
    let w::ProxyEvent::ProviderState { state: sent } = event_out(&p::StreamEvent::ProviderState(state.clone())) else { panic!("not a state") };
    assert_eq!(sent, state.to_json());
    assert_eq!(sent["xaiResponses"], json!({ "slot": [1, null, "x"] }));
    assert_eq!(event_in(w::ProxyEvent::ProviderState { state: sent }).unwrap(), Incoming::Event(p::StreamEvent::ProviderState(state.clone())));
    // A state this core cannot read is refused, not replaced by an empty one.
    assert!(event_in(w::ProxyEvent::ProviderState { state: json!({ "gemini": 3 }) }).is_err());
    let mut asked = request();
    asked.options.provider_state = Some(state.clone());
    assert_eq!(request_out(&asked).options.provider_state, Some(state.to_json()));
    assert_eq!(request_in(request_out(&asked)).unwrap().options.provider_state, Some(state));
}

#[test]
fn events_and_failures_survive_the_wire() {
    let usage = p::Usage { input_tokens: 5, output_tokens: 2, cache_read_tokens: 1, raw: Some(json!({ "x": 1 })), cost: Some(p::UsdTicks(7)), ..Default::default() };
    for event in [
        p::StreamEvent::ItemStart { kind: p::ItemKind::Reasoning, phase: Some(p::Phase::FinalAnswer) },
        p::StreamEvent::TextDelta("a".into()),
        p::StreamEvent::ReasoningReplay(p::ProviderReplay { owner: "openai".into(), items: json!([1]) }),
        p::StreamEvent::ToolCallDone(p::ToolCall { id: "c".into(), name: "n".into(), arguments: json!({}), native_type: None }),
        p::StreamEvent::Usage(usage.clone()),
        p::StreamEvent::ProviderKeepalive,
        p::StreamEvent::Completed { stop: Some(p::StopReason::Other("x".into())), pricing_model: None, request_ms: None },
        p::StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None },
        p::StreamEvent::Completed { stop: Some(p::StopReason::EndTurn), pricing_model: Some("zen-3".into()), request_ms: Some(1_250) },
    ] {
        let text = serde_json::to_string(&event_out(&event)).unwrap();
        assert_eq!(event_in(serde_json::from_str(&text).unwrap()).unwrap(), Incoming::Event(event));
    }
    let mut error = p::ProviderError::new(p::ErrorKind::RateLimited, p::DeliveryState::Accepted);
    error.status = Some(429);
    error.retry_after = Some(Duration::from_millis(1500));
    error.exposure.text_emitted = true;
    error.transport = Some(p::TransportFault::KeepaliveExpired { transport: TransportKind::WebSocket });
    error.partial_usage = Some(Box::new(usage));
    error.message = "failed with Bearer abcdefghijkl".into();
    error.notices = vec![("served as another model".into(), true), ("info only".into(), false)];
    let wire = failure_out(&error, w::ProxyOutcome::Fallback { model: "m2".into() });
    assert_eq!(wire.message, "failed with [redacted]");
    let (back, outcome) = failure_in(serde_json::from_str(&serde_json::to_string(&wire).unwrap()).unwrap()).unwrap();
    error.message = "failed with [redacted]".into();
    assert_eq!((back, outcome), (error, w::ProxyOutcome::Fallback { model: "m2".into() }));
}

// -- both ends over a loopback ---------------------------------------------------------------

struct Mock(Arc<MockProvider>);

#[async_trait]
impl ProviderLookup for Mock {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == "mock").then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

struct Quota;
#[async_trait]
impl QuotaProbe for Quota {
    async fn usable(&self, _: &str, model: &str) -> Result<bool, String> {
        if model == "broken" {
            return Err("usage fetch failed".into());
        }
        Ok(model == "ok")
    }
}

struct Wires;
#[async_trait]
impl WireRouter for Wires {
    async fn route(&self, _: &dyn p::ProviderAdapter, _: &str, context: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError> {
        Ok(context.agent.then_some(w::ProxyWireRoute { wire: w::ProxyWire::Messages, source: w::ProxyRouteSource::Family, profile_id: "mock:messages".into() }))
    }
}

struct Config;
#[async_trait]
impl ProviderConfigSource for Config {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        Ok((Vec::new(), true))
    }
}

/// The PC end behind the transport the server end calls.
pub(in crate::domains::ai_admin) struct Loopback(pub(in crate::domains::ai_admin) ProxyRunner);

struct Collect<'a>(&'a Mutex<Vec<w::ProxyEvent>>);
impl ProxyEvents for Collect<'_> {
    fn emit(&self, event: w::ProxyEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[async_trait]
impl ModelProxyTransport for Loopback {
    async fn execute(&self, call: Value, events: &mut (dyn FnMut(Value) + Send), cancel: &CancellationToken) -> Result<Value, ProxyError> {
        let call: w::ProxyCall = serde_json::from_value(call).expect("a typed call");
        let collected = Mutex::new(Vec::new());
        let result = self.0.run(call, None, &Collect(&collected), cancel).await;
        for event in collected.into_inner().unwrap() {
            events(serde_json::to_value(event).unwrap());
        }
        match result {
            Ok(answer) => Ok(serde_json::to_value(answer).unwrap()),
            Err(failure) => Err(ProxyError::Remote(serde_json::to_value(failure).unwrap())),
        }
    }
}

struct NoStore;
#[async_trait]
impl AttachmentReader for NoStore {
    async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
        Err(ReadError::Permanent)
    }
}

#[derive(Default)]
struct Sink {
    events: Vec<p::StreamEvent>,
    discards: u32,
    abandoned: Vec<(u64, u64)>,
}

impl AttemptSink for Sink {
    fn event(&mut self, event: p::StreamEvent) {
        self.events.push(event);
    }
    fn discard(&mut self) {
        self.discards += 1;
        self.events.clear();
    }
    fn abandoned(&mut self, usage: &p::Usage, _: Option<&str>) {
        self.abandoned.push((usage.input_tokens, usage.output_tokens));
    }
}

/// A PC with no network: its catalog lists what models says and fetches nothing.
struct Offline;

#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(
        &self,
        _: p::WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(
            p::ErrorKind::Transient,
            p::DeliveryState::NotSent,
        ))
    }
}

async fn catalog(models: &[(&str, &str)]) -> Arc<mixdog_ai::catalog::CatalogService> {
    use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelRecord, ModelsDevSource};
    let tokens = mixdog_rt::testing::tokens();
    let mut snapshot = CatalogSnapshot::default();
    for (provider, id) in models {
        snapshot.models.entry((*provider).into()).or_default().push(ModelRecord::new((*provider).into(), *id));
    }
    let dir = tempfile::tempdir().unwrap();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
    Arc::new(CatalogService::cold_start(snapshot, Vec::new(), metadata).await)
}

pub(in crate::domains::ai_admin) async fn loopback(attempts: impl IntoIterator<Item = MockAttempt>) -> Loopback {
    let catalog = catalog(&[("mock", "listed")]).await;
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let _ = StandardRetryDecider;
    Loopback(ProxyRunner { providers: Arc::new(Mock(Arc::new(MockProvider::new(attempts)))), broker, quota: Arc::new(Quota), wire: Arc::new(Wires), config: Arc::new(Config), catalog })
}

pub(in crate::domains::ai_admin) fn hi() -> p::ModelRequest {
    p::ModelRequest { model: "m".into(), messages: vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))], tools: Vec::new(), options: p::RequestOptions::default() }
}

pub(in crate::domains::ai_admin) fn rejected(status: u16) -> MockAttempt {
    MockAttempt::Rejected(p::ErrorResponse { status: Some(status), headers: Vec::new(), body: Vec::new() })
}

#[tokio::test(start_paused = true)]
async fn the_pc_retries_and_the_server_sees_each_discard() {
    let pc = loopback([rejected(503), MockAttempt::Body(b"u:10,5\n".to_vec()), MockAttempt::Body(b"t:hi\ndone\n".to_vec())]).await;
    let mut sink = Sink::default();
    let attempts = remote_send(&pc, &NoStore, "mock", &hi(), &mut sink, &CancellationToken::new()).await.unwrap();
    assert_eq!(attempts, 3);
    assert_eq!(sink.discards, 2);
    assert_eq!(sink.abandoned, vec![(10, 5)]);
    assert!(matches!(sink.events.last(), Some(p::StreamEvent::Completed { .. })));
}

#[tokio::test(start_paused = true)]
async fn a_refusal_keeps_its_classification() {
    let pc = loopback([rejected(401)]).await;
    let error = remote_send(&pc, &NoStore, "mock", &hi(), &mut Sink::default(), &CancellationToken::new()).await.unwrap_err();
    assert!(matches!(error, SendError::Provider(e) if e.status == Some(401)));
}

/// Node's `ModelProxyUnavailableError` (model-proxy-channel.mjs `request` with no client): the text a
/// send with no PC behind it reports, and a transient failure that sent nothing.
#[test]
fn a_send_with_no_pc_reads_as_nodes_model_proxy_unavailable_error() {
    let text = "model proxy unavailable: no desktop client is connected to run model calls";
    let SendError::Provider(error) = execution_error(ProxyError::Unavailable(text.into())) else { panic!("not a provider error") };
    assert_eq!(error.message, text);
    assert_eq!((error.kind, error.delivery), (p::ErrorKind::Transient, p::DeliveryState::NotSent));
}

#[tokio::test(start_paused = true)]
async fn a_provider_the_pc_lacks_is_refused_by_name() {
    let pc = loopback([]).await;
    let error = remote_send(&pc, &NoStore, "absent", &hi(), &mut Sink::default(), &CancellationToken::new()).await.unwrap_err();
    let SendError::Provider(e) = error else { panic!("{error:?}") };
    assert_eq!((e.kind, e.code.as_deref()), (p::ErrorKind::InvalidRequest, Some("MODEL_PROXY_PROVIDER_UNAVAILABLE")));
}

#[tokio::test(start_paused = true)]
async fn the_other_calls_are_answered_on_the_pc() {
    let pc = loopback([]).await;
    let ask = |call| async {
        pc.0.run(call, None, &Collect(&Mutex::new(Vec::new())), &CancellationToken::new()).await
    };
    let w::ProxyAnswer::Usable { usable } = ask(w::ProxyCall::QuotaUsable { provider: "mock".into(), model: "ok".into() }).await.unwrap() else { panic!() };
    assert!(usable);
    let route = ask(w::ProxyCall::ResolveWireRoute { provider: "mock".into(), model: "m".into(), context: w::ProxyRouteContext { agent: true, legacy: false } }).await.unwrap();
    assert_eq!(route, w::ProxyAnswer::Route { route: Some(w::ProxyWireRoute { wire: w::ProxyWire::Messages, source: w::ProxyRouteSource::Family, profile_id: "mock:messages".into() }) });
    assert!(matches!(ask(w::ProxyCall::ProviderConfig).await.unwrap(), w::ProxyAnswer::ProviderConfig { ready: Some(true), .. }));
    assert!(ask(w::ProxyCall::QuotaUsable { provider: "absent".into(), model: "x".into() }).await.is_err());
    // A measurement that failed fails the call with its message, as a plain error with no code.
    let failure = ask(w::ProxyCall::QuotaUsable { provider: "mock".into(), model: "broken".into() }).await.unwrap_err();
    assert_eq!((failure.message.as_str(), failure.code, failure.kind), ("usage fetch failed", None, w::ProxyErrorKind::Unknown));
    // A call the server gave up reads nothing of the PC's.
    let given_up = CancellationToken::new();
    given_up.cancel();
    let failure = pc.0.run(w::ProxyCall::QuotaUsable { provider: "mock".into(), model: "ok".into() }, None, &Collect(&Mutex::new(Vec::new())), &given_up).await.unwrap_err();
    assert_eq!(failure.message, "The remote session cancelled the model call.");
    // A cached listing answers from the PC's catalog.
    let w::ProxyAnswer::Models { models } = ask(w::ProxyCall::ListModels { provider: "mock".into(), refresh: false }).await.unwrap() else { panic!() };
    assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["listed"]);
}

// -- against Node's recording of a proxied run (record-model-proxy-pc.mjs) -------------------

const PC_TWIN: &str = include_str!("../../../../../fixtures/model-proxy-pc/model-proxy-pc-twin.json");

/// A provider whose attempt never ends: only the cancel ends the call.
struct Hang(MockProvider);

#[async_trait]
impl p::ProviderAdapter for Hang {
    fn id(&self) -> &mixdog_protocol::ProviderId {
        self.0.id()
    }
    fn codec(&self) -> &dyn p::WireCodec {
        self.0.codec()
    }
    fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
        self.0.retry_policy()
    }
    fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
        self.0.keepalive()
    }
    async fn attempt(&self, _: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
        std::future::pending().await
    }
}

struct HangLookup(Arc<Hang>);

#[async_trait]
impl ProviderLookup for HangLookup {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == "mock").then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

#[tokio::test(start_paused = true)]
async fn a_run_streams_the_text_node_streamed_and_a_cancel_reads_as_nodes() {
    let twin: Value = serde_json::from_str(PC_TWIN).unwrap();
    // The text deltas of the recorded run, in order.
    let recorded: Vec<String> = twin["runs"]["stream"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["name"] == "onTextDelta")
        .map(|event| event["args"][0].as_str().unwrap().to_owned())
        .collect();
    let pc = loopback([MockAttempt::Body(b"t:Hel\nt:lo\ndone\n".to_vec())]).await;
    let events = Mutex::new(Vec::new());
    let call = w::ProxyCall::Send { provider: "mock".into(), request: Box::new(request_out(&hi())) };
    let answer = pc.0.run(call, None, &Collect(&events), &CancellationToken::new()).await.unwrap();
    assert!(matches!(answer, w::ProxyAnswer::Sent { attempts: 1 }));
    let streamed: Vec<String> = events.into_inner().unwrap().into_iter().filter_map(|event| if let w::ProxyEvent::TextDelta { text } = event { Some(text) } else { None }).collect();
    assert_eq!(streamed, recorded);

    // A cancel while the provider works: the failure carries the message Node's PC aborts with.
    let catalog = catalog(&[("mock", "listed")]).await;
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(StandardRetryDecider)));
    let hang = Arc::new(Hang(MockProvider::new(Vec::<MockAttempt>::new())));
    let runner = ProxyRunner { providers: Arc::new(HangLookup(hang)), broker, quota: Arc::new(Quota), wire: Arc::new(Wires), config: Arc::new(Config), catalog };
    let cancel = CancellationToken::new();
    let call = w::ProxyCall::Send { provider: "mock".into(), request: Box::new(request_out(&hi())) };
    let events = Mutex::new(Vec::new());
    let collect = Collect(&events);
    let run = runner.run(call, None, &collect, &cancel);
    let stop = async {
        tokio::task::yield_now().await;
        cancel.cancel();
    };
    let (failed, ()) = futures::future::join(run, stop).await;
    assert_eq!(failed.unwrap_err().message, twin["runs"]["cancel"]["reasons"][0]["message"].as_str().unwrap());

    // A provider the PC lacks: Node's refusal, code and text.
    let refusal = &twin["runs"]["refusals"][0];
    let failure = pc.0.run(w::ProxyCall::QuotaUsable { provider: "anthropic".into(), model: "m".into() }, None, &Collect(&Mutex::new(Vec::new())), &CancellationToken::new()).await.unwrap_err();
    assert_eq!((failure.code.as_deref(), failure.message.as_str()), (refusal["error"]["code"].as_str(), refusal["error"]["message"].as_str().unwrap()));
}

/// The host's saved list (Node `allowedProvidersForHost`): a provider outside it is refused by every call before
/// the PC looks it up, with the text of the recording, and is not named in the config answer.
#[tokio::test(start_paused = true)]
async fn a_provider_outside_the_hosts_list_is_refused_and_not_named() {
    let twin: Value = serde_json::from_str(PC_TWIN).unwrap();
    let recorded = twin["runs"]["refusals"].as_array().unwrap().iter().find(|r| r["label"] == "not allowed").unwrap();
    // "openai" in the recording; the same refusal for the provider this test names.
    let expected = recorded["error"]["message"].as_str().unwrap().replace("openai", "mock");
    let pc = loopback([MockAttempt::Body(b"t:hi\ndone\n".to_vec())]).await;
    let none: &[String] = &[];
    let other = ["other".to_owned()];
    let calls = [
        w::ProxyCall::QuotaUsable { provider: "mock".into(), model: "ok".into() },
        w::ProxyCall::ResolveWireRoute { provider: "mock".into(), model: "m".into(), context: w::ProxyRouteContext { agent: true, legacy: false } },
        w::ProxyCall::ListModels { provider: "mock".into(), refresh: false },
        w::ProxyCall::Send { provider: "mock".into(), request: Box::new(request_out(&hi())) },
    ];
    for list in [none, &other[..]] {
        for call in calls.clone() {
            let events = Mutex::new(Vec::new());
            let failure = pc.0.run(call, Some(list), &Collect(&events), &CancellationToken::new()).await.unwrap_err();
            assert_eq!((failure.code.as_deref(), failure.message.as_str()), (recorded["error"]["code"].as_str(), expected.as_str()));
            assert!(events.into_inner().unwrap().is_empty(), "nothing ran");
        }
    }
    // An empty list lets nothing be named; the provider that is listed is served.
    let listed = ["mock".to_owned()];
    let answer = pc.0.run(calls[0].clone(), Some(&listed), &Collect(&Mutex::new(Vec::new())), &CancellationToken::new()).await.unwrap();
    assert_eq!(answer, w::ProxyAnswer::Usable { usable: true });
    let w::ProxyAnswer::ProviderConfig { providers, .. } = pc.0.run(w::ProxyCall::ProviderConfig, Some(none), &Collect(&Mutex::new(Vec::new())), &CancellationToken::new()).await.unwrap() else { panic!() };
    assert!(providers.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn the_store_serves_attachments_by_their_digest() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = mixdog_store::blobs::BlobStore::new(dir.path());
    let bytes = b"stored pdf bytes".to_vec();
    let put = bytes.clone();
    let writer = store.clone();
    let digest = mixdog_core_base::support::on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| {
        writer.put(lane, &put).map(|pin| pin.digest().as_str().to_owned())
    })
    .await
    .unwrap()
    .unwrap();
    let attachments = StoreAttachments { store, interactive: tokens.interactive_io };
    let hex = digest.strip_prefix("sha256:").unwrap();
    assert_eq!(attachments.read(hex).await.unwrap(), bytes);
    // A blob that is not there will never be readable; a malformed reference is an error.
    assert_eq!(attachments.read(&"0".repeat(64)).await, Err(ReadError::Permanent));
    assert!(matches!(attachments.read("not-a-digest").await, Err(ReadError::Other(_))));
}
