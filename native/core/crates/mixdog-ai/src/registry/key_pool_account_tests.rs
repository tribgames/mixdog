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
    /// The provider state each request it was sent carried.
    seen: Mutex<Vec<Option<ProviderState>>>,
    /// The history each request it was sent carried.
    histories: Mutex<Vec<Vec<Message>>>,
    released: Mutex<Vec<String>>,
    loops: Mutex<u32>,
    recovered: Mutex<u32>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    /// The provider's own listing, when this engine is the provider's own adapter that lists.
    listing: Option<Arc<Live>>,
}

/// A listing whose credential names no account (an imported Claude CLI login without `identity.id`): it lists live.
#[derive(Default)]
struct Live {
    fetches: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl ModelListing for Live {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        self.fetches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(vec![mixdog_core_api::domain::provider::ModelRecord::new("claude-live-model")])
    }
}

fn engine(text: &'static str, refusal: Option<ProviderError>) -> Arc<Engine> {
    Arc::new(Engine {
        id: ProviderId::from(PROVIDER),
        refusal,
        text,
        states: Mutex::default(),
        seen: Mutex::default(),
        histories: Mutex::default(),
        released: Mutex::default(),
        loops: Mutex::default(),
        recovered: Mutex::default(),
        policy: CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless).retry_policy(),
        keepalive: KeepaliveSchedule::SPEC,
        listing: None,
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
    fn models(&self) -> Option<&dyn ModelListing> {
        self.listing.as_deref().map(|listing| listing as &dyn ModelListing)
    }
    /// The re-issue after a spent ladder is counted apart and answers, whatever the attempts were refused with.
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        *self.recovered.lock().unwrap() += 1;
        self.keep(&request);
        Ok(self.answer())
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.keep(&request);
        if let Some(refusal) = &self.refusal {
            return Err(refusal.clone());
        }
        Ok(self.answer())
    }
}

impl Engine {
    fn keep(&self, request: &ModelRequest) {
        self.states.lock().unwrap().push(request.options.provider_state.is_some());
        self.seen.lock().unwrap().push(request.options.provider_state.clone());
        self.histories.lock().unwrap().push(request.messages.clone());
    }

    fn answer(&self) -> Box<dyn ModelStream> {
        // Every answer reports a state of its own, as a Responses engine reports its slot.
        let state = ProviderState { gemini: None, rest: [("slot".to_owned(), self.text.into())].into_iter().collect() };
        let events = [
            StreamEvent::TextDelta(self.text.into()),
            StreamEvent::ProviderState(state),
            StreamEvent::Completed { stop: None, pricing_model: None, request_ms: None },
        ];
        Box::new(Events(events.into()))
    }
}

/// The accounts' engines as the builder's `OAuthEngines` hands them out, without the credential files.
struct Engines {
    rotation: Option<AccountRotation>,
    by_account: HashMap<String, Arc<Engine>>,
    handed: Mutex<Vec<String>>,
    /// The provider's current account.
    home: Mutex<String>,
    /// The account the roster's selection moves to the moment an engine is handed out: after the pool chose the
    /// request's state, before the engine reads its credential.
    moves_to: Option<String>,
    /// A custom-key pool's rule for a state no row stamped.
    owns_unstamped: bool,
}

fn engines(rotation: Option<AccountRotation>, by_account: &[(&str, &Arc<Engine>)]) -> Arc<Engines> {
    moving(rotation, by_account, None)
}

fn moving(rotation: Option<AccountRotation>, by_account: &[(&str, &Arc<Engine>)], moves_to: Option<&str>) -> Arc<Engines> {
    Arc::new(Engines {
        rotation,
        by_account: by_account.iter().map(|(id, engine)| ((*id).to_owned(), Arc::clone(engine))).collect(),
        handed: Mutex::default(),
        home: Mutex::new(ID_A.to_owned()),
        moves_to: moves_to.map(str::to_owned),
        owns_unstamped: false,
    })
}

#[async_trait]
impl AccountEngines for Engines {
    fn rotation(&self) -> Option<AccountRotation> {
        self.rotation.clone()
    }
    async fn pinned(&self, account: &str) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        self.handed.lock().unwrap().push(account.to_owned());
        if let Some(next) = &self.moves_to {
            next.clone_into(&mut self.home.lock().unwrap());
        }
        Ok(self.by_account[account].clone())
    }
    fn built(&self) -> Vec<Arc<dyn ProviderAdapter>> {
        let handed = self.handed.lock().unwrap();
        self.by_account.iter().filter(|(id, _)| handed.contains(id)).map(|(_, engine)| engine.clone() as Arc<dyn ProviderAdapter>).collect()
    }
    async fn home(&self) -> String {
        self.home.lock().unwrap().clone()
    }
    fn owns_unstamped_state(&self) -> bool {
        self.owns_unstamped
    }
}

fn quota_refusal() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::Accepted);
    error.status = Some(429);
    error.message = "This request would exceed your account's rate limit.".into();
    error
}

fn request() -> Arc<ModelRequest> {
    request_with(Some(stamped(ProviderState::default(), PROVIDER, ID_A)))
}

fn made(text: &str) -> ProviderState {
    ProviderState { gemini: None, rest: [("slot".to_owned(), text.into())].into_iter().collect() }
}

/// The row a state is stamped as.
fn owner(state: &ProviderState) -> Option<&str> {
    state.rest.get(STATE_ACCOUNT)?.as_str()
}

fn request_with(provider_state: Option<ProviderState>) -> Arc<ModelRequest> {
    let options = RequestOptions { session_id: Some("s1".into()), provider_state, ..RequestOptions::default() };
    Arc::new(ModelRequest { model: "claude-haiku-5-5".into(), messages: Vec::new(), tools: Vec::new(), options })
}

async fn drain(mut stream: Box<dyn ModelStream>) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event.expect("an event"));
    }
    events
}

/// Without a bound rotation the send is the provider's current account's, on the engine pinned to that account: the
/// provider's own engine, which follows the selection at each credential read, sends nothing.
#[tokio::test]
async fn without_a_bound_rotation_the_current_account_sends_on_its_pinned_engine() {
    let (primary, a) = (engine("primary", None), engine("a", None));
    let engines = engines(None, &[(ID_A, &a)]);
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines.clone());
    let events = drain(pool.attempt(request()).await.unwrap()).await;
    assert!(matches!(&events[0], StreamEvent::TextDelta(text) if text == "a"));
    assert_eq!(*engines.handed.lock().unwrap(), [ID_A]);
    assert!(primary.states.lock().unwrap().is_empty());
    assert_eq!(*a.states.lock().unwrap(), [true], "A is sent the state it produced");
}

/// The current account's send is sent the state that account produced and not another's (`servedBy(providerState) ===
/// row.id`, else none). Outside a roster walk the state it reports carries no stamp, as Node's `account('default').send`.
#[tokio::test]
async fn the_current_account_is_sent_only_its_own_state() {
    let (primary, a) = (engine("primary", None), engine("a", None));
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary, engines(None, &[(ID_A, &a)]));

    let events = drain(pool.attempt(request_with(Some(stamped(made("b"), PROVIDER, ID_B)))).await.unwrap()).await;

    assert_eq!(*a.seen.lock().unwrap(), [None], "the current account (A) is not sent B's state");
    let left = reported(&events);
    assert_eq!((slot(&Some(left.clone())), owner(&left)), (Some("a"), None));
}

/// The re-issue after a spent ladder goes out on the row the send's latest attempt went out on, as Node's runs inside
/// that row's `account(row.id).send`, with that row's state: the selection moving after the attempt does not move it,
/// and neither does the current row the roster walk left. Its answer is stamped as that row's inside a roster walk only.
#[tokio::test]
async fn a_recovery_goes_out_on_the_row_the_attempt_went_out_on() {
    let (primary, a, b) = (engine("primary", None), engine("a", None), engine("b", None));
    // The selection moves to B the moment A's engine is handed out.
    let engines = moving(None, &[(ID_A, &a), (ID_B, &b)], Some(ID_B));
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines.clone());
    let request = request_with(Some(stamped(made("of a"), PROVIDER, ID_A)));
    drain(pool.attempt(request.clone()).await.unwrap()).await;

    let events = drain(pool.recover_spent(request).await.unwrap()).await;

    assert_eq!(*engines.handed.lock().unwrap(), [ID_A, ID_A]);
    assert_eq!((*a.recovered.lock().unwrap(), *b.recovered.lock().unwrap(), primary.states.lock().unwrap().len()), (1, 0, 0));
    assert_eq!(slot(&a.seen.lock().unwrap()[1]), Some("of a"), "A's engine is sent A's state");
    assert_eq!(owner(&reported(&events)), None, "no roster walk: the answer's state carries no stamp");
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::AccountRouting(_))));

    // Inside a roster walk: A is at its limit, B's ladder is spent; the re-issue is B's though A is still the current row.
    // A message without routing was A's for the attempt, and stays A's for the re-issue though the selection moved to B.
    let dir = tempfile::tempdir().unwrap();
    let (_, rotation) = roster(&dir).await;
    let mut spent = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    spent.message = "the stream ladder is spent".into();
    let (a, b) = (engine("a", Some(quota_refusal())), engine("b", Some(spent)));
    let engines = moving(Some(rotation), &[(ID_A, &a), (ID_B, &b)], None);
    let pool = KeyPoolAdapter::with_engines(PROVIDER, engine("primary", None), engines.clone());
    let mut unstamped = Message::new(mixdog_core_api::domain::provider::Role::Assistant, mixdog_core_api::domain::provider::Content::Text("t".into()));
    unstamped.thinking_blocks = Some(serde_json::json!([{ "type": "thinking", "thinking": "a's", "signature": "sig-a" }]));
    let mut request = (*request_with(Some(stamped(made("of a"), PROVIDER, ID_A)))).clone();
    request.messages = vec![unstamped];
    let request = Arc::new(request);
    if let Ok(mut stream) = pool.attempt(request.clone()).await {
        while let Some(Ok(_)) = stream.next().await {}
    }
    ID_B.clone_into(&mut engines.home.lock().unwrap());

    let events = drain(pool.recover_spent(request).await.unwrap()).await;

    assert_eq!(*engines.handed.lock().unwrap(), [ID_A, ID_B, ID_B]);
    assert_eq!((*a.recovered.lock().unwrap(), *b.recovered.lock().unwrap()), (0, 1));
    assert_eq!(b.seen.lock().unwrap()[1], None, "B is not sent A's state");
    let histories = b.histories.lock().unwrap();
    assert_eq!((histories[0][0].thinking_blocks.as_ref(), histories[1][0].thinking_blocks.as_ref()), (None, None), "A's thinking reaches neither B's attempt nor its re-issue");
    drop(histories);
    assert_eq!(owner(&reported(&events)), Some(ID_B));
    assert!(events.iter().any(|e| matches!(e, StreamEvent::AccountRouting(routing) if routing.account_id == ID_B)));
}

/// The primary key of a custom provider, as one fixed engine.
struct Own(Arc<Engine>);

#[async_trait]
impl OwnKey for Own {
    async fn pinned(&self) -> Result<Arc<dyn ProviderAdapter>, ProviderError> {
        Ok(self.0.clone())
    }
    fn built(&self) -> Option<Arc<dyn ProviderAdapter>> {
        Some(self.0.clone())
    }
}

/// A Chat turn another key served goes to the primary key with its `reasoningContent` and the field it goes out as,
/// which the wire needs, and without that key's opaque `reasoningDetails`.
#[tokio::test]
async fn another_keys_chat_replay_keeps_only_its_reasoning_text() {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Role;
    let dir = tempfile::tempdir().unwrap();
    let (_, rotation) = roster(&dir).await;
    let primary = engine("primary", None);
    let pool = KeyPoolAdapter::new("custom-x", engine("unused", None), Arc::new(Own(primary.clone())), Vec::new(), rotation);
    let mut turn = Message::new(Role::Assistant, Content::Text("t".into()));
    let owner_id = ProviderId::from("custom-x");
    turn.push_replay(ProviderReplay {
        owner: owner_id.clone(),
        items: serde_json::json!({ "reasoningContent": "why", "reasoningField": "reasoning", "reasoningDetails": [{ "type": "reasoning.encrypted", "data": "of-key-2" }] }),
    });
    turn.account_routing = Some(AccountRouting { provider: "custom-x".into(), account_id: "key-2".into(), session_account_id: None });
    let mut request = (*request_with(None)).clone();
    request.messages = vec![turn];

    drain(pool.attempt(Arc::new(request)).await.unwrap()).await;

    let sent = primary.histories.lock().unwrap()[0][0].provider_replay().to_vec();
    assert_eq!(sent, [ProviderReplay { owner: owner_id, items: serde_json::json!({ "reasoningContent": "why", "reasoningField": "reasoning" }) }]);
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


async fn roster(dir: &tempfile::TempDir) -> (AccountStore, AccountRotation) {
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    store.register(PROVIDER, ID_A, "A", false).await.unwrap();
    store.register(PROVIDER, ID_B, "B", false).await.unwrap();
    let pace = Arc::new(FakePace { now: std::sync::atomic::AtomicU64::new(1_800_000_000_000), ..FakePace::default() });
    (store.clone(), AccountRotation::new(store, Arc::new(NoMeter), pace))
}
#[tokio::test]
async fn an_account_at_its_limit_hands_the_same_request_to_the_next_account() {
    let dir = tempfile::tempdir().unwrap();
    let (store, rotation) = roster(&dir).await;
    let (primary, a, b) = (engine("primary", None), engine("a", Some(quota_refusal())), engine("b", None));
    let engines = engines(Some(rotation), &[(ID_A, &a), (ID_B, &b)]);
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
fn reported(events: &[StreamEvent]) -> ProviderState {
    events.iter().find_map(|e| if let StreamEvent::ProviderState(state) = e { Some(state.clone()) } else { None }).expect("the answer's state")
}

/// The local refusal a proven exhaustion makes before the wire keeps the reset the proof found.
#[test]
fn a_local_exhaustion_refusal_keeps_the_proven_reset() {
    use crate::accounts::rotation::{Cause, PoolError, QuotaExhausted};
    let refusal = pool_error(PoolError {
        cause: Cause::AccountsExhausted { use_credits: false },
        quota_exhausted: Some(QuotaExhausted { provider: "p".into(), model: "m".into(), reset_at: Some(1_900_000_000_000) }),
    });
    assert_eq!(refusal.kind, ErrorKind::QuotaExhausted);
    assert_eq!(refusal.delivery, DeliveryState::NotSent);
    assert_eq!(refusal.reset_at, Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_900_000_000_000)));
}

fn slot(state: &Option<ProviderState>) -> Option<&str> {
    state.as_ref()?.rest.get("slot")?.as_str()
}

/// The account changes inside a send (the first is at its quota): the account that takes over is sent no state of the
/// first's, and the answer's state is the taker's own.
#[tokio::test]
async fn an_account_that_takes_over_inside_a_send_is_not_sent_the_refused_accounts_state() {
    let dir = tempfile::tempdir().unwrap();
    let (_, rotation) = roster(&dir).await;
    let (primary, a, b) = (engine("primary", None), engine("a", Some(quota_refusal())), engine("b", None));
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary, engines(Some(rotation), &[(ID_A, &a), (ID_B, &b)]));

    let events = drain(pool.attempt(request_with(Some(stamped(made("held"), PROVIDER, ID_A)))).await.unwrap()).await;

    assert_eq!(slot(&a.seen.lock().unwrap()[0]), Some("held"), "the account that produced it was asked first, with it");
    assert_eq!(*b.seen.lock().unwrap(), [None]);
    let left = reported(&events);
    assert_eq!((slot(&Some(left.clone())), owner(&left)), (Some("b"), Some(ID_B)));
}

/// A state no row stamped (a pool-less send, an older build) is sent to no row of an OAuth pool (`replayAccount` names
/// none), and in a custom-key pool to `default` alone (`customKeyServedBy`'s `|| 'default'`).
#[tokio::test]
async fn a_state_nobody_stamped_goes_to_no_oauth_row_and_to_the_default_key_only() {
    for custom in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (_, rotation) = roster(&dir).await;
        let (primary, first, b) = (engine("primary", None), engine("first", Some(quota_refusal())), engine("b", None));
        // A stands for the custom pool's `default`: the row its `home` names.
        let rows = Arc::try_unwrap(engines(Some(rotation), &[(ID_A, &first), (ID_B, &b)])).ok().unwrap();
        let pool = KeyPoolAdapter::with_engines(PROVIDER, primary, Arc::new(Engines { owns_unstamped: custom, ..rows }));

        drain(pool.attempt(request_with(Some(made("unstamped")))).await.unwrap()).await;

        let expected = custom.then_some("unstamped");
        assert_eq!(slot(&first.seen.lock().unwrap()[0]), expected, "custom {custom}: the current row");
        assert_eq!(*b.seen.lock().unwrap(), [None], "custom {custom}: another row");
    }
}

/// An assistant turn of a tool loop another row served, its ordered blocks holding signed thinking ahead of the tool
/// call: the row that sends now gets none of that row's thinking in any representation, and the Anthropic request it
/// lowers to rebuilds the turn from its text and tool call, so the tool call still pairs with its result.
#[tokio::test]
async fn another_rows_signed_thinking_reaches_no_representation_and_the_tool_pair_stays() {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::ToolCall;
    let a = engine("a", None);
    let pool = KeyPoolAdapter::with_engines(PROVIDER, engine("primary", None), engines(None, &[(ID_A, &a)]));
    let thinking = serde_json::json!({ "type": "thinking", "thinking": "plan", "signature": "sig-of-b" });
    let mut calling = Message::new(Role::Assistant, Content::Text("checking".into()));
    calling.tool_calls = vec![ToolCall { id: "call-1".into(), name: "read".into(), arguments: serde_json::json!({ "path": "a" }), native_type: None }];
    calling.thinking_blocks = Some(serde_json::json!([thinking.clone()]));
    calling.assistant_blocks = Some(serde_json::json!([
        thinking,
        { "type": "text", "text": "checking" },
        { "type": "tool_use", "id": "call-1", "name": "read", "input": { "path": "a" } },
    ]));
    calling.gemini_metadata = Some(serde_json::json!({ "thoughtParts": [{ "text": "plan", "thought": true, "thoughtSignature": "sig-of-b" }] }));
    calling.push_replay(ProviderReplay { owner: ProviderId::from(PROVIDER), items: serde_json::json!([{ "type": "thinking", "signature": "sig-of-b" }]) });
    calling.account_routing = Some(AccountRouting { provider: PROVIDER.into(), account_id: ID_B.into(), session_account_id: None });
    let mut result = Message::new(Role::Tool, Content::Text("contents".into()));
    result.tool_call_id = Some("call-1".into());
    let mut request = (*request_with(None)).clone();
    request.messages = vec![Message::new(Role::User, Content::Text("q".into())), calling, result];

    drain(pool.attempt(Arc::new(request)).await.unwrap()).await;

    let sent = a.histories.lock().unwrap()[0].clone();
    let turn = &sent[1];
    assert_eq!((&turn.thinking_blocks, &turn.assistant_blocks, &turn.gemini_metadata), (&None, &None, &None));
    assert!(turn.provider_replay().is_empty());
    assert_eq!(turn.tool_calls.len(), 1, "the tool call stays");
    let owner_id = ProviderId::from(PROVIDER);
    let tools = std::collections::HashSet::from(["read".to_owned()]);
    let cx = crate::providers::anthropic::lowering::LowerContext { owner: &owner_id, own_provider: PROVIDER, available_tools: &tools };
    let wire: Vec<serde_json::Value> = crate::providers::anthropic::lowering::lower_messages(&sent, &cx).iter().map(|m| m.to_json()).collect();
    let text = serde_json::to_string(&wire).unwrap();
    assert!(!text.contains("sig-of-b") && !text.contains("\"thinking\""), "no thinking of B's on the wire: {text}");
    assert_eq!(wire[1]["content"][1], serde_json::json!({ "type": "tool_use", "id": "call-1", "name": "read", "input": { "path": "a" } }));
    assert_eq!(wire[2]["content"][0]["tool_use_id"], "call-1", "its result follows it");
}

/// A session written by Node 1.4.5, resumed after the upgrade in the middle of a tool loop: its answers are stamped with
/// the roster row that served them (`accountRouting: { provider, accountId, sessionAccountId }`) and its provider state
/// with that row (`providerAccountId`). Sent again on that row, nothing is stripped: the thinking blocks and replay of the
/// assistant turn whose tool result follows, a message older than the pool's stamps, and the state all reach the engine
/// as they were stored. Without a bound rotation and with one.
#[tokio::test]
async fn a_history_node_1_4_5_stamped_is_sent_whole_after_the_upgrade() {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Role;
    for bound in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (_, rotation) = roster(&dir).await;
        let a = engine("a", None);
        let pool = KeyPoolAdapter::with_engines(PROVIDER, engine("primary", None), engines(bound.then_some(rotation), &[(ID_A, &a)]));
        let thinking = serde_json::json!([{ "type": "thinking", "thinking": "plan", "signature": "sig-1" }]);
        let mut unstamped = Message::new(Role::Assistant, Content::Text("before the pool".into()));
        unstamped.thinking_blocks = Some(serde_json::json!([{ "type": "thinking", "thinking": "old", "signature": "sig-0" }]));
        let mut calling = Message::new(Role::Assistant, Content::Text(String::new()));
        calling.thinking_blocks = Some(thinking.clone());
        calling.push_replay(ProviderReplay { owner: ProviderId::from(PROVIDER), items: serde_json::json!(["replay-1"]) });
        calling.account_routing = Some(AccountRouting { provider: PROVIDER.into(), account_id: ID_A.into(), session_account_id: Some(ID_A.into()) });
        let mut result = Message::new(Role::Tool, Content::Text("tool output".into()));
        result.tool_call_id = Some("call-1".into());
        let state: ProviderState = serde_json::from_value(serde_json::json!({
            "openaiResponses": { "seenMessageCount": 3 },
            "providerAccountId": ID_A,
            "providerAccountProvider": PROVIDER,
        }))
        .unwrap();
        // Without routing, the row its replay names (`providerReplay.accountId`) owns it.
        let mut replayed_here = unstamped.clone();
        replayed_here.replay_account = Some(ID_A.into());
        let mut replayed_elsewhere = unstamped.clone();
        replayed_elsewhere.replay_account = Some(ID_B.into());
        let mut request = (*request_with(Some(state.clone()))).clone();
        request.messages = vec![Message::new(Role::User, Content::Text("q".into())), unstamped.clone(), calling.clone(), result, replayed_here, replayed_elsewhere];

        drain(pool.attempt(Arc::new(request)).await.unwrap()).await;

        let sent = a.histories.lock().unwrap()[0].clone();
        assert_eq!(sent[4].thinking_blocks, unstamped.thinking_blocks, "bound {bound}: the row its replay names is this one");
        assert_eq!(sent[5].thinking_blocks, None, "bound {bound}: another row's replay is not sent");
        assert_eq!(sent[1].thinking_blocks, unstamped.thinking_blocks, "bound {bound}: a message older than the stamps is the current row's");
        assert_eq!(sent[2].thinking_blocks, Some(thinking), "bound {bound}: the tool loop's thinking blocks stay");
        assert_eq!(sent[2].provider_replay(), calling.provider_replay(), "bound {bound}: and its replay");
        assert_eq!(slot_count(&a.seen.lock().unwrap()[0]), Some(3), "bound {bound}: the row is sent the state it produced");
    }
}

fn slot_count(state: &Option<ProviderState>) -> Option<u64> {
    state.as_ref()?.rest.get("openaiResponses")?.get("seenMessageCount")?.as_u64()
}

/// A credential that names no account lists the provider's models live with its own bearer (never the offline floor), on
/// the engine pinned to the current row rather than the provider's own, and its list is kept under that row: the next
/// listing is served from that file.
#[tokio::test]
async fn a_credential_that_names_no_account_lists_live_and_keeps_its_list_under_its_row() {
    let listing = |name: &'static str, live: &Arc<Live>| Arc::new(Engine { listing: Some(live.clone()), ..Arc::try_unwrap(engine(name, None)).ok().unwrap() });
    let (live, own) = (Arc::new(Live::default()), Arc::new(Live::default()));
    let (primary, a) = (listing("primary", &own), listing("a", &live));
    let pool: Arc<dyn ProviderAdapter> = Arc::new(KeyPoolAdapter::with_engines(PROVIDER, primary, engines(None, &[(ID_A, &a)])));
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let cache = crate::catalog::OauthModelCache::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let source = crate::catalog::ModelSource::of_adapter(ProviderId::from(PROVIDER), pool.clone()).unwrap().with_oauth_cache(cache);

    let shown = source.listing().await.unwrap();
    assert_eq!(shown.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["claude-live-model"], "the live list, not the floor");
    assert!(shown.stale.is_none());
    let identity = pool.models().unwrap().roster_identity().await;
    let key = crate::catalog::roster_key(&identity).expect("the row names the roster");
    assert!(dir.path().join(crate::catalog::Roster::Anthropic.keyed_file(&key)).exists(), "kept under the row");

    source.listing().await.unwrap();
    assert_eq!(live.fetches.load(std::sync::atomic::Ordering::SeqCst), 1, "the kept list answers the next listing");
    assert_eq!(own.fetches.load(std::sync::atomic::Ordering::SeqCst), 0, "the provider's own engine fetches nothing");
}

#[tokio::test]
async fn entering_a_loop_reaches_the_roster_provider_once() {
    let dir = tempfile::tempdir().unwrap();
    let (_, rotation) = roster(&dir).await;
    let primary = engine("primary", None);
    rotation.mark_probed(PROVIDER, ID_A);
    assert!(rotation.probe_paced(PROVIDER, ID_A));
    let pool = KeyPoolAdapter::with_engines(PROVIDER, primary.clone(), engines(Some(rotation.clone()), &[]));

    pool.begin_loop();

    assert_eq!(*primary.loops.lock().unwrap(), 1);
    assert!(!rotation.probe_paced(PROVIDER, ID_A), "a new loop measures again");
}
