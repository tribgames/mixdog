//! The pool over an account provider's engines ([`AccountEngines`]): the walk an OAuth provider's send takes.

use std::collections::HashMap;

use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;

use super::*;
use crate::accounts::AccountStore;
use crate::oauth::CredentialIo;
use crate::oauth::pace::FakePace;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::compat::profile::CompatProfile;

const PROVIDER: &str = "anthropic-oauth";
const ID_A: &str = "11111111-1111-4111-8111-111111111111";
const ID_B: &str = "22222222-2222-4222-8222-222222222222";

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

/// One account's engine: refuses with its scripted error, else answers `text`; keeps what each request carried.
struct Engine {
    id: ProviderId,
    refusal: Option<ProviderError>,
    text: &'static str,
    /// Whether each request it was sent carried the session's provider state.
    states: Mutex<Vec<bool>>,
    released: Mutex<Vec<String>>,
    loops: Mutex<u32>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
}

fn engine(text: &'static str, refusal: Option<ProviderError>) -> Arc<Engine> {
    Arc::new(Engine {
        id: ProviderId::from(PROVIDER),
        refusal,
        text,
        states: Mutex::default(),
        released: Mutex::default(),
        loops: Mutex::default(),
        policy: CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless).retry_policy(),
        keepalive: KeepaliveSchedule::SPEC,
    })
}

struct Events(VecDeque<StreamEvent>);

#[async_trait]
impl ModelStream for Events {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front().map(Ok)
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl ProviderAdapter for Engine {
    fn release_send(&self, _group: &str) {}
    fn begin_loop(&self) {
        *self.loops.lock().unwrap() += 1;
    }
    fn release_session(&self, session_id: &str) {
        self.released.lock().unwrap().push(session_id.to_owned());
    }
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
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.states.lock().unwrap().push(request.options.provider_state.is_some());
        if let Some(refusal) = &self.refusal {
            return Err(refusal.clone());
        }
        let events = [StreamEvent::TextDelta(self.text.into()), StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None }];
        Ok(Box::new(Events(events.into())))
    }
}

/// The accounts' engines as the builder's `OAuthEngines` hands them out, without the credential files.
struct Engines {
    rotation: Option<AccountRotation>,
    by_account: HashMap<String, Arc<Engine>>,
    handed: Mutex<Vec<String>>,
}

#[async_trait]
impl AccountEngines for Engines {
    fn rotation(&self) -> Option<AccountRotation> {
        self.rotation.clone()
    }
    async fn engine(&self, account: &str, _home: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        self.handed.lock().unwrap().push(account.to_owned());
        Ok(self.by_account[account].clone())
    }
    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        let handed = self.handed.lock().unwrap();
        self.by_account.iter().filter(|(id, _)| handed.contains(id)).map(|(_, engine)| engine.clone() as Arc<dyn ProviderAdapter>).collect()
    }
    async fn home(&self) -> String {
        ID_A.to_owned()
    }
    fn state_bound(&self) -> bool {
        true
    }
}

fn quota_refusal() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::Accepted);
    error.status = Some(429);
    error.message = "This request would exceed your account's rate limit.".into();
    error
}

async fn roster(dir: &tempfile::TempDir) -> (AccountStore, AccountRotation) {
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    store.register(PROVIDER, ID_A, "A", false).await.unwrap();
    store.register(PROVIDER, ID_B, "B", false).await.unwrap();
    let pace = Arc::new(FakePace { now: std::sync::atomic::AtomicU64::new(1_800_000_000_000), ..FakePace::default() });
    (store.clone(), AccountRotation::new(store, Arc::new(NoMeter), pace))
}

fn request() -> Arc<ModelRequest> {
    let options = RequestOptions { session_id: Some("s1".into()), provider_state: Some(ProviderState::default()), ..RequestOptions::default() };
    Arc::new(ModelRequest { model: "claude-haiku-5-5".into(), messages: Vec::new(), tools: Vec::new(), options })
}

async fn drain(mut stream: Box<dyn ModelStream>) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.expect("an event"));
    }
    events
}

#[tokio::test]
async fn an_account_at_its_limit_hands_the_same_request_to_the_next_account() {
    let dir = tempfile::tempdir().unwrap();
    let (store, rotation) = roster(&dir).await;
    let (primary, a, b) = (engine("primary", None), engine("a", Some(quota_refusal())), engine("b", None));
    let engines = Arc::new(Engines {
        rotation: Some(rotation),
        by_account: [(ID_A.to_owned(), a.clone()), (ID_B.to_owned(), b.clone())].into(),
        handed: Mutex::default(),
    });
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines.clone());

    let events = drain(pool.attempt(request()).await.expect("the next account answers")).await;

    // The selected account was asked first, refused for quota, and the request went on to the other one.
    assert_eq!(*engines.handed.lock().unwrap(), [ID_A, ID_B]);
    assert!(primary.states.lock().unwrap().is_empty(), "the following engine sends nothing once a rotation is bound");
    let texts: Vec<&str> = events.iter().filter_map(|e| if let StreamEvent::TextDelta(text) = e { Some(text.as_str()) } else { None }).collect();
    assert_eq!(texts, ["b"]);
    assert!(
        events.iter().any(|e| matches!(e, StreamEvent::AccountStage(AccountStage::Switching { message }) if message.ends_with("switching to the next account"))),
        "the caller is told the pool moves on"
    );
    assert!(
        events.iter().any(|e| matches!(e, StreamEvent::AccountRouting(routing) if routing.provider == PROVIDER && routing.account_id == ID_B)),
        "the answer names the account that served it"
    );
    assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })), "the serving attempt's end comes last");
    // The session's provider state is its own account's: the account that takes over sends without it.
    assert_eq!((a.states.lock().unwrap().clone(), b.states.lock().unwrap().clone()), (vec![true], vec![false]));
    // The fallback is the provider's account from now on, and the spent one is blocked for the model.
    let saved = store.pool(PROVIDER).await.unwrap();
    assert_eq!(saved.selected_id.as_deref(), Some(ID_B));
    assert!(!saved.account(ID_A).unwrap().blocks().is_empty(), "the spent account is blocked");

    // A session's release reaches every account engine that sent for it.
    pool.release_session("s1");
    for served in [&a, &b, &primary] {
        assert_eq!(*served.released.lock().unwrap(), ["s1"]);
    }
}

#[tokio::test]
async fn without_a_bound_rotation_the_provider_sends_on_its_own_engine() {
    let (primary, a) = (engine("primary", None), engine("a", None));
    let engines = Arc::new(Engines { rotation: None, by_account: [(ID_A.to_owned(), a.clone())].into(), handed: Mutex::default() });
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines.clone());
    let events = drain(pool.attempt(request()).await.unwrap()).await;
    assert!(matches!(&events[0], StreamEvent::TextDelta(text) if text == "primary"));
    assert!(engines.handed.lock().unwrap().is_empty());
    assert_eq!(*primary.states.lock().unwrap(), [true], "the request goes out as it came");
}

/// A wrapper that leaves a provider method to the trait's default answers for the provider wrongly (a retry ladder of
/// the default length, a recovery that never runs): every method of the trait is forwarded.
#[test]
fn the_pool_forwards_every_provider_method() {
    let source = include_str!("key_pool.rs");
    let forwarded = source.split("impl ProviderAdapter for KeyPoolAdapter").nth(1).expect("the adapter's impl");
    let api = include_str!("../../../mixdog-core-api/src/domain/provider.rs");
    let methods = api.split("pub trait ProviderAdapter").nth(1).expect("the trait").split("\n}\n").next().unwrap();
    let missing: Vec<&str> = methods
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("async fn ").or_else(|| line.trim_start().strip_prefix("fn ")))
        .filter_map(|rest| rest.split('(').next())
        .filter(|name| !forwarded.contains(&format!("fn {name}(")))
        .collect();
    assert!(missing.is_empty(), "not forwarded: {missing:?}");
}

#[tokio::test]
async fn entering_a_loop_reaches_the_roster_provider_once() {
    let dir = tempfile::tempdir().unwrap();
    let (_, rotation) = roster(&dir).await;
    let primary = engine("primary", None);
    rotation.mark_probed(PROVIDER, ID_A);
    assert!(rotation.probe_paced(PROVIDER, ID_A));
    let engines = Arc::new(Engines { rotation: Some(rotation.clone()), by_account: HashMap::new(), handed: Mutex::default() });
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines);

    pool.begin_loop();

    assert_eq!(*primary.loops.lock().unwrap(), 1);
    assert!(!rotation.probe_paced(PROVIDER, ID_A), "a new loop measures again");
}
