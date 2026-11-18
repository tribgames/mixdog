//! The media lanes: what each provider's catalog projects to, what a lane's view and a resolved request say, whose credentials
//! a run uses, whether a lane is signed in, and how its catalog is fetched and kept.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_services::media::accounts::{ACCOUNT_PROVIDERS, AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, StudioAccounts, media_lane_account_provider, provider_account_path};
use mixdog_services::media::catalog::{CatalogFailure, catalog_diagnostic, catalog_http_code, catalog_message, project_media_models};
use mixdog_services::media::catalog_fetch::{Auth, CatalogHttp, FetchError, FileCatalogCache, HttpFailure, HttpReply, fetch_media_model_rows, media_catalog_timeout};
use mixdog_services::media::lanes::{CatalogRows, LaneSources, MediaLanes, lane_auth, lane_auth_provider};
use mixdog_services::media::loader::CatalogCache;
use mixdog_services::media::probe::{AccountedProbe, AgentKeys, AgentSettings, FileAccountProbe, ProbeParts, ProviderAuth};
use mixdog_services::media::tool::PinnedAccounts;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn ids(models: &[mixdog_services::media::catalog::Model]) -> Vec<&str> {
    models.iter().map(|m| m.id.as_str()).collect()
}

// ---- projecting a provider's catalog ----

#[test]
fn grok_rows_keep_the_imagine_models_of_both_kinds_newest_first_and_skip_the_rest() {
    let rows = [
        json!({"id": "grok-imagine-image"}),
        json!({"id": "grok-imagine-image-pro", "created": 5}),
        json!({"id": "grok-imagine-image"}),
        json!({"id": "grok-imagine-video"}),
        json!({"id": "grok-imagine-video-1.5"}),
        json!({"id": "grok-imagine-image-old", "deprecated": true}),
        json!({"id": "grok-2"}),
        json!({"id": ""}),
    ];
    let projected = project_media_models("xai", &rows);
    assert_eq!(ids(&projected.image), ["grok-imagine-image-pro", "grok-imagine-image"], "the newer first, a repeated id once");
    assert_eq!(ids(&projected.video), ["grok-imagine-video"], "the version that needs a start image is left out");
    assert_eq!(projected.video[0].controls, json!({"resolution": ["480p", "720p"]}));
    assert_eq!(projected.image[1].label, "Grok Imagine Image");
    assert_eq!(project_media_models("grok-oauth", &rows), projected, "both Grok lanes read the same rows alike");
}

#[test]
fn google_rows_need_their_methods_and_put_stable_models_before_previews() {
    let rows = [
        json!({"name": "models/gemini-3.1-flash-image-preview", "supportedGenerationMethods": ["generateContent"]}),
        json!({"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]}),
        json!({"name": "models/gemini-2.0-flash-image", "supportedGenerationMethods": ["embedContent"]}),
        json!({"name": "models/veo-3.1-generate-preview", "supportedGenerationMethods": ["predictLongRunning"]}),
        json!({"name": "models/veo-3.0-generate-001", "supportedGenerationMethods": ["countTokens"]}),
        json!({"name": "models/veo-2.0-generate-001", "supportedGenerationMethods": ["predictLongRunning"]}),
        json!({"name": "models/gemini-omni-flash"}),
        json!({"name": "models/gemini-2.5-pro"}),
    ];
    let projected = project_media_models("gemini", &rows);
    assert_eq!(ids(&projected.image), ["gemini-2.5-flash-image", "gemini-3.1-flash-image-preview"]);
    assert_eq!(ids(&projected.video), ["gemini-omni-flash", "veo-3.1-generate-preview"]);
    assert_eq!(projected.image[0].label, "Nano Banana · Gemini 2.5 Flash Image");
    assert_eq!(projected.image[1].label, "Nano Banana 2 · Gemini 3.1 Flash Image (Preview)");
    assert_eq!(projected.video[0].controls, json!({"resolution": [], "durations": [], "maxReferences": 3}));
    let antigravity = project_media_models("antigravity-oauth", &rows);
    assert_eq!(ids(&antigravity.image), ids(&projected.image));
    assert!(antigravity.video.is_empty(), "the gateway lists image models only");
}

#[test]
fn the_chatgpt_account_exposes_one_automatic_image_engine_routed_through_a_listed_model() {
    let rows = [json!({"id": "gpt-4o"}), json!({"id": "gpt-5-codex"}), json!({"id": "gpt-5.1"}), json!({"id": "custom-x", "supportsImageGeneration": true})];
    let projected = project_media_models("openai-oauth", &rows);
    assert_eq!(projected.image.len(), 1);
    let engine = &projected.image[0];
    assert_eq!((engine.id.as_str(), engine.label.as_str()), ("gpt-image-2", "GPT Image 2"));
    assert!(engine.request_model.as_deref().is_some_and(|m| m == "gpt-5.1" || m == "custom-x"));
    assert_eq!(engine.controls, json!({"maxReferences": 5, "background": ["auto", "transparent", "opaque"]}));
    assert!(project_media_models("openai-oauth", &[json!({"id": "gpt-4o"}), json!({"id": "gpt-5-chat"})]).image.is_empty(), "no usable orchestrator, no engine");
}

#[test]
fn a_gateway_model_publishes_its_own_enums_and_reference_limit() {
    let rows = [
        json!({"id": "vendor/img", "architecture": {"output_modalities": ["image"], "input_modalities": ["text", "image"]}, "supported_parameters": {"aspect_ratio": {"type": "enum", "values": ["1:1", " 16:9", "1:1"]}, "quality": {"type": "range"}}}),
        json!({"id": "vendor/ranged", "architecture": {"output_modalities": ["image"]}, "supported_parameters": {"input_references": {"type": "range", "max": 40}}}),
        json!({"id": "vendor/text", "architecture": {"output_modalities": ["text"]}}),
        json!({"id": "vendor/off", "architecture": {"output_modalities": ["image"]}, "capabilities": {"image_generation": false}}),
    ];
    let projected = project_media_models("openrouter", &rows);
    assert_eq!(projected.image.len(), 2);
    let by_id = |id: &str| projected.image.iter().find(|m| m.id == id).unwrap();
    assert_eq!(by_id("vendor/img").controls, json!({"aspectRatio": ["1:1", "16:9"], "maxReferences": 16}));
    assert_eq!(by_id("vendor/ranged").controls, json!({"maxReferences": 16}), "a limit above sixteen is sixteen");
    assert!(projected.video.is_empty());
    assert_eq!(project_media_models("nano-gpt", &rows[..1]).image.len(), 1);
}

#[test]
fn a_catalog_failure_is_told_by_a_safe_code_and_a_fixed_sentence() {
    for (status, body, code) in [
        (401, "", "MEDIA_AUTH_REJECTED"),
        (403, "", "MEDIA_ACCESS_DENIED"),
        (429, "", "MEDIA_RATE_LIMITED"),
        (408, "", "MEDIA_CATALOG_TIMEOUT"),
        (504, "", "MEDIA_CATALOG_TIMEOUT"),
        (500, "", "MEDIA_CATALOG_UNAVAILABLE"),
        (500, "Insufficient_Quota for this key", "MEDIA_BILLING_BLOCKED"),
        (401, "your credit balance is too low", "MEDIA_BILLING_BLOCKED"),
    ] {
        assert_eq!(catalog_http_code(status, body), code, "{status} {body}");
        assert!(catalog_message(code).is_some_and(|m| !m.is_empty()));
    }
    assert_eq!(catalog_message("MEDIA_BILLING_BLOCKED"), Some("API credits exhausted or spending limit reached. Check provider billing."));
    assert_eq!(catalog_message("OTHER"), None);
    assert_eq!(catalog_diagnostic(&CatalogFailure { code: Some("MEDIA_RATE_LIMITED".into()), timed_out: false }).0, "MEDIA_RATE_LIMITED");
    assert_eq!(catalog_diagnostic(&CatalogFailure { code: None, timed_out: true }).0, "MEDIA_CATALOG_TIMEOUT");
    assert_eq!(catalog_diagnostic(&CatalogFailure { code: Some("SECRET_DETAIL".into()), timed_out: false }).0, "MEDIA_CATALOG_UNAVAILABLE", "an unknown code is never passed on");
}

// ---- the lanes' views and resolved requests ----

#[derive(Default)]
struct Sources {
    signed_in: Mutex<HashSet<String>>,
    models: Mutex<HashMap<String, Result<CatalogRows, CatalogFailure>>>,
    asked: AtomicUsize,
}

impl Sources {
    fn sign_in(&self, lane: &str, models: Result<CatalogRows, CatalogFailure>) {
        self.signed_in.lock().unwrap().insert(lane.to_owned());
        self.models.lock().unwrap().insert(lane.to_owned(), models);
    }
}

#[async_trait]
impl LaneSources for Sources {
    async fn authenticated(&self, lane: &str) -> bool {
        self.signed_in.lock().unwrap().contains(lane)
    }
    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.models.lock().unwrap().get(lane).cloned().unwrap_or_else(|| Ok(CatalogRows::default()))
    }
}

fn rows(list: Value) -> Result<CatalogRows, CatalogFailure> {
    Ok(CatalogRows { rows: list.as_array().unwrap().clone(), warning: None })
}

fn view_of<'a>(views: &'a [Value], id: &str) -> &'a Value {
    views.iter().find(|v| v["id"] == id).unwrap_or_else(|| panic!("no view of {id}"))
}

#[tokio::test]
async fn a_lane_that_is_signed_out_lists_its_kinds_and_loads_nothing() {
    let sources = Arc::new(Sources::default());
    let views = MediaLanes::new(sources.clone()).list(None).await;
    assert_eq!(views.len(), 7);
    let grok = view_of(&views, "xai");
    assert_eq!((grok["authenticated"].clone(), grok["supportedKinds"].clone(), grok["kinds"].clone()), (json!(false), json!(["image", "video"]), json!([])));
    assert_eq!(view_of(&views, "openrouter")["supportedKinds"], json!(["image"]));
    assert_eq!(sources.asked.load(Ordering::SeqCst), 0, "no catalog is asked for a signed-out lane");
}

#[tokio::test]
async fn a_signed_in_lane_publishes_each_models_controls_over_the_lanes_own() {
    let sources = Arc::new(Sources::default());
    sources.sign_in("xai", Ok(CatalogRows { rows: vec![json!({"id": "grok-imagine-image"}), json!({"id": "grok-imagine-video"})], warning: Some("served from the last catalog".into()) }));
    let views = MediaLanes::new(sources).list(None).await;
    let grok = view_of(&views, "xai");
    assert_eq!(grok["kinds"], json!(["image", "video"]));
    assert_eq!(grok["catalogWarning"], "served from the last catalog");
    assert_eq!(grok["image"]["defaultModel"], "grok-imagine-image");
    assert_eq!(grok["image"]["controls"]["resolution"], json!(["1k", "2k"]));
    assert_eq!(grok["video"]["models"][0]["controls"]["resolution"], json!(["480p", "720p"]), "the model's own list replaces the lane's");
    assert_eq!(grok["video"]["models"][0]["controls"]["durationRange"], json!([1, 15]), "and the lane's other controls stay");
}

#[tokio::test]
async fn a_catalog_that_failed_is_reported_without_the_providers_words_and_a_blocked_bill_hides_the_lane() {
    let sources = Arc::new(Sources::default());
    sources.sign_in("xai", Err(CatalogFailure { code: Some("MEDIA_AUTH_REJECTED".into()), timed_out: false }));
    sources.sign_in("openai-oauth", Err(CatalogFailure { code: None, timed_out: true }));
    sources.sign_in("gemini", Err(CatalogFailure { code: Some("MEDIA_BILLING_BLOCKED".into()), timed_out: false }));
    let views = MediaLanes::new(sources).list(None).await;
    let grok = view_of(&views, "xai");
    assert_eq!(grok["catalogErrorCode"], "MEDIA_AUTH_REJECTED");
    assert_eq!(grok["catalogError"], "Grok Imagine (API key): Authentication failed. Check the API key or reconnect the account.");
    assert_eq!(view_of(&views, "openai-oauth")["catalogError"], "OpenAI Images (Account): Model catalog request timed out. Retry after checking the connection.");
    assert!(views.iter().all(|v| v["id"] != "gemini"), "an unpaid lane is absent");
    assert_eq!(views.len(), 6);
}

#[tokio::test]
async fn a_request_resolves_to_the_default_or_a_named_model_or_says_why_not() {
    let sources = Arc::new(Sources::default());
    sources.sign_in("xai", rows(json!([{"id": "grok-imagine-image", "created": 1}, {"id": "grok-imagine-image-pro", "created": 9}, {"id": "grok-imagine-video"}])));
    sources.sign_in("openrouter", Err(CatalogFailure { code: Some("MEDIA_RATE_LIMITED".into()), timed_out: false }));
    let lanes = MediaLanes::new(sources);
    let resolved = lanes.resolve(" xai ", "image", "").await.unwrap();
    assert_eq!((resolved.model.as_str(), resolved.kind.as_str()), ("grok-imagine-image-pro", "image"), "the first listed is the default");
    assert_eq!(lanes.resolve("xai", "image", "grok-imagine-image").await.unwrap().model, "grok-imagine-image");
    let cases = [
        (lanes.resolve("xai", "audio", "").await, "unsupported media kind \"audio\"", "MEDIA_KIND_UNSUPPORTED", 400),
        (lanes.resolve("zzz", "image", "").await, "unknown media lane \"zzz\"", "MEDIA_LANE_UNKNOWN", 400),
        (lanes.resolve("openrouter", "video", "").await, "openrouter does not support video", "MEDIA_KIND_UNSUPPORTED", 400),
        (lanes.resolve("gemini", "image", "").await, "Google Gemini is not authenticated — sign in from Settings → Providers first", "MEDIA_LANE_UNAUTHENTICATED", 400),
        (lanes.resolve("xai", "image", "nope").await, "model \"nope\" is not available on xai/image", "MEDIA_MODEL_UNSUPPORTED", 400),
        (lanes.resolve("openrouter", "image", "").await, "OpenRouter (API key): Too many requests. Wait a moment and retry.", "MEDIA_RATE_LIMITED", 503),
    ];
    for (outcome, message, code, status) in cases {
        let error = outcome.unwrap_err();
        assert_eq!((error.message.as_str(), error.code, error.status), (message, code, status));
    }
}

#[test]
fn each_lane_names_how_it_signs_in() {
    assert_eq!(lane_auth("xai"), Some(("api-key", "xai")));
    assert_eq!(lane_auth(" grok-oauth "), Some(("oauth", "grok-oauth")));
    assert_eq!(lane_auth_provider("openrouter"), Some("openrouter"));
    assert_eq!(lane_auth("nope"), None);
}

// ---- whose credentials a run uses ----

#[test]
fn an_account_lives_under_its_providers_folder_and_the_default_account_has_no_file_of_its_own() {
    let data = Path::new("/data");
    let id = "11111111-2222-3333-4444-555555555555";
    assert_eq!(provider_account_path(data, "grok-oauth", id), Ok(Some(data.join("provider-accounts").join("grok-oauth").join(format!("{id}.json")))));
    assert_eq!(provider_account_path(data, "custom-mine", id).unwrap().is_some(), true);
    assert_eq!(provider_account_path(data, "grok-oauth", "default"), Ok(None));
    assert_eq!(provider_account_path(data, "xai", id), Err("Unknown OAuth provider.".to_owned()));
    assert_eq!(provider_account_path(data, "custom-", id), Err("Unknown OAuth provider.".to_owned()));
    for bad in ["", "../x", "ABCDEF12-2222-3333-4444-555555555555", "11111111-2222-3333-4444-55555555555"] {
        assert_eq!(provider_account_path(data, "grok-oauth", bad), Err("Invalid provider account id.".to_owned()), "{bad}");
    }
    assert_eq!(ACCOUNT_PROVIDERS.len(), 10);
}

#[test]
fn only_the_oauth_lanes_that_pool_accounts_have_an_account_provider() {
    assert_eq!(media_lane_account_provider("grok-oauth"), "grok-oauth");
    assert_eq!(media_lane_account_provider("openai-oauth"), "openai-oauth");
    assert_eq!(media_lane_account_provider("antigravity-oauth"), "antigravity-oauth");
    for single_key in ["xai", "gemini", "openrouter", "nano-gpt", "nope"] {
        assert_eq!(media_lane_account_provider(single_key), "", "{single_key}");
    }
}

struct Selected(HashMap<String, String>);

#[async_trait]
impl SelectedAccounts for Selected {
    async fn selected(&self, provider: &str) -> Option<String> {
        self.0.get(provider).cloned()
    }
}

const ACCOUNT_A: &str = "aaaaaaaa-0000-0000-0000-000000000001";
const ACCOUNT_B: &str = "bbbbbbbb-0000-0000-0000-000000000002";

#[tokio::test]
async fn a_bound_account_outranks_the_selected_one_and_a_nested_binding_replaces_the_outer() {
    let data = Path::new("/data");
    let selected = Selected(HashMap::from([("grok-oauth".to_owned(), ACCOUNT_A.to_owned())]));
    let open = AccountScope::default();
    assert_eq!(open.account_id("grok-oauth", &selected).await, ACCOUNT_A, "the selected account when nothing is bound");
    assert_eq!(open.account_id("openai-oauth", &selected).await, "default");
    assert_eq!(open.account_id("xai", &selected).await, "default", "a provider that pools no accounts");
    let bound = open.with(data, "grok-oauth", ACCOUNT_B).unwrap();
    assert_eq!(bound.account_id("grok-oauth", &selected).await, ACCOUNT_B);
    assert_eq!(bound.auth_path(data, "grok-oauth", &selected).await, Some(data.join("provider-accounts").join("grok-oauth").join(format!("{ACCOUNT_B}.json"))));
    let nested = bound.with(data, "grok-oauth", "default").unwrap();
    assert_eq!(nested.account_id("grok-oauth", &selected).await, "default");
    assert_eq!(nested.auth_path(data, "grok-oauth", &selected).await, None, "the default account's file is where the provider keeps it");
    assert_eq!(open.auth_path(data, "grok-oauth", &selected).await, Some(data.join("provider-accounts").join("grok-oauth").join(format!("{ACCOUNT_A}.json"))));
    assert!(open.with(data, "xai", ACCOUNT_A).is_err() && open.with(data, "grok-oauth", "nope").is_err());
}

#[tokio::test]
async fn a_credential_file_the_host_bound_outranks_the_pool_and_is_what_the_default_account_falls_back_to() {
    let data = Path::new("/data");
    let selected = Selected(HashMap::from([("grok-oauth".to_owned(), ACCOUNT_A.to_owned())]));
    let host = AccountScope::under_host(vec![("grok-oauth".to_owned(), PathBuf::from("/host/grok.json"))]);
    assert_eq!(host.account_id("grok-oauth", &selected).await, "default");
    assert_eq!(host.auth_path(data, "grok-oauth", &selected).await, Some(PathBuf::from("/host/grok.json")));
    let in_scope = host.with(data, "grok-oauth", "default").unwrap();
    assert_eq!(in_scope.auth_path(data, "grok-oauth", &selected).await, Some(PathBuf::from("/host/grok.json")));
    let chosen = host.with(data, "grok-oauth", ACCOUNT_B).unwrap();
    assert_eq!(chosen.auth_path(data, "grok-oauth", &selected).await, Some(data.join("provider-accounts").join("grok-oauth").join(format!("{ACCOUNT_B}.json"))));
}

#[derive(Default)]
struct Probing {
    seen: Mutex<Vec<(String, Option<PathBuf>)>>,
}

#[async_trait]
impl AccountProbe for Probing {
    async fn authenticated(&self, lane: &str, account: Option<&Path>) -> bool {
        self.seen.lock().unwrap().push((lane.to_owned(), account.map(Path::to_owned)));
        lane == "grok-oauth"
    }
    async fn models(&self, lane: &str, account: Option<&Path>) -> Result<CatalogRows, CatalogFailure> {
        self.seen.lock().unwrap().push((format!("models:{lane}"), account.map(Path::to_owned)));
        Ok(CatalogRows { rows: vec![json!({"id": "grok-imagine-image"})], warning: None })
    }
}

#[tokio::test]
async fn the_lanes_of_a_pinned_account_read_that_accounts_credentials() {
    let data = tempfile::tempdir().unwrap();
    let probe = Arc::new(Probing::default());
    let accounts = StudioAccounts { data_dir: data.path().to_owned(), host: Vec::new(), selected: Arc::new(Selected(HashMap::new())), probe: probe.clone() };
    assert_eq!(accounts.provider_of("grok-oauth"), "grok-oauth");
    assert_eq!(accounts.provider_of("xai"), "");
    let lanes = accounts.lanes_as("grok-oauth", ACCOUNT_B).await.unwrap();
    let grok = lanes.iter().find(|l| l["id"] == "grok-oauth").unwrap();
    assert_eq!((grok["authenticated"].clone(), grok["image"]["defaultModel"].clone()), (json!(true), json!("grok-imagine-image")));
    let account_file = data.path().join("provider-accounts").join("grok-oauth").join(format!("{ACCOUNT_B}.json"));
    let seen = probe.seen.lock().unwrap().clone();
    assert!(seen.contains(&("grok-oauth".to_owned(), Some(account_file.clone()))) && seen.contains(&("models:grok-oauth".to_owned(), Some(account_file))));
    assert!(seen.contains(&("xai".to_owned(), None)), "a lane without accounts is probed with no file");
    assert!(accounts.lanes_as("grok-oauth", "bad").await.is_err());
    assert!(accounts.lanes_as("xai", ACCOUNT_A).await.is_err());
    let scoped = ScopedLaneSources { data_dir: data.path().to_owned(), scope: AccountScope::default(), selected: Arc::new(Selected(HashMap::new())), probe: probe.clone() };
    assert!(scoped.authenticated("grok-oauth").await && !scoped.authenticated("xai").await);
}

// ---- whether a lane is signed in, and where its catalog comes from ----

struct Keys(HashMap<String, String>);

#[async_trait]
impl AgentKeys for Keys {
    async fn has(&self, provider: &str) -> bool {
        self.0.contains_key(provider)
    }
    async fn get(&self, provider: &str) -> Option<String> {
        self.0.get(provider).cloned()
    }
}

struct Settings {
    providers: Value,
    developer: bool,
}

impl AgentSettings for Settings {
    fn providers(&self) -> Value {
        self.providers.clone()
    }
    fn developer_enabled(&self, _: &str) -> bool {
        self.developer
    }
}

struct Oauth;

#[async_trait]
impl ProviderAuth for Oauth {
    async fn oauth(&self, _: &str, account: Option<&Path>) -> Result<Auth, FetchError> {
        Ok(Auth { token: "bearer".into(), base_url: "https://oauth.example".into(), project_id: Some(format!("project-of-{}", account.map_or("default".to_owned(), |a| a.display().to_string()))), account_id: None })
    }
    async fn provider_rows(&self, _: &str, _: &Auth) -> Result<Value, FetchError> {
        Ok(json!([{"id": "gpt-5.1"}]))
    }
}

#[derive(Default)]
struct Net {
    replies: Mutex<Vec<Result<HttpReply, HttpFailure>>>,
    asked: Mutex<Vec<(String, Vec<(String, String)>, Duration)>>,
}

impl Net {
    fn with(replies: Vec<Result<HttpReply, HttpFailure>>) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies), asked: Mutex::default() })
    }
}

#[async_trait]
impl CatalogHttp for Net {
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<HttpReply, HttpFailure> {
        self.asked.lock().unwrap().push((url.to_owned(), headers.to_vec(), timeout));
        let mut replies = self.replies.lock().unwrap();
        assert!(!replies.is_empty(), "an unexpected request: {url}");
        replies.remove(0)
    }
}

fn ok(body: Value) -> Result<HttpReply, HttpFailure> {
    Ok(HttpReply { status: 200, body: body.to_string() })
}

struct Rig {
    probe: AccountedProbe,
    net: Arc<Net>,
    data: tempfile::TempDir,
}

fn rig(keys: &[(&str, &str)], env: &[(&str, &str)], providers: Value, developer: bool, net: Arc<Net>) -> Rig {
    let data = tempfile::tempdir().unwrap();
    let env: HashMap<String, String> = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    let parts = ProbeParts {
        data_dir: data.path().to_owned(),
        lane: mixdog_rt::testing::tokens().durability_io,
        now: Arc::new(|| 1_800_000_000_000),
        env: Arc::new(move |name| env.get(name).cloned()),
        keys: Arc::new(Keys(keys.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect())),
        settings: Arc::new(Settings { providers, developer }),
        provider_auth: Arc::new(Oauth),
        http: net.clone(),
        revision: Arc::new(|| "r1".to_owned()),
    };
    Rig { probe: AccountedProbe(Arc::new(FileAccountProbe::new(parts))), net, data }
}

fn write(path: &Path, doc: Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, doc.to_string()).unwrap();
}

fn jwt(exp: i64) -> String {
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"exp": exp}).to_string());
    format!("h.{payload}.s")
}

#[tokio::test]
async fn an_api_key_lane_is_signed_in_when_its_key_is_known_and_never_on_a_remote_client() {
    let net = Net::with(vec![]);
    let with_keys = rig(&[("xai", "k"), ("gemini", "g"), ("openrouter", "o")], &[], json!({}), false, net.clone());
    for lane in ["xai", "gemini", "openrouter"] {
        assert!(with_keys.probe.authenticated(lane, None).await, "{lane}");
    }
    assert!(!with_keys.probe.authenticated("nano-gpt", None).await && !with_keys.probe.authenticated("nope", None).await);
    let remote = rig(&[("xai", "k")], &[("MIXDOG_MODEL_PROXY", "client")], json!({}), false, net);
    assert!(!remote.probe.authenticated("xai", None).await, "a server that proxies models holds none");
}

#[tokio::test]
async fn nano_gpt_is_signed_in_through_an_enabled_custom_endpoint_on_its_own_host_with_a_key() {
    let net = Net::with(vec![]);
    let provider = |extra: Value| {
        let mut base = json!({"type": "custom", "baseURL": "https://api.nano-gpt.com/api/v1", "apiKey": "k"});
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        json!({"custom-nano": base})
    };
    assert!(rig(&[], &[], provider(json!({})), false, net.clone()).probe.authenticated("nano-gpt", None).await);
    for (extra, why) in [(json!({"enabled": false}), "disabled"), (json!({"auth": "none"}), "no auth"), (json!({"baseURL": "https://evil.example/v1"}), "another host"), (json!({"apiKey": ""}), "no key")] {
        assert!(!rig(&[], &[], provider(extra), false, net.clone()).probe.authenticated("nano-gpt", None).await, "{why}");
    }
    let by_env = rig(&[], &[("NANO_KEY", "x")], provider(json!({"apiKey": "", "apiKeyEnv": "NANO_KEY"})), false, net.clone());
    assert!(by_env.probe.authenticated("nano-gpt", None).await, "the key may come from a variable");
    let by_keychain = rig(&[("custom-nano", "x")], &[], provider(json!({"apiKey": ""})), false, net);
    assert!(by_keychain.probe.authenticated("nano-gpt", None).await, "or from the keychain");
}

#[tokio::test]
async fn an_oauth_lane_is_signed_in_by_a_usable_token_document_in_the_accounts_file() {
    let net = Net::with(vec![]);
    let r = rig(&[], &[], json!({}), false, net);
    let file = r.data.path().join("openai-oauth.json");
    assert!(!r.probe.authenticated("openai-oauth", None).await, "no file");
    write(&file, json!({"access_token": "t", "refresh_token": "r"}));
    assert!(r.probe.authenticated("openai-oauth", None).await, "a refresh token keeps it signed in");
    write(&file, json!({"access_token": "t", "expires_at": 1_800_000_100}));
    assert!(r.probe.authenticated("openai-oauth", None).await, "seconds are read as seconds");
    write(&file, json!({"access_token": "t", "expires_at": 1_799_999_000}));
    assert!(!r.probe.authenticated("openai-oauth", None).await, "an expired token without a refresh token is not");
    write(&file, json!({"access_token": jwt(1_800_000_500)}));
    assert!(r.probe.authenticated("openai-oauth", None).await, "the token's own expiry counts when none is stated");
    write(&file, json!({"access_token": jwt(1_700_000_000)}));
    assert!(!r.probe.authenticated("openai-oauth", None).await);
    write(&file, json!({"refresh_token": "r"}));
    assert!(!r.probe.authenticated("openai-oauth", None).await, "no access token");
    std::fs::write(&file, "{not json").unwrap();
    assert!(!r.probe.authenticated("openai-oauth", None).await);
    let account = r.data.path().join("account.json");
    write(&account, json!({"access_token": "t", "refresh_token": "r"}));
    assert!(r.probe.authenticated("openai-oauth", Some(&account)).await, "the bound account's file is the one read");
}

#[tokio::test]
async fn grok_needs_both_tokens_and_antigravity_a_project_and_the_developer_option() {
    let net = Net::with(vec![]);
    let r = rig(&[], &[], json!({}), false, net.clone());
    write(&r.data.path().join("grok-oauth.json"), json!({"access_token": "t"}));
    assert!(!r.probe.authenticated("grok-oauth", None).await);
    write(&r.data.path().join("grok-oauth.json"), json!({"access_token": "t", "refresh_token": "r"}));
    assert!(r.probe.authenticated("grok-oauth", None).await);
    write(&r.data.path().join("antigravity-oauth.json"), json!({"access_token": "t", "refresh_token": "r", "project_id": "p"}));
    assert!(!r.probe.authenticated("antigravity-oauth", None).await, "a developer-only provider");
    let dev = rig(&[], &[], json!({}), true, net.clone());
    write(&dev.data.path().join("antigravity-oauth.json"), json!({"access_token": "t", "refresh_token": "r"}));
    assert!(!dev.probe.authenticated("antigravity-oauth", None).await, "no project");
    write(&dev.data.path().join("antigravity-oauth.json"), json!({"access_token": "t", "refresh_token": "r", "project_id": "p"}));
    assert!(dev.probe.authenticated("antigravity-oauth", None).await);
    let by_variable = rig(&[], &[("GROK_OAUTH_CREDENTIALS_PATH", r.data.path().join("grok-oauth.json").to_str().unwrap())], json!({}), false, net);
    assert!(by_variable.probe.authenticated("grok-oauth", None).await, "the provider's path variable names the file");
}

#[tokio::test]
async fn a_lanes_catalog_is_fetched_with_its_key_cached_per_credential_and_served_from_the_cache() {
    let net = Net::with(vec![ok(json!({"data": [{"id": "grok-imagine-image"}]}))]);
    let r = rig(&[("xai", "xk")], &[], json!({}), false, net);
    let first = r.probe.models("xai", None).await.unwrap();
    assert_eq!(first.rows, vec![json!({"id": "grok-imagine-image"})]);
    let asked = r.net.asked.lock().unwrap().clone();
    assert_eq!((asked[0].0.as_str(), asked[0].1.clone(), asked[0].2), ("https://api.x.ai/v1/models", vec![("Authorization".to_owned(), "Bearer xk".to_owned())], Duration::from_secs(10)));
    let scope: String = Sha256::digest(b"xk").iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(24).collect();
    let file = r.data.path().join(format!("studio-models-xai-{scope}.json"));
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!((saved["version"].clone(), saved["fetchedAt"].clone(), saved["models"].clone()), (json!(1), json!(1_800_000_000_000i64), json!([{"id": "grok-imagine-image"}])));
    assert!(!std::fs::read_to_string(&file).unwrap().contains("xk"), "the key is never in the cache file");
    assert_eq!(r.probe.models("xai", None).await.unwrap().rows, first.rows);
    assert_eq!(r.net.asked.lock().unwrap().len(), 1, "the second listing is the cache's");
}

#[tokio::test]
async fn a_lane_without_credentials_fails_at_once_without_asking_the_network() {
    let r = rig(&[], &[], json!({}), false, Net::with(vec![]));
    for (lane, message_code) in [("xai", "MEDIA_LANE_UNAUTHENTICATED"), ("openrouter", "MEDIA_LANE_UNAUTHENTICATED")] {
        let failure = r.probe.models(lane, None).await.unwrap_err();
        assert_eq!(failure.code.as_deref(), Some(message_code), "{lane}");
    }
    assert!(r.net.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_account_catalog_comes_from_the_provider_layer_and_the_image_gateways_from_their_own_address() {
    let r = rig(&[("openrouter", "ok")], &[], json!({}), false, Net::with(vec![ok(json!({"data": [{"id": "vendor/img"}]}))]));
    assert_eq!(r.probe.models("openai-oauth", None).await.unwrap().rows, vec![json!({"id": "gpt-5.1"})]);
    assert_eq!(r.probe.models("openrouter", None).await.unwrap().rows, vec![json!({"id": "vendor/img"})]);
    let asked = r.net.asked.lock().unwrap().clone();
    assert_eq!((asked[0].0.as_str(), asked[0].2), ("https://openrouter.ai/api/v1/images/models", Duration::from_secs(60)), "a gateway gets the longer budget");
}

#[tokio::test]
async fn two_accounts_of_one_provider_keep_their_catalogs_apart() {
    let r = rig(&[], &[], json!({}), false, Net::with(vec![]));
    let a = r.probe.models("antigravity-oauth", Some(Path::new("/a.json"))).await;
    let b = r.probe.models("antigravity-oauth", Some(Path::new("/b.json"))).await;
    assert!(a.is_ok() && b.is_ok());
    let cached: Vec<String> = std::fs::read_dir(r.data.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("studio-models-antigravity-oauth-")).collect();
    assert_eq!(cached.len(), 2, "{cached:?}");
}

// ---- fetching a catalog and the cache file ----

fn gateway() -> Auth {
    Auth { token: "tok".into(), base_url: "https://gw.example/v1".into(), ..Auth::default() }
}

#[tokio::test]
async fn gemini_models_are_read_page_by_page_with_the_key_in_a_header() {
    let net = Net::with(vec![ok(json!({"models": [{"name": "models/a"}], "nextPageToken": "t k/1"})), ok(json!({"models": [{"name": "models/b"}]}))]);
    let rows = fetch_media_model_rows(net.as_ref(), "gemini", &Auth { token: "gk".into(), ..Auth::default() }).await.unwrap();
    assert_eq!(rows, json!([{"name": "models/a"}, {"name": "models/b"}]));
    let asked = net.asked.lock().unwrap().clone();
    assert_eq!(asked[0].0, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    assert_eq!(asked[1].0, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=t+k%2F1");
    assert_eq!(asked[0].1, vec![("x-goog-api-key".to_owned(), "gk".to_owned())]);
    let bad = Net::with(vec![ok(json!({"nope": 1}))]);
    assert_eq!(fetch_media_model_rows(bad.as_ref(), "gemini", &Auth::default()).await.unwrap_err().message, "Invalid Gemini media catalog response");
}

#[tokio::test]
async fn other_lanes_read_a_data_list_from_their_models_route() {
    let net = Net::with(vec![ok(json!({"data": [{"id": "m"}]})), ok(json!({"data": [{"id": "i"}]})), ok(json!({"data": "no"})), ok(json!([]))]);
    assert_eq!(fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap(), json!([{"id": "m"}]));
    assert_eq!(fetch_media_model_rows(net.as_ref(), "nano-gpt", &gateway()).await.unwrap(), json!([{"id": "i"}]));
    for _ in 0..2 {
        assert_eq!(fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err().message, "Invalid media catalog response");
    }
    let asked = net.asked.lock().unwrap().clone();
    assert_eq!((asked[0].0.as_str(), asked[1].0.as_str()), ("https://gw.example/v1/models", "https://gw.example/v1/images/models"));
    assert_eq!(asked[0].1, vec![("Authorization".to_owned(), "Bearer tok".to_owned())]);
    assert_eq!((media_catalog_timeout("openrouter"), media_catalog_timeout("nano-gpt"), media_catalog_timeout("xai")), (Duration::from_secs(60), Duration::from_secs(60), Duration::from_secs(10)));
}

#[tokio::test]
async fn a_catalog_request_that_fails_carries_a_code_a_status_and_whether_it_timed_out() {
    let net = Net::with(vec![
        Ok(HttpReply { status: 401, body: "nope".into() }),
        Ok(HttpReply { status: 402, body: "insufficient_quota".into() }),
        Ok(HttpReply { status: 200, body: "not json".into() }),
        Err(HttpFailure { message: "The operation was aborted due to timeout".into(), timed_out: true }),
        Err(HttpFailure { message: "fetch failed".into(), timed_out: false }),
    ]);
    let error = fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err();
    assert_eq!((error.code.as_deref(), error.status, error.message.as_str(), error.timed_out), (Some("MEDIA_AUTH_REJECTED"), Some(401), "Authentication failed. Check the API key or reconnect the account.", false));
    assert_eq!(fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err().code.as_deref(), Some("MEDIA_BILLING_BLOCKED"));
    let invalid = fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err();
    assert_eq!((invalid.code, invalid.status), (None, None));
    let slow = fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err();
    assert!(slow.timed_out && slow.failure().timed_out);
    let down = fetch_media_model_rows(net.as_ref(), "xai", &gateway()).await.unwrap_err();
    assert_eq!((down.message.as_str(), down.timed_out), ("fetch failed", false));
}

#[tokio::test]
async fn the_catalog_file_is_valid_for_a_day_and_a_stale_read_ignores_the_age_but_not_the_version() {
    let dir = tempfile::tempdir().unwrap();
    let now = Arc::new(std::sync::atomic::AtomicI64::new(1_800_000_000_000));
    let clock = now.clone();
    let cache = FileCatalogCache { data_dir: dir.path().to_owned(), lane: mixdog_rt::testing::tokens().durability_io, now: Arc::new(move || clock.load(Ordering::SeqCst)) };
    assert_eq!(cache.load("k", false).await, None);
    cache.save("k", &[json!({"id": "m"})]).await;
    assert!(dir.path().join("studio-models-k.json").exists());
    assert_eq!(cache.load("k", false).await, Some(vec![json!({"id": "m"})]));
    now.fetch_add(24 * 60 * 60_000, Ordering::SeqCst);
    assert_eq!(cache.load("k", false).await, Some(vec![json!({"id": "m"})]), "exactly a day old is still fresh");
    now.fetch_add(1, Ordering::SeqCst);
    assert_eq!(cache.load("k", false).await, None, "older than a day");
    assert_eq!(cache.load("k", true).await, Some(vec![json!({"id": "m"})]), "a stale read takes any age");
    for (doc, why) in [(json!({"version": 2, "fetchedAt": 1, "models": []}), "another version"), (json!({"version": 1, "models": []}), "no time"), (json!({"version": 1, "fetchedAt": 1}), "no models")] {
        std::fs::write(dir.path().join("studio-models-k.json"), doc.to_string()).unwrap();
        assert_eq!(cache.load("k", true).await, None, "{why}");
    }
    std::fs::write(dir.path().join("studio-models-k.json"), "{broken").unwrap();
    assert_eq!(cache.load("k", true).await, None);
}
