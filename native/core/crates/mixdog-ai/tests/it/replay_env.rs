//! The product's provider builder and broker over the shared case driver's endpoint (`provider_case`), as the group-A
//! replays drive them: `DefaultProviderBuilder::build` with the production link and dialer redirected to the endpoint,
//! an empty catalog (the recorders' Node world has none), and `ModelBroker::send` collecting the stream's events.
#![allow(dead_code, reason = "each replay set uses part of it")]

use std::sync::Arc;

use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::SystemPace;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::registry::builder::BuilderEnv;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
pub use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::registry::keys::MemoryVault;
use mixdog_ai::registry::keys::ProcessEnv;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::provider_case::Endpoint;

pub struct Env {
    pub builder: DefaultProviderBuilder,
    _home: tempfile::TempDir,
}

/// The production builder with the endpoint's link and dialer.
pub fn env(endpoint: &Endpoint) -> Env {
    let tokens = mixdog_rt::testing::tokens();
    let home = tempfile::tempdir().expect("a home");
    let link = Arc::new(endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link")));
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let builder = DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(endpoint.dialer(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(ProcessEnv), false),
        accounts: AccountStore::new(home.path().to_path_buf(), io),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(CatalogGoogleTraits(Vec::new())),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: CodexIdentity { installation_id: String::new(), user_agent: "".into(), version: "".into(), beta_features: String::new() },
        pace: Arc::new(SystemPace),
        gzip_lane: tokens.cpu_bulk,
        client_version: String::new(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: String::new().into(),
        listing: ListingLookup::new(),
        env: Arc::new(ProcessEnv),
        home_dir: home.path().to_path_buf(),
        io,
        gated_off: Arc::new(|_| false),
    });
    Env { builder, _home: home }
}

/// The events of every attempt the broker made, in order; a discarded attempt's events are marked by a `None`.
#[derive(Default)]
pub struct Collected {
    pub events: Vec<StreamEvent>,
    pub discards: u32,
}

impl AttemptSink for Collected {
    fn event(&mut self, event: StreamEvent) {
        self.events.push(event);
    }
    fn discard(&mut self) {
        self.discards += 1;
        self.events.clear();
    }
    fn abandoned(&mut self, _: &Usage, _: Option<&str>) {}
}

/// `ModelBroker::send` of `request` to `adapter`, as the run loop sends it.
pub async fn send(adapter: &dyn ProviderAdapter, request: ModelRequest) -> (Collected, Result<u32, SendError>) {
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new(adapter.id().clone(), "default"), LaneSettings::default());
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    let mut sink = Collected::default();
    let outcome = broker
        .send(adapter, SendRequest { request: Arc::new(request), lane, admission: AdmissionRequest::default() }, &mut sink, &CancellationToken::new())
        .await;
    (sink, outcome)
}

/// A Node transcript message (`{role, content}` with text content) as the neutral one.
pub fn message(node: &Exact) -> Message {
    let role = match node.get("role").as_str() {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("role {other}"),
    };
    Message::new(role, Content::Text(node.get("content").as_str().to_owned()))
}

/// A send's request from Node's `send(messages, model, tools, opts)` arguments (text messages, no tools).
pub fn request(args: &[Exact]) -> ModelRequest {
    ModelRequest {
        model: args[1].as_str().to_owned(),
        messages: args[0].as_array().iter().map(message).collect(),
        tools: Vec::new(),
        options: RequestOptions::default(),
    }
}
