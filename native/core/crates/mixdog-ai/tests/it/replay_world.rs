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
use mixdog_ai::catalog::ListingLookup;
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
use mixdog_core_api::domain::provider::ModelRequest;
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

/// The production builder over `endpoint`, with the case's environment, credentials under `home`.
pub fn builder(endpoint: &Endpoint, home: &std::path::Path, env: Vec<(String, String)>) -> DefaultProviderBuilder {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let env: Arc<dyn Environment> = Arc::new(CaseEnv(env));
    let link = Arc::new(endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link")));
    DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(endpoint.dialer(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false),
        accounts: AccountStore::new(home.to_path_buf(), io),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(NoTraits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
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
}

impl AttemptSink for Events {
    fn event(&mut self, event: StreamEvent) {
        self.events.push(event);
    }
    fn discard(&mut self) {
        self.discards += 1;
    }
}

/// One send through `ModelBroker::send`.
pub async fn send(adapter: &dyn ProviderAdapter, request: ModelRequest, cancel: &CancellationToken) -> (Result<u32, SendError>, Events) {
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new(adapter.id().clone(), "default"), LaneSettings::default());
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    let mut events = Events::default();
    let sent = broker
        .send(adapter, SendRequest { request: Arc::new(request), lane, admission: AdmissionRequest::default() }, &mut events, cancel)
        .await;
    (sent, events)
}
