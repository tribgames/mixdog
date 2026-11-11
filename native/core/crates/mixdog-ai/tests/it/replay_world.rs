//! The product side of a WIRE replay: the production provider builder (`DefaultProviderBuilder`, the one
//! `mixdog-core`'s `builder_env` feeds) over the driver's endpoint (`provider_case::Endpoint::link` around the
//! production `ReqwestLink`, `Endpoint::dialer`), and one send through `ModelBroker::send` with the standard retry
//! decider, as a run sends.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::providers::anthropic::catalog_caps::CatalogCaps;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::pace::Pace;
use mixdog_ai::providers::google::traits::ModelTraits;
use mixdog_ai::providers::google::traits::ThinkingControl;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::registry::builder::BuilderEnv;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::MemoryVault;
use mixdog_ai::registry::providers::ProviderBuilder as _;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_testkit::Exact;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::StreamEvent;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Endpoint;

/// The recorder's environment: only the variables a case sets.
struct CaseEnv(Vec<(String, String)>);

impl Environment for CaseEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }
}

/// No catalog traits: no case of these sets reads one.
struct NoTraits;

impl ModelTraits for NoTraits {
    fn is_gemini_family(&self, _: &str) -> bool {
        false
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

/// The OAuth pacing on the paused test clock.
struct PausedPace;

#[async_trait]
impl Pace for PausedPace {
    fn now_ms(&self) -> u64 {
        0
    }
    async fn wait(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// A recorded transcript message (`{role, content, toolCalls, toolCallId}`) as the core's message; any other key is
/// a shape these replays do not read, and fails.
pub fn message(node: &Exact) -> Message {
    let role = match node.get("role").as_str() {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        "system" => Role::System,
        other => panic!("role {other}"),
    };
    let mut message = Message::new(role, Content::Text(node.get("content").as_str().to_owned()));
    for (key, value) in node.entries() {
        match key.as_str() {
            "role" | "content" => {}
            "toolCallId" => message.tool_call_id = Some(value.as_str().to_owned()),
            "toolCalls" => {
                message.tool_calls = value
                    .as_array()
                    .iter()
                    .map(|call| {
                        assert_eq!(call.entries().len(), 3, "a {{id, name, arguments}} call: {call:?}");
                        ToolCall {
                            id: call.get("id").as_str().to_owned(),
                            name: call.get("name").as_str().to_owned(),
                            arguments: crate::provider_cases::plain(call.get("arguments")),
                            native_type: None,
                        }
                    })
                    .collect();
            }
            // Node's `{version, provider, items}` envelope; the Anthropic and Responses decoders hold `items` as is
            // (Gemini's `{parts}` form is built by its own replay).
            "providerReplay" => {
                assert_eq!(value.get("version").as_f64(), 1.0, "a version-1 envelope");
                message.push_replay(mixdog_core_api::domain::provider::ProviderReplay {
                    owner: mixdog_protocol::ProviderId::from(value.get("provider").as_str()),
                    items: crate::provider_cases::plain(value.get("items")),
                });
            }
            other => panic!("a message key these replays do not read: {other}"),
        }
    }
    message
}

/// A recorded tool definition (`{name, description, inputSchema}`).
pub fn tool(node: &Exact) -> ToolDefinition {
    assert_eq!(node.entries().len(), 3, "a {{name, description, inputSchema}} tool: {node:?}");
    ToolDefinition {
        name: node.get("name").as_str().to_owned(),
        description: node.get("description").as_str().to_owned(),
        input_schema: crate::provider_cases::plain(node.get("inputSchema")),
        defer_loading: false,
        freeform: None,
    }
}

/// The request of a recorded `send(messages, model, tools, opts)` with empty `opts`.
pub fn request(args: &[Exact]) -> ModelRequest {
    assert!(args.get(3).is_none_or(|opts| opts.entries().is_empty()), "send options these replays do not read: {:?}", args[3]);
    ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: args[0].as_array().iter().map(message).collect(),
        tools: args[2].as_array().iter().map(tool).collect(),
        options: RequestOptions::default(),
    }
}

/// The production builder over `endpoint`, with the case's environment, credentials under `home`.
pub async fn builder(endpoint: &Endpoint, home: &std::path::Path, env: Vec<(String, String)>) -> DefaultProviderBuilder {
    builder_with(endpoint, home, env, SessionContext::new()).await
}

/// [`builder`] with the OpenAI session context (its clock and request ids: the recorded world's).
pub async fn builder_with(
    endpoint: &Endpoint,
    home: &std::path::Path,
    env: Vec<(String, String)>,
    context: SessionContext,
) -> DefaultProviderBuilder {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let env: Arc<dyn Environment> = Arc::new(CaseEnv(env));
    let link = Arc::new(endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link")));
    // The product's Anthropic caps over an empty catalog, as the recorders ran: Node's release-generation floor.
    let metadata = ModelsDevSource::new(link.clone(), home.join("catalog"), io);
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
    DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(endpoint.dialer(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false),
        accounts: AccountStore::new(home.to_path_buf(), io),
        anthropic_caps: CatalogCaps::new(catalog, &*env).lookup(),
        google_traits: Arc::new(NoTraits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(context),
        codex_identity: CodexIdentity {
            installation_id: String::new(),
            user_agent: "".into(),
            version: "".into(),
            beta_features: String::new(),
        },
        pace: Arc::new(PausedPace),
        gzip_lane: tokens.cpu_bulk,
        client_version: String::new(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "".into(),
        listing: ListingLookup::new(),
        env,
        home_dir: home.to_path_buf(),
        io,
        gated_off: Arc::new(|_| false),
    })
}

/// The adapter the builder makes of provider `name` with config `cfg`.
pub async fn adapter(builder: &DefaultProviderBuilder, name: &str, cfg: &Value) -> Arc<dyn ProviderAdapter> {
    builder.build(name, cfg).await.unwrap_or_else(|e| panic!("build {name}: {e}"))
}

/// Every event and discard of the send, in order.
#[derive(Default)]
pub struct Events {
    pub events: Vec<StreamEvent>,
    pub discards: u32,
    /// The caller's cancel once the first text reached it (the recorder's `onTextDelta` abort).
    pub cancel_on_text: Option<CancellationToken>,
}

impl AttemptSink for Events {
    fn event(&mut self, event: StreamEvent) {
        if matches!(event, StreamEvent::TextDelta(_))
            && let Some(cancel) = self.cancel_on_text.take()
        {
            cancel.cancel();
        }
        self.events.push(event);
    }
    fn discard(&mut self) {
        self.discards += 1;
    }
}

/// One send through `ModelBroker::send`.
pub async fn send_with(
    adapter: &dyn ProviderAdapter,
    request: ModelRequest,
    cancel: &CancellationToken,
    mut events: Events,
) -> (Result<u32, SendError>, Events) {
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new(adapter.id().clone(), "default"), LaneSettings::default());
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    let sent = broker
        .send(adapter, SendRequest { request: Arc::new(request), lane, admission: AdmissionRequest::default() }, &mut events, cancel)
        .await;
    (sent, events)
}
