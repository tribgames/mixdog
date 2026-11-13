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
        accounts: AccountStore::new(
            dir.path().to_path_buf(),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        ),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(Traits),
        route_traits: Arc::new(|_| None),
        openai_facts: Arc::new(NoFacts),
        openai_context: context,
        codex_identity: CodexIdentity {
            installation_id: "i".into(),
            user_agent: "ua".into(),
            version: "1".into(),
            beta_features: String::new(),
        },
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

async fn id_of(b: &DefaultProviderBuilder, name: &str, cfg: Value) -> String {
    b.build(name, &cfg).await.unwrap_or_else(|e| panic!("{name}: {e}")).id().to_string()
}

#[tokio::test]
async fn each_family_builds_under_its_own_id() {
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    for name in ["anthropic", "openai", "gemini", "xai", "deepseek", "openrouter", "cursor-api"] {
        assert_eq!(id_of(&b, name, json!({"enabled": true, "apiKey": "k"})).await, name);
    }
    let custom = json!({"type": "custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/",
        "apiKey": "k", "headers": {"X-A": "1"}, "requestBody": {"top_k": 5}});
    assert_eq!(id_of(&b, "custom-abc", custom).await, "custom-abc");
}

/// What each built provider takes as a document on the route a request goes to, against what the instance of Node's
/// class declared for the same route (`fixtures/media-wire/table.json`: the flags `preparePdfTextForProvider` read).
/// The builder names each row; a row Rust cannot build here is declared in the set's manifest.
#[tokio::test]
#[allow(clippy::disallowed_methods)]
async fn each_route_takes_the_documents_nodes_instance_declared() {
    use mixdog_core_api::domain::provider::{MediaSupport, ModelRequest, RequestOptions};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/media-wire/table.json");
    let table: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let declared = |provider: &str| -> MediaSupport {
        let row = table["rows"].as_array().unwrap().iter().find(|r| r["provider"] == provider).unwrap_or_else(|| panic!("{provider} is a row of the table"));
        let flags = &row["capabilities"];
        // `providerTakesNativePdf`: only an explicit `false` lowers a PDF to text.
        MediaSupport { native_pdf: flags["nativePdf"] != json!(false), native_documents: flags["nativeDocuments"].as_bool() }
    };
    let dir = tempfile::tempdir().unwrap();
    let b = builder(&dir);
    // A session's request carries tools, which is what puts it on a gateway's agent route.
    let tool = mixdog_core_api::domain::provider::ToolDefinition {
        name: "read".to_owned(),
        description: "read".to_owned(),
        input_schema: json!({"type": "object", "properties": {}}),
        defer_loading: false,
        freeform: None,
    };
    let request = |model: &str, agent: bool| ModelRequest {
        model: model.to_owned(),
        messages: Vec::new(),
        tools: if agent { vec![tool.clone()] } else { Vec::new() },
        options: RequestOptions::default(),
    };
    let enabled = json!({"enabled": true, "apiKey": "k"});
    let custom = json!({"type": "custom", "protocol": "anthropic", "baseURL": "http://localhost:1", "apiKey": "k"});
    // (the table's provider, the builder's name and config, the model whose route the row is for, the wire it is on)
    let routes = [
        ("anthropic", "anthropic", enabled.clone(), "claude-sonnet-4-5", None),
        ("openai", "openai", enabled.clone(), "gpt-5", None),
        ("gemini", "gemini", enabled.clone(), "gemini-2.5-pro", None),
        ("xai", "xai", enabled.clone(), "grok-4", None),
        ("cursor-api", "cursor-api", enabled.clone(), "auto", None),
        ("custom-anthropic", "custom-z", custom, "m", None),
        ("deepseek", "deepseek", enabled.clone(), "deepseek-v4-pro", Some("messages")),
        ("openrouter", "openrouter", enabled.clone(), "anthropic/claude-sonnet-4.5", Some("messages")),
        // The product's own adapters for the routes the table names after Node's classes: OpenCode Go's Messages engine
        // (a model its routing sends there) and DeepSeek's Chat wire (`OpenAICompatProvider('deepseek')`), which only a
        // one-shot request without tools takes (DeepSeek's Messages endpoint is for agent sessions).
        ("opencode-go", "opencode-go-oauth", enabled.clone(), "minimax-m2", Some("messages")),
        ("deepseek-chat", "deepseek", enabled.clone(), "deepseek-v4-pro", Some("chat")),
    ];
    for (row, name, cfg, model, wire) in routes {
        let agent = row != "deepseek-chat";
        let adapter = b.build(name, &cfg).await.unwrap_or_else(|e| panic!("{name}: {e}"));
        if let Some(wire) = wire {
            let context = mixdog_core_api::domain::provider::WireRouteContext { agent, ..Default::default() };
            let route = adapter.wire_routing().expect("a gateway routes").resolve_wire_route(model, &context).await.unwrap().unwrap();
            assert_eq!(route.wire, wire, "{row}: {model} is on the wire the row is for");
        }
        assert_eq!(adapter.media_support(&request(model, agent)).await, declared(row), "{row}");
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
    let chat = b.build("custom-harness", &json!({"type": "custom", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1/", "apiKey": "k"})).await.unwrap();
    let route = chat.wire_routing().expect("an OpenAI-compatible custom provider routes").resolve_wire_route("harness-model", &context).await.unwrap().unwrap();
    assert_eq!((route.wire.as_str(), route.source.as_str(), route.profile_id.as_str()), ("chat", "default", "custom-harness:chat"));
    let responses = b.build("custom-r", &json!({"type": "custom", "protocol": "openai-responses", "baseURL": "http://localhost:1/v1/", "apiKey": "k"})).await.unwrap();
    let route = responses.wire_routing().expect("routes").resolve_wire_route("m", &context).await.unwrap().unwrap();
    assert_eq!((route.wire.as_str(), route.profile_id.as_str()), ("responses", "custom-r:responses"));
    let anthropic = b.build("custom-a", &json!({"type": "custom", "protocol": "anthropic", "baseURL": "http://localhost:1", "apiKey": "k"})).await.unwrap();
    assert!(anthropic.wire_routing().is_none());
}

/// `describeVertexAdc` against Node's (`fixtures/vertex-adc/golden.json`, `record-vertex-adc.mjs`):
/// the gcloud login the settings show, over ADC files and gcloud configuration seeded in a folder.
mod adc {
    use std::collections::HashMap;

    use mixdog_rt::LaneToken as _;
    use tokio_util::sync::CancellationToken;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../../fixtures/vertex-adc/golden.json");

    struct MapEnv(HashMap<String, String>);

    impl Environment for MapEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// Paths as the recording wrote them: the folder is `{dir}`, `/` separates.
    fn normalized(value: &Value, dir: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace(dir, "{dir}").replace('\\', "/")),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), normalized(v, dir))).collect()),
            other => other.clone(),
        }
    }

    #[tokio::test]
    async fn every_login_is_described_as_node_does() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let scenarios = golden["scenarios"].as_array().unwrap();
        assert_eq!(scenarios.len(), 28);
        for scenario in scenarios {
            let dir = tempfile::tempdir().unwrap();
            for (relative, text) in scenario["files"].as_object().unwrap() {
                let path = dir.path().join(relative);
                let bytes = text.as_str().unwrap().as_bytes().to_vec();
                mixdog_rt::testing::tokens()
                    .durability_io
                    .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &path, &bytes, &mixdog_statefile::Opts::default()))
                    .unwrap()
                    .await
                    .unwrap()
                    .unwrap();
            }
            let mut env: HashMap<String, String> =
                scenario["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            if scenario["mode"] == "explicit" {
                env.insert("GOOGLE_APPLICATION_CREDENTIALS".into(), dir.path().join("creds").join("key.json").to_string_lossy().into_owned());
            } else {
                env.insert("CLOUDSDK_CONFIG".into(), dir.path().to_string_lossy().into_owned());
            }
            let builder = builder_with(&dir, Arc::new(MapEnv(env)));
            // A metadata server an earlier probe found (or did not).
            if scenario.get("metadata").is_some() {
                builder.metadata_project.set(scenario["metadata"].as_str().map(str::to_owned)).unwrap();
            }
            let described = builder.adc_describe(scenario["override"].as_str().unwrap(), false).await;
            let got = normalized(&described, &dir.path().to_string_lossy());
            assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&scenario["described"]).unwrap(), "{}", scenario["name"]);
        }
    }
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
    assert_eq!(
        err("mixdog-local", json!({})).await,
        "mixdog-local needs the managed local runtime, which this host does not have"
    );
    let wires = |protocol: &str, extra: Value| {
        let mut cfg = json!({"type": "custom", "protocol": protocol, "baseURL": "http://x/v1"});
        cfg.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        cfg
    };
    let bad = err("custom-1", wires("anthropic", json!({"wires": ["messages"]}))).await;
    assert_eq!(bad, "[custom-provider] wires requires an 'openai-chat' or 'openai-responses' protocol");
    assert_eq!(
        err("custom-1", wires("openai-chat", json!({"wires": ["responses"]}))).await,
        "[custom-provider] wires must include the protocol wire: chat"
    );
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

    fn configuration(label: &'static str) -> Config {
        let issued = Arc::new(Mutex::new(Vec::new()));
        let record = issued.clone();
        let n = std::sync::atomic::AtomicU64::new(0);
        let net: Arc<dyn HttpSend> = Arc::new(Replay::new(move |request| {
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

/// A custom provider serving the Chat, Responses and Messages wires warms its endpoint as Node's does, on the process clock
/// moved past the keep-alive window (`custom-warmups/golden.json`, `record-custom-warmups.mjs`): the provider's construction
/// warms; a send inside the window does not; a send after it re-warms on the Chat and Responses wires and not on Messages,
/// which Node hands straight to the Anthropic client. The sends that reached the endpoint show each took its wire.
#[tokio::test]
async fn a_custom_provider_warms_on_the_wires_node_warms_on() {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use crate::providers::listing_row::testing::Replay;
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::ModelRequest;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;

    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/custom-warmups/golden.json")).unwrap();
    let (start, lapsed) = (golden["clock"]["start"].as_u64().unwrap(), golden["clock"]["lapsed"].as_u64().unwrap());
    for (wire, recorded) in golden["scenarios"].as_object().unwrap() {
        let origin = format!("http://warm-{wire}.test");
        let clock = Arc::new(AtomicU64::new(start));
        let replay = Arc::new(Replay::new(|_| (400, br#"{"error":{"message":"scripted refusal","type":"invalid_request_error"}}"#.to_vec())));
        let dir = tempfile::tempdir().unwrap();
        let now = clock.clone();
        let context = Arc::new(SessionContext::with_sources(move || now.load(Ordering::SeqCst), || "request".to_owned()));
        let builder = builder_over(&dir, Arc::new(ProcessEnv), Some(replay.clone() as Arc<dyn HttpSend>), context);
        let models = [("chat", "model-chat"), ("responses", "model-responses"), ("messages", "model-messages")];
        let cfg = json!({
            "type": "custom", "protocol": "openai-chat", "baseURL": format!("{origin}/{wire}/v1"), "apiKey": "warm-up-key",
            "wires": ["chat", "responses", "messages"],
            "modelWires": models.iter().map(|(w, m)| ((*m).to_owned(), json!(w))).collect::<serde_json::Map<_, _>>(),
        });
        let heads = || replay.requests.lock().unwrap().iter().filter(|r| r.method == "HEAD").count();
        let model = models.iter().find(|(w, _)| w == wire).unwrap().1;
        let send = |provider: Arc<dyn ProviderAdapter>| async move {
            let request = ModelRequest {
                model: model.to_owned(),
                messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
                tools: Vec::new(),
                options: RequestOptions::default(),
            };
            let _ = provider.attempt(Arc::new(request)).await;
        };
        crate::transport::preconnect::reset();
        let provider = builder.build(&format!("custom-warm-{wire}"), &cfg).await.unwrap();
        let mut steps = vec![heads()];
        send(provider.clone()).await;
        steps.push(heads());
        clock.store(lapsed, Ordering::SeqCst);
        send(provider).await;
        steps.push(heads());
        let recorded_steps: Vec<usize> = recorded["steps"].as_array().unwrap().iter().map(|s| s[1].as_u64().unwrap() as usize).collect();
        assert_eq!(steps, recorded_steps, "{wire}: warm-ups after the build, the send inside the window, the send after it");
        let requests = replay.requests.lock().unwrap();
        let warmups: Vec<(String, String)> = requests.iter().filter(|r| r.method == "HEAD").map(|r| ("HEAD".to_owned(), r.url.replace(&origin, ""))).collect();
        let recorded_warmups: Vec<(String, String)> =
            recorded["warmups"].as_array().unwrap().iter().map(|w| (w[0].as_str().unwrap().to_owned(), w[1].as_str().unwrap().to_owned())).collect();
        assert_eq!(warmups, recorded_warmups, "{wire}: the warm-up requests");
        let sent: Vec<(String, String)> = requests.iter().filter(|r| r.method != "HEAD").map(|r| (r.method.clone(), r.url.replace(&origin, ""))).collect();
        let recorded_sent: Vec<(String, String)> =
            recorded["sent"].as_array().unwrap().iter().map(|w| (w[0].as_str().unwrap().to_owned(), w[1].as_str().unwrap().to_owned())).collect();
        assert_eq!(sent, recorded_sent, "{wire}: the requests the sends made");
    }
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
