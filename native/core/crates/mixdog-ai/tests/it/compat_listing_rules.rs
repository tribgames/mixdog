//! The model listing of the compat family: the request each provider makes (URL, header order, credential), the shapes
//! of roster it reads, which rows it lists, what each provider adds to a row, and how a refusal or a broken answer
//! fails.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::providers::compat::adapter::ApiKeySource;
use mixdog_ai::providers::compat::adapter::CompatAdapter;
use mixdog_ai::providers::compat::chat::CompatChatCodec;
use mixdog_ai::providers::compat::chat::CompatConfig;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::compat::profile::ListingShape;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

struct Body(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(|b| Ok(Bytes::from(b)))
    }
}

/// Answers each request with the next scripted (status, body); the last answer repeats.
struct Answers {
    script: Mutex<Vec<(u16, Vec<u8>)>>,
    sent: Mutex<Vec<WireRequest>>,
}

impl Answers {
    fn new(script: Vec<(u16, Value)>) -> Arc<Self> {
        let script = script.into_iter().map(|(status, body)| (status, body.to_string().into_bytes())).collect();
        Arc::new(Self { script: Mutex::new(script), sent: Mutex::default() })
    }

    fn raw(status: u16, body: &str) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(vec![(status, body.as_bytes().to_vec())]), sent: Mutex::default() })
    }

    fn requests(&self) -> Vec<WireRequest> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl HttpSend for Answers {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let mut script = self.script.lock().unwrap();
        let (status, body) = if script.len() > 1 { script.remove(0) } else { script[0].clone() };
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Body(Some(body))) })
    }
}

struct Key {
    current: Mutex<String>,
    reloads: Mutex<u32>,
}

#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok(self.current.lock().unwrap().clone())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        *self.reloads.lock().unwrap() += 1;
        *self.current.lock().unwrap() = "reloaded-key".into();
        Ok("reloaded-key".into())
    }
}

fn key(value: &str) -> Arc<Key> {
    Arc::new(Key { current: Mutex::new(value.into()), reloads: Mutex::new(0) })
}

fn adapter(profile: CompatProfile, http: Arc<Answers>, key: Arc<Key>, _unused: Option<()>) -> CompatAdapter {
    let config = CompatConfig::for_profile(&profile);
    CompatAdapter::new(CompatChatCodec::new(profile, config), http, Some(key))
}

fn ids(rows: &[ModelRecord]) -> Vec<&str> {
    rows.iter().map(|r| r.id.as_str()).collect()
}

fn header<'a>(request: &'a WireRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn roster_profiles() -> Vec<CompatProfile> {
    [
        CompatProfile::xai(),
        CompatProfile::deepseek(),
        CompatProfile::openrouter(),
        CompatProfile::mimo_oauth(),
        CompatProfile::muse_code_oauth(),
        CompatProfile::command_code_oauth(),
    ]
    .into_iter()
    .collect()
}

#[tokio::test]
async fn a_listing_is_one_get_of_the_models_endpoint_with_the_bearer_and_a_fixed_header_order() {
    for profile in roster_profiles() {
        let id = profile.id;
        let rules = profile.listing;
        let http = Answers::new(vec![(200, json!({"data": [{"id": "model-a"}]}))]);
        let adapter = adapter(profile.clone(), http.clone(), key("the-key"), None);
        adapter.list_models().await.unwrap_or_else(|e| panic!("{id}: {e:?}"));
        let sent = http.requests();
        assert_eq!(sent.len(), 1, "{id}: one fetch, no retry");
        assert_eq!((sent[0].method.as_str(), sent[0].url.as_str()), ("GET", format!("{}/models", profile.base_url).as_str()), "{id}");
        assert_eq!(header(&sent[0], "authorization"), Some("Bearer the-key"), "{id}");
        let names: Vec<&str> = sent[0].headers.iter().map(|(k, _)| k.as_str()).collect();
        if rules.plain_fetch {
            assert_eq!(names[0], "authorization", "{id}: the generic class sends the bearer first");
        } else {
            assert_eq!((names[0], *names.last().unwrap()), ("accept", "authorization"), "{id}: accept first, the bearer last");
        }
    }
}

#[tokio::test]
async fn a_roster_is_read_from_data_or_as_a_bare_array_and_anything_else_lists_nothing() {
    let rows = json!([{"id": "model-a"}, {"id": "model-b"}]);
    for (what, answer, listed) in [
        ("data array", json!({"data": rows}), vec!["model-a", "model-b"]),
        ("bare array", rows.clone(), vec!["model-a", "model-b"]),
        ("data that is not an array", json!({"data": "oops"}), vec![]),
        ("an object without data", json!({"models": rows}), vec![]),
        ("a scalar", json!(7), vec![]),
    ] {
        let adapter = adapter(CompatProfile::deepseek(), Answers::new(vec![(200, answer)]), key("k"), None);
        let found = adapter.list_models().await.unwrap_or_else(|e| panic!("{what}: {e:?}"));
        assert_eq!(ids(&found), listed, "{what}");
    }
}

#[tokio::test]
async fn a_row_with_a_dropped_id_is_never_listed() {
    for profile in roster_profiles() {
        let rules = profile.listing;
        let id = profile.id;
        let Some(part) = rules.drop_id_containing.first() else { continue };
        let dropped = format!("x-{part}-y");
        let http = Answers::new(vec![(200, json!({"data": [{"id": "plain-model"}, {"id": dropped}]}))]);
        let found = adapter(profile, http, key("k"), None).list_models().await.unwrap_or_else(|e| panic!("{id}: {e:?}"));
        assert!(!ids(&found).contains(&dropped.as_str()), "{id}: {:?}", ids(&found));
        if !rules.servable_only {
            assert!(ids(&found).contains(&"plain-model"), "{id}: {:?}", ids(&found));
        }
    }
}

#[tokio::test]
async fn a_refused_listing_fails_with_the_status_and_never_echoes_the_key() {
    for profile in roster_profiles() {
        let id = profile.id;
        let bad = json!({"error": {"message": "bad key the-secret-key", "code": "invalid_api_key"}});
        for status in [401_u16, 403, 500] {
            // A decorated roster shows its seed roster on a failure other than a refused key.
            let decorated = matches!(profile.listing.shape, ListingShape::Decorated { .. });
            let http = Answers::new(vec![(status, bad.clone())]);
            let result = adapter(profile.clone(), http, key("the-secret-key"), None).list_models().await;
            match result {
                Ok(rows) => assert!(decorated && status != 401 && !rows.is_empty(), "{id} {status}: listed {:?}", ids(&rows)),
                Err(error) => {
                    assert_eq!(error.status, Some(status), "{id} {status}");
                    assert!(!error.message.contains("the-secret-key"), "{id} {status}: {}", error.message);
                }
            }
        }
    }
}

#[tokio::test]
async fn a_body_that_is_not_json_is_an_error_not_an_empty_list() {
    for profile in [CompatProfile::deepseek(), CompatProfile::muse_code_oauth(), CompatProfile::command_code_oauth()] {
        let id = profile.id;
        let error = adapter(profile, Answers::raw(200, "<html>no</html>"), key("k"), None).list_models().await.expect_err(id);
        assert!(!error.message.is_empty(), "{id}");
    }
    let error = adapter(CompatProfile::command_code_oauth(), Answers::raw(200, "<html>"), key("k"), None).list_models().await.unwrap_err();
    assert_eq!(error.message, "[command-code-oauth] /provider/v1/models returned invalid JSON", "Command Code names the path");
}

#[tokio::test]
async fn the_decorated_listing_shows_the_seed_roster_when_the_roster_is_empty_or_unreachable_but_not_when_the_key_is_refused() {
    let profile = CompatProfile::mimo_oauth();
    let ListingShape::Decorated { default_levels, seed_when_empty } = profile.listing.shape else { panic!("MiMo's listing is decorated") };
    assert!(seed_when_empty);
    for (what, status, body) in [("empty roster", 200, json!({"data": []})), ("server error", 500, json!({"error": "boom"}))] {
        let rows = adapter(profile.clone(), Answers::new(vec![(status, body)]), key("k"), None).list_models().await.unwrap_or_else(|e| panic!("{what}: {e:?}"));
        assert!(!rows.is_empty(), "{what}: the seed roster is shown");
        assert!(rows.iter().all(|r| r.reasoning_content_field.as_deref() == Some("reasoning_content")), "{what}");
    }
    let refused = adapter(profile.clone(), Answers::new(vec![(401, json!({"error": {"message": "no"}}))]), key("k"), None).list_models().await;
    assert_eq!(refused.unwrap_err().status, Some(401), "a refused key is the caller's to hear");
    // A roster that has rows is listed as it is, each row given the default ladder when it declares none.
    let rows =
        adapter(profile, Answers::new(vec![(200, json!({"data": [{"id": "m-1", "name": " Model One "}]}))]), key("k"), None).list_models().await.unwrap();
    assert_eq!(ids(&rows), ["m-1"]);
    assert_eq!(rows[0].name.as_deref(), Some("Model One"), "the name the roster states, trimmed");
    assert_eq!(rows[0].reasoning_levels, default_levels.iter().map(|l| (*l).to_owned()).collect::<Vec<_>>());
}

#[tokio::test]
async fn muse_code_lists_the_roster_alone_with_its_labels_and_the_default_ladder() {
    let profile = CompatProfile::muse_code_oauth();
    let ListingShape::Roster { default_levels } = profile.listing.shape else { panic!("Muse Code's listing is the roster alone") };
    let body = json!({"data": [
        {"id": "muse-a", "name": "Muse A", "context_window": 128_000, "max_output_tokens": 16_000, "created": 1_700_000_000},
        {"name": "no id at all"},
        {"id": "muse-b", "display_name": "Muse B"},
    ]});
    let rows = adapter(profile, Answers::new(vec![(200, body)]), key("k"), None).list_models().await.unwrap();
    assert_eq!(ids(&rows), ["muse-a", "muse-b"], "a row with no id is skipped");
    assert_eq!(rows[0].name.as_deref(), Some("Muse A"));
    assert_eq!(rows[1].name.as_deref(), Some("Muse B"), "`name` first, then `display_name`");
    assert!(rows[0].display_name.is_none(), "the label is the row's name alone");
    assert_eq!((rows[0].context_window, rows[0].max_output_tokens, rows[0].created), (Some(128_000), Some(16_000), Some(1_700_000_000)));
    let ladder: Vec<String> = default_levels.iter().map(|l| (*l).to_owned()).collect();
    assert_eq!(rows[1].reasoning_levels, ladder, "a model that does not say it cannot reason gets the default ladder");
}

fn go_profile() -> (CompatProfile, &'static str, &'static str) {
    let profile = CompatProfile::opencode_go();
    let ListingShape::ConsoleConfig { url, provider_key } = profile.listing.shape else { panic!("OpenCode Go reads the console config") };
    (profile, url, provider_key)
}

#[tokio::test]
async fn opencode_go_lists_the_console_configs_models_with_their_limits_prices_and_reasoning() {
    let (profile, url, provider_key) = go_profile();
    let config = json!({"providers": {provider_key: {"package": "@ai-sdk/openai-compatible", "models": {
        "model-one": {
            "name": " Model One ",
            "limit": {"context": 200_000, "output": 8_000},
            "cost": {"input": 1.5, "output": 6.0, "cache": {"read": 0.15, "write": 1.875}},
            "capabilities": {"reasoning": {"supported": true, "effort": ["low", "high", ""]}},
        },
        "model-two": {"package": "@ai-sdk/openai", "limit": {"context": 0, "output": -1}},
        "model-off": {"disabled": true},
    }}}});
    let http = Answers::new(vec![(200, config)]);
    let adapter = adapter(profile.clone(), http.clone(), key("access-token"), None);
    let rows = adapter.list_models().await.unwrap();
    assert_eq!(ids(&rows), ["model-one", "model-two"], "a disabled model is not listed");
    let sent = http.requests();
    assert_eq!((sent[0].method.as_str(), sent[0].url.as_str()), ("GET", url));
    assert_eq!(header(&sent[0], "authorization"), Some("Bearer access-token"));
    let one = &rows[0];
    assert_eq!(one.name.as_deref(), Some("Model One"));
    assert_eq!((one.context_window, one.max_output_tokens), (Some(200_000), Some(8_000)));
    assert_eq!(
        (one.input_cost_per_m, one.output_cost_per_m, one.cache_read_cost_per_m, one.cache_write_cost_per_m),
        (Some(1.5), Some(6.0), Some(0.15), Some(1.875))
    );
    assert_eq!((one.supports_reasoning, one.reasoning_levels.clone()), (Some(true), vec!["low".to_owned(), "high".to_owned()]), "empty levels are dropped");
    let two = &rows[1];
    assert_eq!(two.name.as_deref(), Some("model-two"), "no name: the id");
    assert_eq!((two.context_window, two.max_output_tokens), (None, None), "a limit that is not positive states nothing");
    // Each model's wire follows its package, the provider's package standing in for a model that names none. The
    // listing hands the wires to the adapter as the per-model wires, so the route reads as an override.
    let wire = |model: &str| {
        let adapter = &adapter;
        let model = model.to_owned();
        async move { adapter.wire_routing().expect("routed").resolve_wire_route(&model, &Default::default()).await.unwrap().map(|r| (r.wire, r.source)) }
    };
    assert_eq!(wire("model-one").await, Some(("chat".to_owned(), "override".to_owned())));
    assert_eq!(wire("model-two").await, Some(("responses".to_owned(), "override".to_owned())));
}

#[tokio::test]
async fn the_console_config_reloads_a_refused_token_once_and_fails_when_it_is_refused_again() {
    let (profile, _, provider_key) = go_profile();
    let config = json!({"providers": {provider_key: {"models": {"m": {"name": "M"}}}}});
    let source = key("stale");
    let http = Answers::new(vec![(401, json!({"error": "expired"})), (200, config)]);
    let rows = adapter(profile.clone(), http.clone(), source.clone(), None).list_models().await.unwrap();
    assert_eq!(ids(&rows), ["m"]);
    let sent = http.requests();
    assert_eq!((sent.len(), *source.reloads.lock().unwrap()), (2, 1));
    assert_eq!(header(&sent[0], "authorization"), Some("Bearer stale"));
    assert_eq!(header(&sent[1], "authorization"), Some("Bearer reloaded-key"));

    let source = key("stale");
    let http = Answers::new(vec![(401, json!({"error": "expired"}))]);
    let error = adapter(profile, http.clone(), source.clone(), None).list_models().await.unwrap_err();
    assert_eq!(error.status, Some(401));
    assert_eq!((http.requests().len(), *source.reloads.lock().unwrap()), (2, 1), "one reload, one more try");
}

#[tokio::test]
async fn a_console_config_that_lists_no_models_fails_when_the_catalog_has_none_to_fall_back_on() {
    let (profile, _, provider_key) = go_profile();
    for config in [json!({"providers": {provider_key: {"models": {}}}}), json!({"providers": {}})] {
        let error = adapter(profile.clone(), Answers::new(vec![(200, config)]), key("k"), None).list_models().await.unwrap_err();
        assert!(error.message.contains("lists no models") && error.message.contains("unavailable"), "{}", error.message);
    }
}
