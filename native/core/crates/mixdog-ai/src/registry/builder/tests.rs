use serde_json::json;

use super::*;
use crate::oauth::CredentialIo;
use crate::providers::google::traits::ThinkingControl;
use crate::providers::openai::config::NoFacts;
use crate::registry::keys::Environment;
use crate::registry::keys::MemoryVault;
use crate::registry::keys::ProcessEnv;
use crate::transport::KeepaliveDialer;
use crate::transport::KeepaliveSchedule;
use crate::transport::ReqwestLink;

struct Traits;

impl ModelTraits for Traits {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

async fn id_of(b: &DefaultProviderBuilder, name: &str, cfg: Value) -> String {
    b.build(name, &cfg).await.unwrap_or_else(|e| panic!("{name}: {e}")).id().to_string()
}

#[test]
fn account_plan_meters_ignore_endpoint_settings_that_do_not_change_transport() {
    let upper = json!({"baseURL":"https://gateway.example.invalid"});
    let lower = json!({"baseUrl":"https://gateway.example.invalid"});
    assert!(plan_meters_describe("anthropic-oauth", &upper));
    assert!(plan_meters_describe("anthropic-oauth", &lower));
    assert!(!plan_meters_describe("muse-code-oauth", &upper));
    assert!(plan_meters_describe("muse-code-oauth", &lower));
    assert!(!plan_meters_describe("devin-oauth", &lower));
    assert!(plan_meters_describe("devin-oauth", &upper));
}

/// `describeVertexAdc` against Node's (`fixtures/vertex-adc/golden.json`, `record-vertex-adc.mjs`):
/// the gcloud login the settings show, over ADC files and gcloud configuration seeded in a folder.
mod adc {
    use std::collections::HashMap;

    use mixdog_rt::LaneToken as _;
    use tokio_util::sync::CancellationToken;

    use super::*;

    struct MapEnv(HashMap<String, String>);

    impl Environment for MapEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// What the settings show of the gcloud login in a folder seeded with `files`, under `env`.
    async fn described(files: &[(&str, &str)], env: &[(&str, &str)], project_override: &str) -> (Value, String) {
        let dir = tempfile::tempdir().unwrap();
        for (relative, text) in files {
            let path = dir.path().join(relative);
            let bytes = text.as_bytes().to_vec();
            mixdog_rt::testing::tokens()
                .durability_io
                .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &bytes, &mixdog_statefile::Opts::default()))
                .unwrap()
                .await
                .unwrap()
                .unwrap();
        }
        let mut vars: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        vars.insert("CLOUDSDK_CONFIG".into(), dir.path().to_string_lossy().into_owned());
        let builder = builder_with(&dir, Arc::new(MapEnv(vars)));
        let value = builder.adc_describe(project_override, false).await;
        (value, dir.path().to_string_lossy().into_owned())
    }

    const LOGIN_FILE: &str = "application_default_credentials.json";
    const USER_LOGIN: &str =
        r#"{"type":"authorized_user","client_id":"id","client_secret":"secret","refresh_token":"refresh","quota_project_id":"quota-proj"}"#;

    #[tokio::test]
    async fn project_vertex_routes_use_the_selected_models_region_unless_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let env = MapEnv(HashMap::from([
            ("CLOUDSDK_CONFIG".into(), dir.path().to_string_lossy().into_owned()),
            ("GOOGLE_VERTEX_LOCATION".into(), "us-central1".into()),
            ("VERTEX_REGION_CLAUDE_4_6_SONNET".into(), "us-east5".into()),
        ]));
        let builder = builder_with(&dir, Arc::new(env));
        builder.metadata_project.set(Some("metadata-proj".into())).unwrap();
        let adc = json!({"authMode":"adc"});
        let service = json!({"authMode":"service-account","apiKey":json!({
            "client_email":"fixture@example.invalid","private_key":"not used by encode","project_id":"service-proj"
        }).to_string()});
        let check = |adapter: &dyn ProviderAdapter, project: &str, pin: Option<&str>| {
            for (model, region) in [("publishers/anthropic/models/claude-sonnet-4-6", "us-east5"), ("gemini-2.5-pro", "us-central1")] {
                let request = custom_turn(model, Default::default());
                let wire = adapter.codec().encode(&request).unwrap();
                let region = pin.unwrap_or(region);
                assert!(wire.url.contains(&format!("/projects/{project}/locations/{region}/")), "{model}: {}", wire.url);
            }
        };
        for pin in [None, Some("us-west1")] {
            let pinned = |mut cfg: Value| {
                if let Some(location) = pin {
                    cfg["location"] = json!(location);
                }
                cfg
            };
            check(builder.build("vertex-ai", &pinned(adc.clone())).await.unwrap().as_ref(), "metadata-proj", pin);
            check(builder.build("vertex-ai", &pinned(service.clone())).await.unwrap().as_ref(), "service-proj", pin);
        }
        let path = dir.path().join(LOGIN_FILE);
        mixdog_rt::testing::tokens()
            .durability_io
            .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, USER_LOGIN.as_bytes(), &mixdog_statefile::Opts::default()))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        check(builder.build("vertex-ai", &adc).await.unwrap().as_ref(), "quota-proj", None);
    }

    #[tokio::test]
    async fn without_a_gcloud_login_the_settings_say_so_and_name_the_command_to_run() {
        let (shown, _) = described(&[], &[], "").await;
        assert_eq!(shown["state"], "missing");
        assert_eq!(shown["message"], "No gcloud login found. Run `gcloud auth application-default login`.");
    }

    #[tokio::test]
    async fn a_login_is_shown_with_its_type_and_the_project_the_environment_the_file_or_the_override_names() {
        let (file_project, _) = described(&[(LOGIN_FILE, USER_LOGIN)], &[], "").await;
        assert_eq!((file_project["state"].clone(), file_project["type"].clone()), (json!("ready"), json!("authorized_user")));
        assert_eq!(file_project["projectId"], "quota-proj", "the file's quota project");
        let (from_env, _) = described(&[(LOGIN_FILE, USER_LOGIN)], &[("GOOGLE_CLOUD_PROJECT", "env-proj")], "").await;
        assert_eq!(from_env["projectId"], "env-proj", "the environment comes before the file");
        let (overridden, _) = described(&[(LOGIN_FILE, USER_LOGIN)], &[("GOOGLE_CLOUD_PROJECT", "env-proj")], "  chosen-proj ").await;
        assert_eq!(overridden["projectId"], "chosen-proj", "the settings' project comes before everything");
    }

    #[tokio::test]
    async fn the_description_never_carries_a_token_or_a_key() {
        let (shown, _) = described(&[(LOGIN_FILE, USER_LOGIN)], &[], "").await;
        let text = shown.to_string();
        for secret in ["secret", "refresh"] {
            assert!(!text.contains(secret), "{text}");
        }
    }

    #[tokio::test]
    async fn an_explicit_credentials_file_that_is_missing_is_reported_by_its_path() {
        let (shown, dir) = described(&[], &[("GOOGLE_APPLICATION_CREDENTIALS", "/nowhere/key.json")], "").await;
        assert_eq!(shown["state"], "invalid");
        let message = shown["message"].as_str().unwrap();
        assert!(message.starts_with("GOOGLE_APPLICATION_CREDENTIALS points to ") && message.ends_with("which does not exist."), "{message} ({dir})");
    }

    #[tokio::test]
    async fn a_file_that_is_not_json_and_a_credential_type_vertex_does_not_take_read_as_invalid_and_unsupported() {
        let (broken, _) = described(&[(LOGIN_FILE, "not json")], &[], "").await;
        assert_eq!(broken["state"], "invalid");
        assert!(broken["message"].as_str().unwrap().ends_with("is not valid JSON."));
        let (other, _) = described(&[(LOGIN_FILE, r#"{"type":"external_account"}"#)], &[], "").await;
        assert_eq!((other["state"].clone(), other["type"].clone()), (json!("unsupported"), json!("external_account")));
    }

    #[tokio::test]
    async fn an_impersonated_login_needs_a_valid_service_account_url() {
        let (shown, _) =
            described(&[(LOGIN_FILE, r#"{"type":"impersonated_service_account","service_account_impersonation_url":"https://x/y"}"#)], &[], "").await;
        assert_eq!(shown["state"], "invalid");
        assert!(shown["message"].as_str().unwrap().contains("have no valid service_account_impersonation_url"));
    }
}

/// `MIXDOG_OAI_TRANSPORT` reaches the adapter's WebSocket mode as `resolveOpenAiTransportPolicy` resolves it: `ws-full`
/// pins full frames (Node's `full_default`), `ws-delta` pins delta frames without the HTTP fallback.
#[test]
fn the_transport_setting_selects_the_websocket_mode() {
    let pick = |v: Option<&str>| openai_transport(v.map(str::to_owned));
    assert_eq!(pick(Some("WS_FULL")), (TransportKind::WebSocket, TransportMode::WsFull));
    assert_eq!(pick(Some(" ws delta ")), (TransportKind::WebSocket, TransportMode::WsDelta));
    assert_eq!(pick(Some("sse")).0, TransportKind::Http1);
    assert_eq!(pick(None), (TransportKind::WebSocket, TransportMode::Auto));
    assert_eq!(pick(Some("quantum")), (TransportKind::WebSocket, TransportMode::Auto));
}

/// Providers of one kind built through the registry as separate configurations would be (one store each), each over a
/// network of its own that answers every token exchange with the next tokens of its account.
mod account_keys {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    use super::*;
    use crate::oauth::carried;
    use crate::providers::listing_row::testing::Replay;

    struct Vars(Mutex<HashMap<String, String>>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.lock().unwrap().get(name).cloned()
        }
    }

    /// One configuration: its builder, the tokens its network issued, the variables it reads.
    struct Config {
        builder: DefaultProviderBuilder,
        issued: Arc<Mutex<Vec<String>>>,
        vars: Arc<Vars>,
        _dir: tempfile::TempDir,
    }

    /// A one-model `AvailableModelsResponse` so `list_models` settles on its first attempt instead of backing off.
    fn available_models_body() -> Vec<u8> {
        use crate::providers::connect::pb::Writer;
        let mut model = Writer::new();
        model.string(1, "auto");
        let mut response = Writer::new();
        response.message(2, model);
        response.bool_if(11, true);
        response.finish()
    }

    fn configuration(label: &'static str) -> Config {
        let issued = Arc::new(Mutex::new(Vec::new()));
        let record = issued.clone();
        let n = std::sync::atomic::AtomicU64::new(0);
        let models = available_models_body();
        let net: Arc<dyn HttpSend> = Arc::new(Replay::new(move |request| {
            if request.url.ends_with(crate::providers::cursor::AVAILABLE_MODELS_PATH) {
                return (200, models.clone());
            }
            if request.url != crate::providers::cursor::auth::EXCHANGE_URL {
                return (404, Vec::new());
            }
            let n = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let payload = URL_SAFE_NO_PAD.encode(format!("{{\"exp\":{}}}", 4_000_000_000u64 + n));
            let (access, refresh) = (format!("{label}-access-{n:04}.{payload}.s"), format!("{label}-refresh-{n:04}"));
            record.lock().unwrap().extend([access.clone(), refresh.clone()]);
            (200, format!(r#"{{"accessToken":"{access}","refreshToken":"{refresh}"}}"#).into_bytes())
        }));
        let dir = tempfile::tempdir().unwrap();
        let vars = Arc::new(Vars(Mutex::default()));
        let builder = builder_over(&dir, vars.clone(), Some(net), Arc::new(SessionContext::new()));
        Config { builder, issued, vars, _dir: dir }
    }

    impl Config {
        /// The user replaces the key in the configuration: the provider is rebuilt and lists its models, which exchanges.
        async fn exchange(&self, cfg: Value) {
            let adapter = self.builder.build("cursor-api", &cfg).await.unwrap();
            let _ = adapter.models().unwrap().list_models().await;
        }

        fn issued(&self) -> Vec<String> {
            self.issued.lock().unwrap().clone()
        }
    }

    fn retire_unrelated(tag: &str) {
        for i in 0..=carried::RETIRED_CAP {
            carried::keep("file the-unrelated-account-of-the-cursor-test.json", &[&format!("{tag}-unrelated-{i:05}")]);
        }
    }

    fn with_key(key: &str) -> Value {
        json!({"enabled": true, "apiKey": key})
    }

    fn with_variable(name: &str) -> Value {
        json!({"enabled": true, "apiKeyEnv": name})
    }

    /// Two configurations holding an explicit key and a third naming a variable: every one's tokens and keys stay redacted
    /// through the others' rotations and unrelated retirements past the cap.
    #[tokio::test]
    async fn other_configurations_keep_their_tokens_through_each_others_rotations() {
        carried::reset_registry();
        let (a, b, c) = (configuration("a"), configuration("b"), configuration("c"));
        a.exchange(with_key("explicit-key-of-a")).await;
        c.vars.0.lock().unwrap().insert("CURSOR_KEY_C".into(), "variable-key-of-c".into());
        c.exchange(with_variable("CURSOR_KEY_C")).await;
        for n in 0..3 {
            b.exchange(with_key(&format!("explicit-key-of-b-{n}"))).await;
        }
        retire_unrelated("cursor-accounts");
        let registry = carried::registry();
        for held in a.issued().iter().chain(&c.issued()).chain(&b.issued()[b.issued().len() - 2..]) {
            assert!(registry.holds(held), "a live token went unredacted: {held}");
        }
        assert!(registry.holds("explicit-key-of-a") && registry.holds("variable-key-of-c") && registry.holds("explicit-key-of-b-2"));
        assert!(!registry.holds(&b.issued()[0]) && !registry.holds("explicit-key-of-b-0"), "B's replaced credentials retired");
    }

    /// Ten rotations of each of two configurations' keys: each keeps its key and its pair of tokens pinned, the rest is
    /// retired within the caps.
    #[tokio::test]
    async fn ten_rotations_of_each_configuration_stay_within_the_caps() {
        carried::reset_registry();
        let (a, b) = (configuration("a"), configuration("b"));
        for n in 0..10 {
            a.exchange(with_key(&format!("ten-key-of-a-{n}"))).await;
            b.exchange(with_key(&format!("ten-key-of-b-{n}"))).await;
        }
        let counts = carried::registry().counts();
        assert_eq!(counts.held, 6, "each configuration pins its key and its access and refresh token");
        assert!(counts.retired <= carried::RETIRED_CAP && counts.carried <= carried::CARRIED_CAP);
    }
}

/// A keyless custom provider on `protocol` at a stand-in endpoint, not warmed, with `overrides` as its `modelOverrides`.
fn custom_config(protocol: &str, overrides: Value) -> Value {
    json!({
        "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": protocol, "baseURL": "https://shape.test/v1", "auth": "none", "preconnect": false,
        "modelOverrides": overrides,
    })
}

/// A one-message request of `model` with `options`.
fn custom_turn(model: &str, options: mixdog_core_api::domain::provider::RequestOptions) -> ModelRequest {
    use mixdog_core_api::domain::provider::{Content, Message, Role};
    ModelRequest { model: model.to_owned(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: Vec::new(), options }
}

#[tokio::test]
async fn custom_responses_retries_rejected_history_on_the_configured_wire_at_the_turn_effort() {
    use mixdog_core_api::domain::provider::{Content, EffortProjection, Message, RequestOptions, Role, StreamEvent};

    let dir = tempfile::tempdir().unwrap();
    let wire = Arc::new(crate::providers::listing_row::testing::Replay::new(|request| {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        if body["input"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "configuration_update")) {
            (400, br#"{"error":{"message":"Unsupported item type configuration_update"}}"#.to_vec())
        } else {
            (200, b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_ok\",\"status\":\"completed\",\"output\":[]}}\n\n".to_vec())
        }
    }));
    let b = builder_over(&dir, Arc::new(ProcessEnv), Some(wire.clone()), Arc::new(SessionContext::new()));
    let model = "gateway/gpt-6";
    let mut cfg = custom_config(
        "openai-chat",
        json!({
            "gateway/gpt-6": {"manual": true, "reasoning": {
                "levels": ["low", "medium", "high"], "wireValues": {"low":"lite","medium":"lite","high":"deep"}
            }}
        }),
    );
    cfg["wires"] = json!(["chat", "responses"]);
    cfg["modelWires"] = json!({"gateway/gpt-6":"responses"});
    let provider = b.build("custom-effort-history", &cfg).await.unwrap();
    let mut request = custom_turn(
        model,
        RequestOptions {
            effort: Some("high".into()),
            effort_projection: Some(EffortProjection { initial_effort: "low".into(), updates: [(1, "medium".into()), (2, "high".into())].into() }),
            ..RequestOptions::default()
        },
    );
    request.messages.push(Message::new(Role::User, Content::Text("keep going".into())));
    request.messages.push(Message::new(Role::User, Content::Text("next".into())));
    for _ in 0..2 {
        let mut stream = provider.attempt(Arc::new(request.clone())).await.unwrap();
        loop {
            let event = stream.next().await.expect("terminal event").unwrap();
            if matches!(event, StreamEvent::Completed { .. }) {
                break;
            }
        }
    }
    let sent = wire.requests.lock().unwrap();
    assert_eq!(sent.len(), 3, "one retry, and no history probe on the following turn");
    assert!(sent.iter().all(|request| request.url == "https://shape.test/v1/responses"));
    let bodies: Vec<Value> = sent.iter().map(|request| serde_json::from_slice(&request.body).unwrap()).collect();
    assert_eq!(bodies[0]["reasoning"]["effort"], "lite");
    let input = bodies[0]["input"].as_array().unwrap();
    assert_eq!(input.len(), 4, "the two efforts mapped to lite do not generate an update");
    assert_eq!(input[2], json!({"type":"configuration_update","reasoning":{"effort":"deep"}}));
    assert_eq!(input[3]["content"][0]["text"], "next");
    assert_eq!(bodies[1]["reasoning"]["effort"], "deep");
    assert_eq!(bodies[1]["input"], json!([&input[0], &input[1], &input[3]]));
    assert_eq!(bodies[2], bodies[1]);
}

fn builder(dir: &tempfile::TempDir) -> DefaultProviderBuilder {
    builder_with(dir, Arc::new(ProcessEnv))
}
fn builder_with(dir: &tempfile::TempDir, env: Arc<dyn Environment>) -> DefaultProviderBuilder {
    builder_over(dir, env, None, Arc::new(SessionContext::new()))
}
/// A builder whose requests go to `http` when given (else the real link), reading time off `context`.
fn builder_over(dir: &tempfile::TempDir, env: Arc<dyn Environment>, http: Option<Arc<dyn HttpSend>>, context: Arc<SessionContext>) -> DefaultProviderBuilder {
    let tokens = mixdog_rt::testing::tokens();
    let link = Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap());
    DefaultProviderBuilder::new(BuilderEnv {
        http: http.unwrap_or_else(|| link.clone()),
        bidi: link,
        dial: Arc::new(KeepaliveDialer::new(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false),
        accounts: AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(Traits),
        route_traits: Arc::new(|_| None),
        openai_facts: Arc::new(NoFacts),
        openai_context: context,
        codex_identity: CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() },
        pace: Arc::new(crate::oauth::pace::FakePace::default()),
        gzip_lane: tokens.cpu_bulk,
        client_version: "1.0.0".into(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "1.0.0".into(),
        listing: crate::catalog::ListingLookup::new(),
        env,
        home_dir: dir.path().to_path_buf(),
        io: CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        gated_off: Arc::new(|name| name == "gated"),
        local: None,
    })
}
#[tokio::test]
async fn each_family_builds_under_its_own_id() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    for name in ["anthropic", "openai", "gemini", "xai", "deepseek", "openrouter", "cursor-api"] {
        assert_eq!(id_of(&b, name, json!({"enabled": true, "apiKey": "k"})).await, name);
    }
    let custom = json!({"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/",
        "apiKey": "k", "headers": {"X-A": "1"}, "requestBody": {"top_k": 5}});
    assert_eq!(id_of(&b, "custom-abc", custom).await, "custom-abc");
}

#[tokio::test]
async fn public_openai_store_respects_either_opt_out_without_affecting_oauth() {
    struct StoreEnv(Option<&'static str>);
    impl Environment for StoreEnv {
        fn var(&self, name: &str) -> Option<String> {
            match name {
                "MIXDOG_OAI_STORE" => self.0.map(str::to_owned),
                "MIXDOG_OAI_TRANSPORT" => Some("http-sse".into()),
                _ => None,
            }
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let request = custom_turn("gpt-5.2", Default::default());
    for (env, provider, config, expected) in [
        (None, "openai", json!({}), true),
        (Some("0"), "openai", json!({}), false),
        (Some("0"), "openai", json!({"store": true}), false),
        (Some("1"), "openai", json!({"store": false}), false),
        (Some("1"), "openai-oauth", json!({"store": true}), false),
    ] {
        let adapter = builder_with(&dir, Arc::new(StoreEnv(env))).build(provider, &config).await.unwrap();
        let wire = adapter.codec().encode(&request).unwrap();
        let body: Value = serde_json::from_slice(&wire.body).unwrap();
        assert_eq!(body["store"], expected, "{provider} with environment {env:?} and config {config}");
    }
}

#[tokio::test]
async fn mimo_region_discovery_errors_only_when_mimo_is_used() {
    use crate::transport::{Exchange, HttpResponse};
    use mixdog_core_api::domain::provider::WireRequest;

    struct NoNetwork(std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl HttpSend for NoNetwork {
        async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }
    struct EmptyEnv;
    impl Environment for EmptyEnv {
        fn var(&self, _: &str) -> Option<String> {
            None
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let network = Arc::new(NoNetwork(std::sync::atomic::AtomicUsize::new(0)));
    let builder = Arc::new(builder_over(&dir, Arc::new(EmptyEnv), Some(network.clone()), Arc::new(SessionContext::new())));
    builder.env.accounts.credential_file("mimo-oauth", "default").unwrap().save(&json!({"apiKey":"tp-fixture","uid":"fixture"})).await.unwrap();
    let registry = super::super::providers::ProviderRegistry::new(builder);
    let config = json!({"mimo-oauth":{"enabled":true},"openai":{"enabled":true}});
    registry.init_providers(config.as_object().unwrap()).await.unwrap();
    assert!(registry.registered("openai").is_some());
    assert_eq!(network.0.load(std::sync::atomic::Ordering::Relaxed), 0);
    let request = Arc::new(custom_turn("mimo-v2.6-pro", Default::default()));
    let error = registry.registered("mimo-oauth").unwrap().attempt(request).await.err().expect("that send fails discovery");
    assert_eq!((error.kind, error.delivery), (ErrorKind::Transient, DeliveryState::NotSent));
    assert!(network.0.load(std::sync::atomic::Ordering::Relaxed) > 0);
}

#[tokio::test]
async fn anthropic_subscription_messages_never_use_the_api_key_destination() {
    use crate::transport::{Exchange, HttpResponse, Redirect};
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, RequestOptions, WireRequest};

    struct EmptyEnv;
    impl Environment for EmptyEnv {
        fn var(&self, _: &str) -> Option<String> {
            None
        }
    }

    #[derive(Default)]
    struct Network(std::sync::Mutex<Vec<(WireRequest, Redirect)>>);
    #[async_trait]
    impl HttpSend for Network {
        async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
            if request.method == "POST" {
                self.0.lock().unwrap().push((request, exchange.redirect));
            }
            Err(ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let network = Arc::new(Network::default());
    let builder = builder_over(&dir, Arc::new(EmptyEnv), Some(network.clone()), Arc::new(SessionContext::new()));
    let file = builder.file("anthropic-oauth").unwrap();
    file.save(&json!({"claudeAiOauth": {
        "accessToken": "fixture-subscription-token", "refreshToken": "fixture-refresh", "expiresAt": 4_000_000_000_000u64
    }}))
    .await
    .unwrap();
    let config = json!({"enabled": true, "baseURL": "https://gateway.example/custom/", "apiKey": "fixture-api-key"});
    let request = Arc::new(custom_turn("claude-sonnet-4-6", RequestOptions::default()));
    for provider in ["anthropic", "anthropic-oauth"] {
        let built = builder.build(provider, &config).await.unwrap();
        let _ = built.attempt(request.clone()).await;
    }

    let session = Arc::new(OAuthSession::new(file, network.clone()));
    for base in ["https://gateway.example/custom", "https://api.anthropic.com/not-messages"] {
        let mut config = AnthropicConfig::new(Arc::new(|_| None));
        config.base_url = base.into();
        let oauth = AnthropicAdapter::oauth(config, network.clone(), session.clone(), false, builder.env.gzip_lane);
        let error = oauth.attempt(request.clone()).await.err().expect("the destination is refused");
        assert_eq!((error.kind, error.delivery), (ErrorKind::InvalidRequest, DeliveryState::NotSent));
    }

    let writes = network.0.lock().unwrap();
    assert_eq!(writes.len(), 2, "only the correctly routed requests reached transport");
    let header = |wire: &WireRequest, name: &str| wire.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.clone());
    let (api, api_redirect) = &writes[0];
    assert_eq!(api.url, "https://gateway.example/custom/v1/messages");
    assert_eq!(header(api, "x-api-key").as_deref(), Some("fixture-api-key"));
    assert_eq!(header(api, "authorization"), None);
    assert_eq!(*api_redirect, Redirect::Follow);

    let (oauth, oauth_redirect) = &writes[1];
    assert_eq!(oauth.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(header(oauth, "authorization").as_deref(), Some("Bearer fixture-subscription-token"));
    assert_eq!(header(oauth, "x-api-key"), None);
    assert_eq!(*oauth_redirect, Redirect::Error);
    for wire in [api, oauth] {
        assert_eq!(wire.transport, TransportKind::Http1);
        let body: Value = serde_json::from_slice(&wire.body).unwrap();
        assert_eq!(body["messages"][0]["content"][0]["text"], "hi");
    }
}

/// `createCustomProvider` registers a wire profile for every OpenAI-compatible protocol, so a one-wire provider
/// routes (and pins) its wire. The route is the one the real-turn harness recorded in Node's stored header
/// (`out/read/compare/stored-header.node.json` `wireRoute`: `custom-harness:chat`, source `default`); the
/// anthropic protocol has no profile and no `resolveWireRoute`.
#[tokio::test]
async fn a_one_wire_custom_provider_routes_its_wire_like_node() {
    use mixdog_core_api::domain::provider::WireRouteContext;
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    let context = WireRouteContext { agent: true, ..WireRouteContext::default() };
    let chat = b
        .build(
            "custom-harness",
            &json!({"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/", "apiKey": "k"}),
        )
        .await
        .unwrap();
    let route = chat.wire_routing().expect("an OpenAI-compatible custom provider routes").resolve_wire_route("harness-model", &context).await.unwrap().unwrap();
    assert_eq!((route.wire.as_str(), route.source.as_str(), route.profile_id.as_str()), ("chat", "default", "custom-harness:chat"));
    let responses = b.build("custom-r", &json!({"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-responses", "baseURL": "http://localhost:1/v1/", "apiKey": "k"})).await.unwrap();
    let route = responses.wire_routing().expect("routes").resolve_wire_route("m", &context).await.unwrap().unwrap();
    assert_eq!((route.wire.as_str(), route.profile_id.as_str()), ("responses", "custom-r:responses"));
    let anthropic = b
        .build(
            "custom-a",
            &json!({"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "anthropic", "baseURL": "http://localhost:1", "apiKey": "k"}),
        )
        .await
        .unwrap();
    assert!(anthropic.wire_routing().is_none());
}
/// `createCustomProvider` reads an unversioned entry through `normalizeCustomProviderConfig` (`migrateLegacy`): its `models`
/// are manual rows with their name, window and output ceiling, as the same entry saved as schema 2 states them.
#[tokio::test]
async fn a_legacy_custom_entrys_models_are_its_manual_rows() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    let legacy = json!({"type": "custom", "name": "Legacy", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1", "apiKey": "k",
        "models": [{"id": "smoke", "name": "Smoke Legacy", "contextWindow": 30000, "maxOutputTokens": 1234}]});
    let parts = b.build_custom_parts("custom-legacy", &legacy).unwrap();
    let rows = parts.listing.cached_rows();
    let row = rows.iter().find(|row| row.id == "smoke").expect("the legacy model is a row");
    assert_eq!(
        (row.name.as_deref(), row.context_window, row.max_output_tokens, row.manual, row.hidden),
        (Some("Smoke Legacy"), Some(30_000), Some(1_234), true, false)
    );
}
/// `createCustomProvider` throws what `normalizeCustomProviderConfig` throws: a nameless entry, a v2 entry with a field the normalizer
/// does not know and a legacy entry with v2 fields are not built; `instantiateProvider` strips `customKeyIds` before the constructor.
#[tokio::test]
async fn a_custom_entry_the_normalizer_refuses_is_not_built() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    let v2 = json!({"type": "custom", "schemaVersion": 2, "name": "N", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1", "apiKey": "k"});
    let err = |cfg: Value| b.build_custom_parts("custom-x", &cfg).err();
    let mut nameless = v2.clone();
    nameless.as_object_mut().unwrap().remove("name");
    assert_eq!(err(nameless).as_deref(), Some("[custom-provider] name is required"));
    let mut unknown = v2.clone();
    unknown["surprise"] = json!(1);
    assert!(err(unknown).is_some());
    let mut legacy_headers = v2.clone();
    legacy_headers.as_object_mut().unwrap().remove("schemaVersion");
    legacy_headers["headers"] = json!({"X-A": "1"});
    assert_eq!(err(legacy_headers).as_deref(), Some("[custom-provider] headers require schemaVersion 2"));
    let mut with_ids = v2;
    with_ids["customKeyIds"] = json!(["k1"]);
    assert!(err(with_ids).is_none());
}
#[tokio::test]
async fn a_name_without_an_adapter_says_why() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    let err = |name: &str, cfg: Value| {
        let b = &b;
        let name = name.to_owned();
        async move { b.build(&name, &cfg).await.err().unwrap() }
    };
    assert_eq!(err("nope", json!({})).await, "unknown enabled provider: nope");
    assert_eq!(err("mixdog-local", json!({})).await, "mixdog-local needs the managed local runtime, which this host does not have");
    let wires = |protocol: &str, extra: Value| {
        let mut cfg = json!({"type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": protocol, "baseURL": "https://x/v1"});
        cfg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        cfg
    };
    let bad = err("custom-1", wires("anthropic", json!({"wires": ["messages"]}))).await;
    assert_eq!(bad, "[custom-provider] wires requires an 'openai-chat' or 'openai-responses' protocol");
    assert_eq!(err("custom-1", wires("openai-chat", json!({"wires": ["responses"]}))).await, "[custom-provider] wires must include the protocol wire: chat");
    assert_eq!(
        err("custom-1", wires("openai-chat", json!({"wires": ["chat", "messages"], "modelWires": {"m": "responses"}}))).await,
        "[custom-provider] modelWires[m] must be one of the served wires: chat, messages"
    );
    // The anthropic protocol and a multi-wire endpoint both build.
    let ok = |cfg: Value| {
        let b = &b;
        async move { b.build("custom-1", &cfg).await.is_ok() }
    };
    assert!(ok(wires("anthropic", json!({}))).await);
    assert!(ok(wires("openai-chat", json!({"wires": ["messages", "chat"], "modelWires": {"c": "messages"}}))).await);
    assert!(!b.available("gated") && b.available("openai"));
    assert!(!b.oauth_credentials_usable("openai-oauth").await.unwrap());
}

/// A credential file holding two tokens (Muse's `apiKey` and `accessToken`) keeps both redacted: values other sources retire
/// afterwards evict neither.
#[tokio::test]
#[allow(clippy::disallowed_methods, reason = "the fixture file is written directly")]
async fn a_file_key_registers_every_token_its_file_holds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("muse.json");
    std::fs::write(&path, r#"{"apiKey":"two-token-api-key-71c9e0","accessToken":"two-token-access-4d82fa"}"#).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(path, CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let key = FileKey { file, provider: "muse-code-oauth" };
    assert_eq!(key.read().await.unwrap(), "two-token-api-key-71c9e0");
    for i in 0..=crate::oauth::carried::RETIRED_CAP {
        crate::oauth::carried::keep("file the-unrelated-account-of-the-file-key-test.json", &[&format!("file-key-test-unrelated-{i:05}")]);
    }
    let registry = crate::oauth::carried::registry();
    assert!(registry.holds("two-token-api-key-71c9e0") && registry.holds("two-token-access-4d82fa"));
}

/// `xaiServerToolSearchEnabled` (`openai-compat-xai-send.mjs`): `provider.config?.xaiServerToolSearch === true` and nothing else
/// turns the server's tool search on. On, the xAI Responses body declares one `tool_search` tool and marks the deferred tools
/// (`toResponsesTools(.., { serverToolSearch: true })`); unset or anything but `true`, every tool is a plain function.
#[tokio::test]
async fn the_xai_server_tool_search_is_the_providers_own_opt_in() {
    use mixdog_core_api::domain::provider::{ModelRequest, RequestOptions, ToolDefinition};
    let dir = tempfile::tempdir().unwrap();
    // The network keeps each request's body and refuses it: the request as it leaves is all that is read.
    let sent = Arc::new(std::sync::Mutex::new(Vec::<(String, Vec<u8>)>::new()));
    let record = sent.clone();
    let net: Arc<dyn HttpSend> = Arc::new(crate::providers::listing_row::testing::Replay::new(move |request| {
        record.lock().unwrap().push((request.url.clone(), request.body.clone()));
        (400, b"{}".to_vec())
    }));
    let b = builder_over(&dir, Arc::new(ProcessEnv), Some(net), Arc::new(SessionContext::new()));
    let tool = |name: &str, defer_loading: bool| ToolDefinition {
        name: name.to_owned(),
        description: name.to_owned(),
        input_schema: json!({"type": "object", "properties": {}}),
        defer_loading,
        freeform: None,
    };
    let request = Arc::new(ModelRequest {
        model: "grok-4".to_owned(),
        messages: Vec::new(),
        tools: vec![tool("read", false), tool("load_tool", false), tool("mcp__a__b", true)],
        options: RequestOptions::default(),
    });
    let kinds = |cfg: Value| {
        let (b, request, sent) = (&b, request.clone(), sent.clone());
        async move {
            let adapter = b.build("xai", &cfg).await.unwrap();
            sent.lock().unwrap().clear();
            let _ = adapter.attempt(request).await;
            let sent = sent.lock().unwrap();
            let (url, body) = sent.first().expect("the request left");
            assert!(url.ends_with("/v1/responses"), "{url}");
            let body: Value = serde_json::from_slice(body).unwrap();
            body["tools"].as_array().unwrap().iter().map(|t| (t["type"].as_str().unwrap().to_owned(), t.get("defer_loading").is_some())).collect::<Vec<_>>()
        }
    };
    let function = |deferred: bool| ("function".to_owned(), deferred);
    let plain = vec![function(false), function(false), function(false)];
    assert_eq!(kinds(json!({"enabled": true, "apiKey": "k"})).await, plain);
    assert_eq!(kinds(json!({"enabled": true, "apiKey": "k", "xaiServerToolSearch": "true"})).await, plain, "only the boolean opts in");
    assert_eq!(kinds(json!({"enabled": true, "apiKey": "k", "xaiServerToolSearch": false})).await, plain);
    assert_eq!(
        kinds(json!({"enabled": true, "apiKey": "k", "xaiServerToolSearch": true})).await,
        vec![function(false), ("tool_search".to_owned(), false), function(true)]
    );
    assert!(xai_server_tool_search(&json!({"xaiServerToolSearch": true})));
    assert!(!xai_server_tool_search(&json!({})) && !xai_server_tool_search(&json!({"xaiServerToolSearch": 1})));
}
/// The request a custom provider built from `cfg` sent for `request`, over a network that refuses it: its header names
/// lower-cased and its body parsed.
async fn custom_request(cfg: &Value, request: ModelRequest) -> (HashMap<String, String>, Value) {
    let dir = tempfile::tempdir().unwrap();
    let replay = Arc::new(crate::providers::listing_row::testing::Replay::new(|_| {
        (400, br#"{"error":{"message":"scripted refusal","type":"invalid_request_error"}}"#.to_vec())
    }));
    let b = builder_over(&dir, Arc::new(ProcessEnv), Some(replay.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
    let provider = b.build("custom-shape", cfg).await.unwrap_or_else(|e| panic!("{e}"));
    let _ = provider.attempt(Arc::new(request)).await;
    let requests = replay.requests.lock().unwrap();
    let sent = requests.iter().find(|r| r.method == "POST").expect("the request left");
    let headers = sent.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect();
    (headers, serde_json::from_slice(&sent.body).unwrap())
}
/// A model's own `requestHeaders` (the key `modelOverrides[id]` stores them under) ride every request of that model on
/// each protocol's wire, over the provider's headers of the same name, and no other model's (`customRequestHeaders`).
#[tokio::test]
async fn a_custom_models_request_headers_ride_its_requests_only() {
    for protocol in ["openai-chat", "openai-responses", "anthropic"] {
        let mut cfg = custom_config(
            protocol,
            json!({
                "smoke": {"manual": true, "requestHeaders": {"X-Model": "smoke", "X-Team": "model"}},
                "plain": {"manual": true},
            }),
        );
        cfg["headers"] = json!({"X-Team": "provider"});
        let (headers, _) = custom_request(&cfg, custom_turn("smoke", Default::default())).await;
        let sent = |name: &str| headers.get(name).cloned();
        assert_eq!((sent("x-model"), sent("x-team")), (Some("smoke".to_owned()), Some("model".to_owned())), "{protocol}");
        let (headers, _) = custom_request(&cfg, custom_turn("plain", Default::default())).await;
        let sent = |name: &str| headers.get(name).cloned();
        assert_eq!((sent("x-model"), sent("x-team")), (None, Some("provider".to_owned())), "{protocol}");
    }
}
/// The turn's effort reaches a custom provider's request on each wire as the model's own row says
/// (`resolveCustomReasoning`): snapped onto the row's levels and spelled by its `wireValues`, as the Chat wire's
/// `reasoning_effort`, the Responses wire's `reasoning.effort`, and on the Messages wire as adaptive `thinking` with
/// `output_config.effort` and the effort beta in place of the engine's own (`none` turns thinking off, which keeps a
/// forced tool choice). A model whose row declares no levels gets no reasoning field.
#[tokio::test]
async fn a_custom_request_carries_its_model_rows_reasoning_at_the_turns_effort() {
    use mixdog_core_api::domain::provider::{RequestOptions, ToolDefinition};
    let overrides = json!({
        "smoke": {"manual": true, "reasoning": {"levels": ["none", "low", "medium", "high"], "wireValues": {"high": "HIGH-WIRE"}}},
        "plain": {"manual": true},
    });
    let at = |effort: &str| RequestOptions { effort: Some(effort.to_owned()), ..RequestOptions::default() };

    let chat = custom_config("openai-chat", overrides.clone());
    let (_, body) = custom_request(&chat, custom_turn("smoke", at("xhigh"))).await;
    assert_eq!(body["reasoning_effort"], "HIGH-WIRE", "xhigh snaps to the row's high, sent as its wire value");
    let (_, body) = custom_request(&chat, custom_turn("smoke", at("low"))).await;
    assert_eq!(body["reasoning_effort"], "low");
    let (_, body) = custom_request(&chat, custom_turn("plain", at("high"))).await;
    assert!(body.get("reasoning_effort").is_none(), "{body}");

    let responses = custom_config("openai-responses", overrides.clone());
    let (_, body) = custom_request(&responses, custom_turn("smoke", at("medium"))).await;
    assert_eq!(body["reasoning"], json!({"effort": "medium"}));
    let (_, body) = custom_request(&responses, custom_turn("plain", at("medium"))).await;
    assert!(body.get("reasoning").is_none(), "{body}");

    let anthropic = custom_config("anthropic", overrides);
    let effort_beta =
        |headers: &HashMap<String, String>| headers.get("anthropic-beta").is_some_and(|betas| betas.split(',').any(|name| name == "effort-2025-11-24"));
    let forced = |effort: &str| {
        let mut request = custom_turn("smoke", RequestOptions { tool_choice: Some("lookup".to_owned()), ..at(effort) });
        request.tools = vec![ToolDefinition {
            name: "lookup".to_owned(),
            description: "lookup".to_owned(),
            input_schema: json!({"type": "object", "properties": {}}),
            defer_loading: false,
            freeform: None,
        }];
        request
    };
    let (headers, body) = custom_request(&anthropic, forced("high")).await;
    assert_eq!((&body["thinking"], &body["output_config"]), (&json!({"type": "adaptive"}), &json!({"effort": "HIGH-WIRE"})));
    let place = |key: &str| body.as_object().unwrap().keys().position(|k| k == key);
    assert!(place("thinking") < place("output_config"), "the custom branch places thinking first: {body}");
    assert!(effort_beta(&headers), "{headers:?}");
    assert!(body.get("tool_choice").is_none(), "a forced tool choice is dropped while thinking is on: {body}");
    let (headers, body) = custom_request(&anthropic, forced("none")).await;
    assert_eq!(body["thinking"], json!({"type": "disabled"}));
    assert!(body.get("output_config").is_none() && !effort_beta(&headers), "{body}");
    assert_eq!(body["tool_choice"], json!({"type": "tool", "name": "lookup"}), "thinking off keeps the forced choice");
    let (headers, body) = custom_request(&anthropic, custom_turn("plain", at("high"))).await;
    assert!(body.get("thinking").is_none() && body.get("output_config").is_none() && !effort_beta(&headers), "{body}");
}
/// A custom provider's Responses request carries the session as its `prompt_cache_key` and as the `session-id` /
/// `x-client-request-id` headers, under a header of the same name the provider or the model sets itself; a one-shot
/// role's shared scope keys on the request's own key first; a request with neither carries none, and the Chat wire none
/// at all (`customSessionCacheKey`, `customSessionHeaders`; `openai-compat-responses-boundaries.test.mjs`).
#[tokio::test]
async fn a_custom_responses_request_carries_its_session_as_cache_key_and_headers() {
    use mixdog_core_api::domain::provider::RequestOptions;
    let some = |text: &str| Some(text.to_owned());
    let session = |id: &str| RequestOptions { session_id: Some(id.to_owned()), ..RequestOptions::default() };
    let identity = |headers: &HashMap<String, String>| (headers.get("session-id").cloned(), headers.get("x-client-request-id").cloned());
    let overrides = json!({
        "plain": {"manual": true},
        "own": {"manual": true, "requestHeaders": {"X-Client-Request-ID": "model-request"}},
    });

    let responses = custom_config("openai-responses", overrides.clone());
    let (headers, body) = custom_request(&responses, custom_turn("plain", session("sess-shape-1"))).await;
    assert_eq!(body["prompt_cache_key"], "sess-shape-1");
    assert_eq!(identity(&headers), (some("sess-shape-1"), some("sess-shape-1")));
    let shared = RequestOptions { prompt_cache_key: some("role-key"), prompt_cache_scope: some("shared"), ..session("sess-shape-1") };
    let (headers, body) = custom_request(&responses, custom_turn("plain", shared)).await;
    assert_eq!(body["prompt_cache_key"], "role-key");
    assert_eq!(identity(&headers), (some("role-key"), some("role-key")));
    let (headers, body) = custom_request(&responses, custom_turn("plain", RequestOptions::default())).await;
    assert!(body.get("prompt_cache_key").is_none() && identity(&headers) == (None, None), "{body}");

    let mut own = responses;
    own["headers"] = json!({"Session-ID": "provider-session"});
    let (headers, body) = custom_request(&own, custom_turn("own", session("sess-shape-1"))).await;
    assert_eq!(body["prompt_cache_key"], "sess-shape-1");
    assert_eq!(identity(&headers), (some("provider-session"), some("model-request")));

    let chat = custom_config("openai-chat", overrides);
    let (headers, body) = custom_request(&chat, custom_turn("plain", session("sess-shape-1"))).await;
    assert!(body.get("prompt_cache_key").is_none() && identity(&headers) == (None, None), "{body}");
}
/// A custom provider's own body fields sit where Node's request builders put them: on the Chat and Messages wires
/// before the stream flags the app sets last (`params.stream` follows `applyCustomRequestBody` in
/// `openai-compat-chat-send.mjs` and `buildAnthropicApiRequest`), on the Responses wire after everything the app builds
/// (`buildCompatResponsesParams`: the reasoning, the session's cache key, then the provider's and the model's
/// `requestBody`).
#[tokio::test]
async fn a_custom_requests_own_fields_sit_where_node_puts_them() {
    use mixdog_core_api::domain::provider::RequestOptions;
    let overrides = json!({
        "smoke": {"manual": true, "reasoning": {"levels": ["none", "low", "medium", "high"]}, "requestBody": {"top_p": 0.5}},
    });
    let options = RequestOptions { effort: Some("high".to_owned()), session_id: Some("sess-order".to_owned()), ..RequestOptions::default() };
    let last = |body: &Value, n: usize| {
        let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        keys[keys.len().saturating_sub(n)..].iter().map(|k| (*k).to_owned()).collect::<Vec<_>>()
    };
    let config = |protocol: &str| {
        let mut cfg = custom_config(protocol, overrides.clone());
        cfg["requestBody"] = json!({"top_k": 7});
        cfg
    };

    let (_, body) = custom_request(&config("openai-chat"), custom_turn("smoke", options.clone())).await;
    assert_eq!(last(&body, 5), ["reasoning_effort", "top_k", "top_p", "stream", "stream_options"], "{body}");
    let (_, body) = custom_request(&config("anthropic"), custom_turn("smoke", options.clone())).await;
    assert_eq!(last(&body, 5), ["thinking", "output_config", "top_k", "top_p", "stream"], "{body}");
    let (_, body) = custom_request(&config("openai-responses"), custom_turn("smoke", options)).await;
    assert_eq!(last(&body, 4), ["reasoning", "prompt_cache_key", "top_k", "top_p"], "{body}");
}
/// A custom Responses request's `reasoning` is the row's (`resolveReasoning`), placed where `buildCompatResponsesParams` puts it:
/// ahead of the session's cache key.
#[tokio::test]
async fn a_custom_responses_requests_reasoning_is_the_rows_ahead_of_the_cache_key() {
    use mixdog_core_api::domain::provider::RequestOptions;
    let overrides = json!({"smoke": {"manual": true, "reasoning": {"levels": ["none", "low", "medium", "high"]}}});
    let config = custom_config("openai-responses", overrides);
    let keyed = RequestOptions { effort: Some("high".to_owned()), session_id: Some("s".to_owned()), ..RequestOptions::default() };
    let (_, body) = custom_request(&config, custom_turn("smoke", keyed)).await;
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    let at = |name: &str| keys.iter().position(|k| *k == name).unwrap();
    assert!(at("reasoning") < at("prompt_cache_key"), "{body}");
}
/// On the Messages wire the request's own `anthropic-beta` (here the effort beta) is a per-request header over the
/// provider's default headers and the model's; a request that names no beta sends the model's, else the provider's
/// (`requestHeadersFor`, `customRequestHeaders`, the SDK's `defaultHeaders` under a request's headers).
#[tokio::test]
async fn a_custom_messages_requests_own_betas_win_over_configured_ones() {
    use mixdog_core_api::domain::provider::RequestOptions;
    let mut cfg = custom_config(
        "anthropic",
        json!({
            "smoke": {"manual": true, "reasoning": {"levels": ["low", "high"]}, "requestHeaders": {"Anthropic-Beta": "model-beta"}},
            "plain": {"manual": true},
        }),
    );
    cfg["headers"] = json!({"anthropic-beta": "provider-beta"});
    let at = |effort: Option<&str>| RequestOptions { effort: effort.map(str::to_owned), ..RequestOptions::default() };
    let beta = |headers: &HashMap<String, String>| headers.get("anthropic-beta").cloned();
    let (headers, _) = custom_request(&cfg, custom_turn("smoke", at(Some("high")))).await;
    assert_eq!(beta(&headers).as_deref(), Some("effort-2025-11-24"), "{headers:?}");
    let (headers, _) = custom_request(&cfg, custom_turn("smoke", at(None))).await;
    assert_eq!(beta(&headers).as_deref(), Some("model-beta"), "{headers:?}");
    let (headers, _) = custom_request(&cfg, custom_turn("plain", at(Some("high")))).await;
    assert_eq!(beta(&headers).as_deref(), Some("provider-beta"), "{headers:?}");
}

/// The account whose credential a request puts on the wire is the account its continuation state was chosen for and the
/// account the state it leaves is stamped with, through the adapter the builder registers.
mod pinned_credentials {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use bytes::Bytes;
    use mixdog_core_api::domain::provider::AccountRouting;
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::ModelRequest;
    use mixdog_core_api::domain::provider::ProviderReplay;
    use mixdog_core_api::domain::provider::ProviderState;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireRequest;

    use super::*;
    use crate::accounts::AccountChange;
    use crate::accounts::rotation::AccountRotation;
    use crate::transport::Exchange;
    use crate::transport::HttpResponse;
    use crate::transport::testing::Once;

    const OPENAI: &str = "openai-oauth";
    const ID_A: &str = "11111111-1111-4111-8111-111111111111";
    const ID_B: &str = "22222222-2222-4222-8222-222222222222";
    const MODEL: &str = "gpt-5.2";

    struct Vars(HashMap<String, String>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// One request as it left: its URL, its `authorization` header and its body.
    #[derive(Clone, Debug)]
    struct Sent {
        url: String,
        authorization: String,
        body: String,
    }

    /// The provider's endpoint. The model request at `refuse_at` moves the roster's selection from A to B and is refused
    /// with a 401 (the moment a send re-reads its credential); every other one answers, its encrypted reasoning naming
    /// the credential it was sent with. A token refresh renews the refresh token it was sent, for the same account.
    struct Endpoint {
        store: AccountStore,
        refuse_at: Option<usize>,
        sent: Mutex<Vec<Sent>>,
    }

    impl Endpoint {
        fn model_requests(&self) -> Vec<Sent> {
            self.sent.lock().unwrap().iter().filter(|s| s.url.ends_with("/responses")).cloned().collect()
        }
    }

    fn answered(status: u16, body: String) -> HttpResponse {
        HttpResponse { status, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(Once(Some(Bytes::from(body)))) }
    }

    /// A completed Responses stream whose reasoning item's encrypted content is `encrypted`.
    fn completed(encrypted: &str) -> String {
        let reasoning = json!({"type": "reasoning", "id": "rs_1", "encrypted_content": encrypted, "summary": []});
        let message = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "ok", "annotations": []}]});
        let frames = [
            json!({"type": "response.created", "response": {"id": "resp_1", "status": "in_progress"}}),
            json!({"type": "response.output_item.done", "output_index": 0, "item": reasoning}),
            json!({"type": "response.output_item.done", "output_index": 1, "item": message}),
            json!({"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "output": [reasoning, message], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}}),
        ];
        frames.iter().map(|frame| format!("data: {frame}\n\n")).collect()
    }

    #[async_trait]
    impl HttpSend for Endpoint {
        async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
            let authorization = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.clone()).unwrap_or_default();
            let body = String::from_utf8_lossy(&request.body).into_owned();
            self.sent.lock().unwrap().push(Sent { url: request.url.clone(), authorization: authorization.clone(), body: body.clone() });
            if request.url == crate::providers::openai::oauth::TOKEN_URL {
                let spent = url::form_urlencoded::parse(body.as_bytes()).find(|(k, _)| k == "refresh_token").map(|(_, v)| v.into_owned()).unwrap_or_default();
                let mut login = spent.splitn(3, '.').skip(1);
                let (account, tag) = (login.next().unwrap_or_default(), login.next().unwrap_or_default());
                let renewed = json!({"access_token": token(account, &format!("{tag}-renewed")), "refresh_token": refresh(account, &format!("{tag}-next")), "expires_in": 3600});
                return Ok(answered(200, renewed.to_string()));
            }
            if !request.url.ends_with("/responses") {
                return Ok(answered(200, r#"{"data":[]}"#.to_owned()));
            }
            if self.refuse_at == Some(self.model_requests().len() - 1) {
                self.store.change(OPENAI, AccountChange { selected_id: Some(ID_B.into()), ..Default::default() }).await.unwrap();
                return Ok(answered(401, r#"{"error":{"message":"token expired","type":"invalid_request_error"}}"#.to_owned()));
            }
            Ok(answered(200, completed(&format!("enc-from-{}", tag_of(&authorization)))))
        }
    }

    fn endpoint(store: AccountStore, refuse_at: Option<usize>) -> Arc<Endpoint> {
        Arc::new(Endpoint { store, refuse_at, sent: Mutex::default() })
    }

    /// A ChatGPT access token of `account` (the claim the Codex route and its refresh read the account from); `tag`
    /// tells one token of the account from another.
    fn token(account: &str, tag: &str) -> String {
        use base64::Engine;
        let claims = json!({"https://api.openai.com/auth": {"chatgpt_account_id": account}, "tag": tag});
        format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    fn refresh(account: &str, tag: &str) -> String {
        format!("refresh.{account}.{tag}")
    }

    /// The tag of the bearer an `authorization` header carries; a key that is no token is its own tag.
    fn tag_of(authorization: &str) -> String {
        let bearer = authorization.trim_start_matches("Bearer ");
        crate::accounts::validity::decode_jwt_payload(bearer)
            .and_then(|claims| claims.get("tag")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| bearer.to_owned())
    }

    fn said(role: Role, text: &str) -> Message {
        Message::new(role, Content::Text(text.into()))
    }

    fn turn(messages: Vec<Message>, provider_state: Option<ProviderState>) -> Arc<ModelRequest> {
        let options = RequestOptions { session_id: Some("s1".into()), provider_state, ..RequestOptions::default() };
        Arc::new(ModelRequest { model: MODEL.into(), messages, tools: Vec::new(), options })
    }

    /// What an answer leaves for the next request: its replay, the routing that names who served it (a roster walk's
    /// answer only), its state.
    struct Answer {
        replay: ProviderReplay,
        routing: Option<AccountRouting>,
        state: Option<ProviderState>,
    }

    async fn answer_of(adapter: &Arc<dyn ProviderAdapter>, request: Arc<ModelRequest>) -> Answer {
        let mut stream = adapter.attempt(request).await.unwrap_or_else(|e| panic!("{}", e.message));
        let (mut replay, mut routing, mut state) = (None, None, None);
        while let Some(event) = stream.next().await {
            match event.unwrap_or_else(|e| panic!("{}", e.message)) {
                StreamEvent::ReasoningReplay(left) => replay = Some(left),
                StreamEvent::AccountRouting(named) => routing = Some(named),
                StreamEvent::ProviderState(reported) => state = Some(reported),
                _ => {}
            }
        }
        Answer { replay: replay.expect("the answer leaves its replay"), routing, state }
    }

    /// A's answer as the session stored it: the Responses replay of its encrypted reasoning, served by slot `ID_A` with
    /// A's credential.
    fn left_by_a() -> Message {
        let reasoning = json!({"type": "reasoning", "id": "rs_a", "encrypted_content": "enc-of-a", "summary": []});
        let message = json!({"type": "message", "id": "msg_a", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "a", "annotations": []}]});
        let mut left = said(Role::Assistant, "a");
        left.push_replay(ProviderReplay { owner: mixdog_protocol::ProviderId::from("openai-responses"), items: json!([reasoning, message]) });
        left.account_routing = Some(AccountRouting { provider: OPENAI.into(), account_id: ID_A.into(), session_account_id: Some(ID_A.into()) });
        left
    }

    /// `account`'s login (tokens tagged `tag`) signed in to roster slot `slot`, replacing whatever login the slot held.
    #[allow(clippy::disallowed_methods, reason = "the credential files are written directly")]
    fn signed_in(store: &AccountStore, slot: &str, account: &str, tag: &str) {
        let path = store.credential_file(OPENAI, slot).unwrap().path().to_owned();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let login =
            json!({"access_token": token(account, tag), "refresh_token": refresh(account, tag), "expires_at": 4_102_444_800_000u64, "account_id": account});
        std::fs::write(path, login.to_string()).unwrap();
    }

    /// An `openai-oauth` adapter as the product builds it over `net`, its roster slots registered, `selected` selected,
    /// with the host's rotation bound when `bound`.
    async fn openai(
        dir: &tempfile::TempDir,
        slots: &[&str],
        selected: &str,
        bound: bool,
        refuse_at: Option<usize>,
    ) -> (Arc<dyn ProviderAdapter>, AccountStore, Arc<Endpoint>) {
        let vars = Arc::new(Vars([("MIXDOG_OAI_TRANSPORT".to_owned(), "http-sse".to_owned())].into()));
        let probe = builder_over(dir, vars.clone(), None, Arc::new(SessionContext::new()));
        let store = probe.env.accounts.clone();
        for slot in slots {
            store.register(OPENAI, slot, slot, false).await.unwrap();
        }
        store.change(OPENAI, AccountChange { selected_id: Some(selected.into()), ..Default::default() }).await.unwrap();
        let net = endpoint(store.clone(), refuse_at);
        let b = builder_over(dir, vars, Some(net.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        if bound {
            b.bind_account_rotation(AccountRotation::new(
                store.clone(),
                Arc::new(crate::registry::key_pool::NoMeter),
                Arc::new(crate::oauth::pace::FakePace::default()),
            ));
        }
        (b.build(OPENAI, &json!({"enabled": true})).await.unwrap(), store, net)
    }

    /// The roster moves from A to B while A's request is out: the 401 makes the send read its credential again, which
    /// must still be A's (its refresh), never B's. The Codex route carries no provider state: A's continuation is the
    /// replay of A's answer (its encrypted reasoning), which both of A's requests carried. Without a bound rotation and
    /// with one, whose roster walk names A's row as the one that served the answer.
    #[tokio::test]
    async fn the_roster_moving_inside_a_send_does_not_move_its_credential() {
        for bound in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (adapter, store, net) = openai(&dir, &[ID_A, ID_B], ID_A, bound, Some(0)).await;
            signed_in(&store, ID_A, "acct-a", "a");
            signed_in(&store, ID_B, "acct-b", "b");

            let left = answer_of(&adapter, turn(vec![said(Role::User, "q"), left_by_a(), said(Role::User, "next")], None)).await;

            let sent = net.model_requests();
            assert_eq!(sent.len(), 2, "bound {bound}: the refused request and its resend");
            assert_eq!(sent[0].authorization, format!("Bearer {}", token("acct-a", "a")), "bound {bound}");
            assert_eq!(sent[1].authorization, format!("Bearer {}", token("acct-a", "a-renewed")), "bound {bound}: the resend renewed A's credential, not B's");
            assert!(sent.iter().all(|s| s.body.contains("enc-of-a")), "bound {bound}: A's requests carry A's replay");
            let refreshes: Vec<String> =
                net.sent.lock().unwrap().iter().filter(|s| s.url == crate::providers::openai::oauth::TOKEN_URL).map(|s| s.body.clone()).collect();
            assert!(
                !refreshes.is_empty() && refreshes.iter().all(|body| body.contains("refresh.acct-a.a") && !body.contains("acct-b")),
                "bound {bound}: {refreshes:?}"
            );
            assert_eq!(left.routing.map(|routing| routing.account_id), bound.then(|| ID_A.to_owned()), "bound {bound}: only a roster walk names the row");
            assert!(left.replay.items.to_string().contains("enc-from-a-renewed"), "bound {bound}: and is what A's credential was answered");
            assert!(left.state.is_none(), "bound {bound}: the Codex route keeps no provider state");
        }
    }
}

/// A refused key is answered with one read of the source: the value that read gives is what the request is sent again
/// on, and the source is told which key was refused. No second read stands between the comparison and the resend.
#[tokio::test]
async fn a_refused_key_is_read_again_once_and_that_read_is_the_resend() {
    #[derive(Default)]
    struct Keys {
        reads: std::sync::atomic::AtomicUsize,
        refused: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ApiKeySource for Keys {
        async fn key(&self) -> Result<String, ProviderError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok("held".to_owned())
        }
        async fn reload(&self) -> Result<String, ProviderError> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok("stored".to_owned())
        }
        async fn reload_after(&self, rejected: &str) -> Result<String, ProviderError> {
            self.refused.lock().unwrap().push(rejected.to_owned());
            self.reload().await
        }
    }

    let keys = Arc::new(Keys::default());
    let reads = || keys.reads.load(std::sync::atomic::Ordering::SeqCst);
    let gateway = KeyHeader { source: keys.clone(), header: "authorization", bearer: true };
    let sent = gateway.attempt().await.unwrap();
    let before = reads();
    let next = gateway.after_rejection(&sent).await.unwrap().attempt;
    assert_eq!(next.header.map(|(_, value)| value).as_deref(), Some("Bearer stored"));
    assert_eq!(reads() - before, 1, "the gateway key was read twice for one refusal");

    let custom = CustomKey { source: Some(keys.clone()), env: None, header: "x-api-key", bearer: false, refreshable: true };
    let sent = custom.attempt().await.unwrap();
    let before = reads();
    let next = custom.after_rejection(&sent).await.unwrap().attempt;
    assert_eq!(next.header.map(|(_, value)| value).as_deref(), Some("stored"));
    assert_eq!(reads() - before, 1, "the custom key was read twice for one refusal");
    assert_eq!(*keys.refused.lock().unwrap(), ["held", "held"], "the source is told the key each refused request carried");
}

mod engine_stalls {
    //! The pass-through lanes the builder makes (a custom provider on each wire, a gateway's Messages engine) stream through
    //! the model-exchange driver: a silent stream ends on its wire's windows, on the test's clock.

    use super::*;
    use crate::providers::connect::rewrite::testing::{Chunks, Paced, assert_stalls, chat, messages, responses};

    fn turn(model: &str) -> ModelRequest {
        custom_turn(model, mixdog_core_api::domain::provider::RequestOptions::default())
    }

    /// The custom provider on `protocol`, its requests going to an endpoint that streams `streams`.
    fn custom(dir: &tempfile::TempDir, protocol: &str, streams: Vec<Chunks>) -> Arc<dyn ProviderAdapter> {
        let http: Arc<dyn HttpSend> = Paced::new(streams);
        let b = builder_over(dir, Arc::new(ProcessEnv), Some(http), Arc::new(SessionContext::new()));
        b.build_custom_parts("custom-stall", &custom_config(protocol, json!({}))).unwrap().adapter
    }

    #[tokio::test(start_paused = true)]
    async fn a_custom_providers_silent_stream_stalls_on_its_wires_windows() {
        let dir = tempfile::tempdir().unwrap();
        assert_stalls(|streams| custom(&dir, "openai-chat", streams), &turn("m"), &chat()).await;
        assert_stalls(|streams| custom(&dir, "openai-responses", streams), &turn("m"), &responses()).await;
        assert_stalls(|streams| custom(&dir, "anthropic", streams), &turn("claude-sonnet-4-6"), &messages()).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_gateways_silent_messages_stream_stalls_on_the_anthropic_windows() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["deepseek", "openrouter", "opencode-go-oauth", "command-code-oauth"] {
            let build = |streams| -> Arc<dyn ProviderAdapter> { Arc::new(super::gateway_engine(&dir, name, Paced::new(streams))) };
            assert_stalls(build, &turn("claude-sonnet-4-6"), &messages()).await;
        }
    }
}

/// `name`'s Messages engine on `https://gateway.test/anthropic`, its key `gw-key` as `x-api-key` and the gateway's header
/// `x-gateway`, posting to `http`.
fn gateway_engine(dir: &tempfile::TempDir, name: &str, http: Arc<dyn HttpSend>) -> AnthropicAdapter {
    let b = builder(dir);
    let credential: Arc<dyn Credential> = Arc::new(KeyHeader { source: Arc::new(FixedKey("gw-key".into())), header: "x-api-key", bearer: false });
    b.gateway_messages_engine(name, "https://gateway.test/anthropic".into(), credential, vec![("x-gateway".into(), "1".into())], http, &|_| {})
}

mod engine_recoveries {
    //! A gateway's Messages engine has the API-key Anthropic route's recoveries (`GatewayMessagesEngine extends
    //! AnthropicProvider`, wire-gateway.mjs:58), on its own endpoint and with its own headers.

    use super::*;
    use crate::providers::listing_row::testing::Replay;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::StreamTimeoutPhase;

    const TURN: &str = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    const WHOLE: &str = r#"{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"whole"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}"#;
    const OVERFLOW: &str = r#"{"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 16384 > 200000, decrease input length or `max_tokens` and try again"}}"#;

    /// An endpoint answering its requests in turn with `answers`.
    fn endpoint(answers: Vec<(u16, &'static str)>) -> Arc<Replay> {
        let answers = std::sync::Mutex::new(std::collections::VecDeque::from(answers));
        Arc::new(Replay::new(move |_| {
            let (status, body) = answers.lock().unwrap().pop_front().expect("a request the script answers");
            (status, body.as_bytes().to_vec())
        }))
    }

    fn turn() -> ModelRequest {
        custom_turn("claude-sonnet-4-6", mixdog_core_api::domain::provider::RequestOptions::default())
    }

    async fn text_of(mut stream: Box<dyn mixdog_core_api::domain::provider::ModelStream>) -> String {
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            match event.expect("no failure") {
                StreamEvent::TextDelta(delta) | StreamEvent::FinalContent(delta) => text.push_str(&delta),
                _ => {}
            }
        }
        text
    }

    fn body_of(request: &mixdog_core_api::domain::provider::WireRequest) -> Value {
        serde_json::from_slice(&request.body).expect("a JSON body")
    }

    /// Every request went to the gateway's Messages endpoint with its key and its own header.
    fn assert_gateway_requests(sent: &[mixdog_core_api::domain::provider::WireRequest]) {
        for request in sent {
            assert_eq!(request.url, "https://gateway.test/anthropic/v1/messages");
            let header = |name: &str| request.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
            assert_eq!((header("x-api-key"), header("x-gateway")), (Some("gw-key"), Some("1")), "{:?}", request.headers);
        }
    }

    /// `anthropic.mjs:363-368`: a gateway that 404s the streaming request is asked once more without streaming.
    #[tokio::test]
    async fn a_404_to_the_stream_is_reissued_once_without_streaming() {
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(404, r#"{"type":"error","error":{"type":"not_found_error","message":"no stream"}}"#), (200, WHOLE)]);
        let engine = gateway_engine(&dir, "deepseek", http.clone());
        assert_eq!(text_of(engine.attempt(Arc::new(turn())).await.expect("the re-issue answers")).await, "whole");
        let sent = http.requests.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_gateway_requests(&sent);
        assert_eq!((body_of(&sent[0])["stream"].clone(), body_of(&sent[1])["stream"].clone()), (Value::Bool(true), Value::Bool(false)));
    }

    /// `withBodyRecovery` (anthropic-api-transport.mjs:122-139): the overflow 400 shrinks `max_tokens` and replays once.
    #[tokio::test]
    async fn a_context_overflow_shrinks_max_tokens_and_replays_once() {
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(400, OVERFLOW), (200, TURN)]);
        let engine = gateway_engine(&dir, "openrouter", http.clone());
        assert_eq!(text_of(engine.attempt(Arc::new(turn())).await.expect("the replay answers")).await, "ok");
        let sent = http.requests.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_gateway_requests(&sent);
        let (first, second) = (body_of(&sent[0]), body_of(&sent[1]));
        assert_eq!(second["max_tokens"], 9000);
        let mut restored = second.clone();
        restored["max_tokens"] = first["max_tokens"].clone();
        assert_eq!(restored, first, "only max_tokens changed");
    }

    /// `decideStreamError`: a stall that showed nothing is answered by the non-streaming re-issue
    /// (`issueNonStreamingFallback`), on the engine's endpoint.
    #[tokio::test]
    async fn a_stalled_stream_falls_back_to_one_request_without_streaming() {
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(200, WHOLE)]);
        let engine = gateway_engine(&dir, "opencode-go-oauth", http.clone());
        let mut stalled = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        stalled.code = Some("ESTREAMSTALL".into());
        stalled.timeout_phase = Some(StreamTimeoutPhase::Idle);
        assert!(engine.recovers_cut(&turn(), &stalled), "the stall is re-issued");
        assert_eq!(text_of(engine.recover_spent(Arc::new(turn())).await.expect("the re-issue answers")).await, "whole");
        let sent = http.requests.lock().unwrap();
        assert_gateway_requests(&sent);
        assert_eq!(body_of(&sent[0])["stream"], Value::Bool(false));
    }

    const SIGNED: &str = r#"{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"thinking","thinking":"plan","signature":"sig-1"},{"type":"text","text":"whole"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}"#;

    /// A turn the non-streaming re-issue produced (a 404 to the stream) is replayed by the engine's next request as the
    /// streamed turn is: its signed thinking goes back ahead of the text.
    async fn assert_reissued_turn_is_replayed(engine: &dyn ProviderAdapter, http: &Replay) {
        use mixdog_core_api::domain::provider::{Content, Message, Role};
        let mut stream = engine.attempt(Arc::new(turn())).await.expect("the re-issue answers");
        let mut replay = None;
        while let Some(event) = stream.next().await {
            if let StreamEvent::ReasoningReplay(envelope) = event.expect("no failure") {
                replay = Some(envelope);
            }
        }
        let mut answer = Message::new(Role::Assistant, Content::Text("whole".into()));
        answer.push_replay(replay.expect("the re-issued turn carries its replay"));
        let mut next = turn();
        next.messages.push(answer);
        next.messages.push(Message::new(Role::User, Content::Text("next".into())));
        drop(engine.attempt(Arc::new(next)).await.expect("the next request opens"));
        let sent = http.requests.lock().unwrap();
        let assistant = &body_of(&sent[2])["messages"][1]["content"];
        assert_eq!(assistant[0], serde_json::json!({ "type": "thinking", "thinking": "plan", "signature": "sig-1" }), "{assistant}");
    }

    #[tokio::test]
    async fn a_reissued_turn_is_replayed_by_the_next_request_of_a_gateway_engine() {
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(404, r#"{"type":"error","error":{"type":"not_found_error","message":"no stream"}}"#), (200, SIGNED), (200, TURN)]);
        let engine = gateway_engine(&dir, "openrouter", http.clone());
        assert_reissued_turn_is_replayed(&engine, &http).await;
    }

    #[tokio::test]
    async fn a_reissued_turn_is_replayed_by_the_next_request_of_a_custom_engine() {
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(404, r#"{"type":"error","error":{"type":"not_found_error","message":"no stream"}}"#), (200, SIGNED), (200, TURN)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let engine = b.build_custom_parts("custom-replay", &custom_config("anthropic", json!({}))).unwrap().adapter;
        assert_reissued_turn_is_replayed(engine.as_ref(), &http).await;
    }

    /// A custom engine's 400 over a capability floor surfaces as it did, and the native API-key route keeps the
    /// feature: the engine has no capability replay, and floors are never kept under the native route's name for it.
    #[tokio::test]
    async fn a_floor_refusal_on_an_engine_leaves_the_native_routes_features() {
        use crate::claude_floors::Feature;
        let model = "claude-sonnet-4-6-engine-floor";
        let refusal = r#"{"type":"error","error":{"type":"invalid_request_error","message":"thinking.adaptive.display: Extra inputs are not permitted"}}"#;
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(400, refusal), (400, refusal)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let engine = b.build_custom_parts("custom-floor", &custom_config("anthropic", json!({}))).unwrap().adapter;
        let error = engine.attempt(Arc::new(custom_turn(model, Default::default()))).await.err().expect("the refusal surfaces");
        assert_eq!((error.status, http.requests.lock().unwrap().len()), (Some(400), 1), "no capability replay");
        for feature in [Feature::ProgressUpdates, Feature::TurnScopedSystem, Feature::MessageThreads] {
            assert!(crate::claude_floors::enabled(feature, "anthropic", model), "{feature:?} stays on for the native route");
        }
    }

    /// A custom engine whose base URL is Anthropic's own sends its body plain, as its SDK did, and a 400 there leaves the
    /// native route's compression on.
    #[tokio::test]
    async fn a_custom_engine_at_the_official_url_sends_its_body_plain() {
        use mixdog_core_api::domain::provider::{Content, Message, Role};
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#), (200, TURN)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let mut cfg = custom_config("anthropic", json!({}));
        cfg["baseURL"] = json!("https://api.anthropic.com/v1");
        let engine = b.build_custom_parts("custom-official", &cfg).unwrap().adapter;
        let mut request = turn();
        request.messages = vec![Message::new(Role::User, Content::Text("x".repeat(64 * 1024).into()))];
        assert_eq!(engine.attempt(Arc::new(request)).await.err().expect("the refusal surfaces").status, Some(400));
        let sent = http.requests.lock().unwrap();
        assert_eq!(sent.len(), 1, "no plain resend of a compressed body");
        assert_eq!(sent[0].url, "https://api.anthropic.com/v1/messages");
        assert!(!sent[0].headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-encoding")), "{:?}", sent[0].headers);
        assert!(body_of(&sent[0])["messages"].is_array(), "the body went out as JSON");
        assert!(!crate::providers::anthropic::gzip_latched(), "the native route's compression stays on");
    }

    /// A gateway send on the Messages wire whose stream stalled before any output is re-issued without streaming, the way
    /// a real send reaches it: through the gateway adapter, on the wire its attempt went out on.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_messages_stream_of_a_gateway_falls_back_through_the_gateway() {
        use crate::providers::connect::rewrite::testing::{Paced, messages};
        let dir = tempfile::tempdir().unwrap();
        // The re-issue is answered only on the gateway's Messages endpoint; anything else would wait out its window.
        let http = Paced::with_unary(vec![vec![(0, messages().opening)]], |request| {
            let body: Value = serde_json::from_slice(&request.body).ok()?;
            (body["stream"] == Value::Bool(false) && request.url.ends_with("/anthropic/v1/messages")).then(|| (200, WHOLE.as_bytes().to_vec()))
        });
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let cfg = json!({ "enabled": true, "apiKey": "k", "modelWires": { "claude-sonnet-4-6": "messages" } });
        let gateway = b.build("deepseek", &cfg).await.unwrap();
        let request = Arc::new(turn());
        let mut stream = gateway.attempt(request.clone()).await.expect("the stream opens");
        let stalled = loop {
            match stream.next().await.expect("the stall ends the stream") {
                Ok(_) => {}
                Err(error) => break error,
            }
        };
        assert_eq!(stalled.code.as_deref(), Some("ESTREAMSTALL"), "{}", stalled.message);
        assert!(gateway.recovers_cut(&request, &stalled), "the gateway re-issues its Messages stream");
        let answered = gateway.recover_spent(request).await.expect("the re-issue answers");
        assert_eq!(text_of(answered).await, "whole");
        let streamed = http.streamed.lock().unwrap();
        assert!(streamed.iter().all(|sent| sent.url.ends_with("/anthropic/v1/messages")), "{:?}", streamed.iter().map(|s| &s.url).collect::<Vec<_>>());
    }

    /// The engine keeps its own declarations: its name, the documents it takes, no cache warm of the native route.
    #[test]
    fn the_engine_keeps_its_name_and_media_declarations() {
        let dir = tempfile::tempdir().unwrap();
        for (name, pdf, documents) in [("openrouter", true, None), ("deepseek", false, Some(false)), ("command-code-oauth", false, None)] {
            let engine = gateway_engine(&dir, name, endpoint(Vec::new()));
            assert_eq!((engine.id().as_str(), engine.native_pdf(), engine.native_documents()), (name, pdf, documents));
            assert!(engine.cache_warm().is_none() && engine.models().is_none(), "{name}");
        }
    }

    /// A gateway's Claude model sent through the broker (the model proxy, a hosted-tool send) whose Messages ladder ran
    /// out with nothing shown surfaces the ladder's failure: a spent ladder is re-issued on the Chat wire only.
    #[tokio::test(start_paused = true)]
    async fn a_spent_messages_ladder_sent_through_the_broker_is_not_reissued() {
        use crate::admission::{Admission, AdmissionRequest, LaneKey, LaneSettings};
        use crate::broker::{AttemptSink, ModelBroker, SendRequest};
        use crate::retry::StandardRetryDecider;
        struct Quiet;
        impl AttemptSink for Quiet {
            fn event(&mut self, _: StreamEvent) {}
            fn discard(&mut self) {}
        }
        let dir = tempfile::tempdir().unwrap();
        let http = Arc::new(Replay::new(|request| {
            let body: Value = serde_json::from_slice(&request.body).expect("a JSON body");
            if body["stream"] == Value::Bool(false) {
                (200, WHOLE.as_bytes().to_vec())
            } else {
                (500, br#"{"type":"error","error":{"type":"api_error","message":"busy"}}"#.to_vec())
            }
        }));
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let cfg = json!({ "enabled": true, "apiKey": "k", "modelWires": { "claude-sonnet-4-6": "messages" } });
        let gateway = b.build("deepseek", &cfg).await.unwrap();
        let admission = Arc::new(Admission::new());
        let lane = admission.lane(&LaneKey::new("deepseek".into(), "default"), LaneSettings::default());
        let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
        let send = SendRequest { request: Arc::new(turn()), lane, admission: AdmissionRequest::default() };
        let result = broker.send(gateway.as_ref(), send, &mut Quiet, &tokio_util::sync::CancellationToken::new()).await;
        assert!(result.is_err(), "the ladder's failure surfaces");
        let sent = http.requests.lock().unwrap();
        assert!(!sent.is_empty());
        // The provider names no `baseURL`: its Messages endpoint is DeepSeek's own.
        assert!(
            sent.iter().all(|request| request.url == "https://api.deepseek.com/anthropic/v1/messages"),
            "{:?}",
            sent.iter().map(|r| &r.url).collect::<Vec<_>>()
        );
        assert!(sent.iter().all(|request| body_of(request)["stream"] == Value::Bool(true)), "no request without streaming went out");
    }

    /// A send on a rerouted pin lowers its earlier assistant turns; the re-issue of its stalled Messages stream is the
    /// request its attempt sent, lowered the same way.
    #[tokio::test(start_paused = true)]
    async fn a_rerouted_sends_reissue_is_the_request_its_attempt_sent() {
        use crate::providers::connect::rewrite::testing::{Paced, messages};
        use mixdog_core_api::domain::provider::{Content, Message, Role, WirePin};
        let dir = tempfile::tempdir().unwrap();
        let reissued: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
        let seen = reissued.clone();
        let http = Paced::with_unary(vec![vec![(0, messages().opening)]], move |request| {
            let body: Value = serde_json::from_slice(&request.body).ok()?;
            (body["stream"] == Value::Bool(false)).then(|| {
                seen.lock().unwrap().push(body);
                (200, WHOLE.as_bytes().to_vec())
            })
        });
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let cfg = json!({ "enabled": true, "apiKey": "k", "modelWires": { "claude-sonnet-4-6": "messages" } });
        let gateway = b.build("deepseek", &cfg).await.unwrap();
        let mut earlier = Message::new(Role::Assistant, Content::Text("earlier".into()));
        earlier.push_replay(mixdog_core_api::domain::provider::ProviderReplay {
            owner: mixdog_protocol::ProviderId::from("anthropic"),
            items: json!([{ "type": "thinking", "thinking": "plan", "signature": "sig-1" }, { "type": "text", "text": "earlier" }]),
        });
        let mut request = turn();
        request.messages.push(earlier);
        request.messages.push(Message::new(Role::User, Content::Text("next".into())));
        let reroute = json!({
            "provider": "deepseek", "model": "claude-sonnet-4-6", "wire": "messages", "source": "reroute",
            "reroutedFrom": "chat", "reroutedReason": "unsupported", "loweredAssistantCount": 1,
        });
        request.options.wire_pin =
            Some(WirePin { provider: "deepseek".into(), model: "claude-sonnet-4-6".into(), wire: "messages".into(), reroute: Some(reroute) });
        let request = Arc::new(request);
        let mut stream = gateway.attempt(request.clone()).await.expect("the stream opens");
        let stalled = loop {
            match stream.next().await.expect("the stall ends the stream") {
                Ok(_) => {}
                Err(error) => break error,
            }
        };
        assert!(gateway.recovers_cut(&request, &stalled), "the stall is re-issued");
        assert_eq!(text_of(gateway.recover_spent(request).await.expect("the re-issue answers")).await, "whole");
        let attempt = body_of(&http.streamed.lock().unwrap()[0]);
        assert!(!attempt["messages"].to_string().contains("sig-1"), "the attempt lowered the earlier turn: {}", attempt["messages"]);
        assert_eq!(reissued.lock().unwrap()[0]["messages"], attempt["messages"]);
    }

    /// The first-party-only features (`anthropicFirstPartyRoute`: turn-scoped `clear_at` reminders and their beta, eager
    /// tool input streaming, mid-conversation effort updates and their beta) go out on the native API-key route at
    /// Anthropic's endpoint and on none of a custom engine's requests at the same endpoint.
    #[tokio::test]
    async fn first_party_fields_go_out_on_the_native_route_only() {
        use mixdog_core_api::domain::provider::{Content, EffortProjection, Message, MessageSource, RequestOptions, Role, ToolDefinition};
        let model = "claude-opus-5-0";
        let request = || {
            let mut reminder = Message::new(Role::User, Content::Text("remember the rules".into()));
            reminder.source = Some(MessageSource::TailReminder);
            let options = RequestOptions {
                effort: Some("high".into()),
                effort_projection: Some(EffortProjection { initial_effort: "low".into(), updates: [(2, "high".into())].into() }),
                ..RequestOptions::default()
            };
            let mut request = custom_turn(model, options);
            request.messages.extend([
                Message::new(Role::Assistant, Content::Text("ok".into())),
                Message::new(Role::User, Content::Text("next".into())),
                reminder,
            ]);
            request.tools = vec![ToolDefinition {
                name: "lookup".to_owned(),
                description: "lookup".to_owned(),
                input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}}),
                defer_loading: false,
                freeform: None,
            }];
            Arc::new(request)
        };
        let sent_by = |adapter: Arc<dyn ProviderAdapter>, http: Arc<Replay>| async move {
            assert_eq!(text_of(adapter.attempt(request()).await.expect("the send answers")).await, "ok");
            let sent = http.requests.lock().unwrap();
            assert_eq!(sent.len(), 1);
            assert_eq!(sent[0].url, "https://api.anthropic.com/v1/messages");
            let body = body_of(&sent[0]);
            let beta = sent[0].headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("anthropic-beta")).map_or(String::new(), |(_, value)| value.clone());
            let last = body["messages"].as_array().and_then(|all| all.last()).cloned().unwrap_or_default();
            [
                ("clear_at reminder", last["role"] == "system" && last.get("clear_at").is_some()),
                ("clear_at beta", beta.contains("mid-conversation-system-clear-at-2026-08-21")),
                ("eager_input_streaming", body["tools"][0]["eager_input_streaming"] == Value::Bool(true)),
                ("effort update beta", beta.contains("mid-conversation-output-config-2026-07-01")),
            ]
        };

        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(200, TURN)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let native = b.build("anthropic", &json!({ "enabled": true, "apiKey": "k" })).await.unwrap();
        for (feature, sent) in sent_by(native, http).await {
            assert!(sent, "the native route sends its {feature}");
        }

        let http = endpoint(vec![(200, TURN)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let mut cfg = custom_config("anthropic", json!({}));
        cfg["baseURL"] = json!("https://api.anthropic.com/v1");
        let custom = b.build_custom_parts("custom-first-party", &cfg).unwrap().adapter;
        for (feature, sent) in sent_by(custom, http).await {
            assert!(!sent, "a custom engine at the official URL sends no {feature}");
        }
    }

    /// A custom engine at Anthropic's own endpoint, beta headers on, never threads (`anthropicFirstPartyRoute` is a
    /// native provider's, anthropic-request-utils.mjs:116): neither the `thread` field nor its beta goes out, on a first
    /// send or on the conversation's next one.
    #[tokio::test]
    async fn a_custom_engine_at_the_official_url_sends_neither_the_thread_field_nor_its_beta() {
        use mixdog_core_api::domain::provider::{Content, Message, Role};
        let dir = tempfile::tempdir().unwrap();
        let http = endpoint(vec![(200, TURN), (200, TURN)]);
        let b = builder_over(&dir, Arc::new(ProcessEnv), Some(http.clone() as Arc<dyn HttpSend>), Arc::new(SessionContext::new()));
        let mut cfg = custom_config("anthropic", json!({}));
        cfg["baseURL"] = json!("https://api.anthropic.com/v1");
        let engine = b.build_custom_parts("custom-threads", &cfg).unwrap().adapter;
        let options = || mixdog_core_api::domain::provider::RequestOptions { session_id: Some("engine-thread-session".into()), ..Default::default() };
        let first = custom_turn("claude-sonnet-4-6", options());
        assert_eq!(text_of(engine.attempt(Arc::new(first.clone())).await.expect("the first send answers")).await, "ok");
        let mut next = first;
        next.messages.push(Message::new(Role::Assistant, Content::Text("ok".into())));
        next.messages.push(Message::new(Role::User, Content::Text("next".into())));
        assert_eq!(text_of(engine.attempt(Arc::new(next)).await.expect("the next send answers")).await, "ok");
        let sent = http.requests.lock().unwrap();
        assert_eq!(sent.len(), 2);
        for request in sent.iter() {
            assert!(body_of(request).get("thread").is_none(), "{}", body_of(request));
            let beta = request.headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("anthropic-beta")).map_or("", |(_, value)| value.as_str());
            assert!(!beta.contains("message-threads"), "{beta}");
        }
    }
}
