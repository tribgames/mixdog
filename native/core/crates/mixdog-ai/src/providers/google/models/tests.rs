//! The three listings against Node's recorded output (`cases.json`: Node's
//! `listModels` paths run with stubbed fetch and an empty data dir).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::Provenance;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::super::adapter::GoogleAdapter;
use super::super::auth::ApiKeyAuth;
use super::super::auth::Authorization;
use super::super::auth::RequestAuth;
use super::super::codec::GEMINI_ORIGIN;
use super::super::codec::GoogleCodec;
use super::super::policy;
use super::super::traits::ModelTraits;
use super::super::traits::ThinkingControl;
use super::*;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::testing::Once;
const ANTIGRAVITY_ORIGIN: &str = "https://daily-cloudcode-pa.googleapis.com";

/// Serves the scripted answers in order and keeps what was sent.
struct Scripted {
    answers: Mutex<Vec<(u16, String)>>,
    sent: Mutex<Vec<WireRequest>>,
}

impl Scripted {
    fn new(answers: Vec<(u16, String)>) -> Arc<Self> {
        let mut answers = answers;
        answers.reverse();
        Arc::new(Self { answers: Mutex::new(answers), sent: Mutex::default() })
    }

    fn sent(&self) -> Vec<WireRequest> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl HttpSend for Scripted {
    async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let (status, body) = self.answers.lock().unwrap().pop().expect("an answer was scripted");
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Once(Some(Bytes::from(body)))) })
    }
}

struct Levels(ThinkingControl);

impl ModelTraits for Levels {
    fn is_gemini_family(&self, model: &str) -> bool {
        model.starts_with("gemini-")
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        self.0.clone()
    }
}

fn traits() -> Arc<dyn ModelTraits> {
    Arc::new(Levels(ThinkingControl::Unspecified))
}

struct Bearer;

#[async_trait]
impl RequestAuth for Bearer {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        Ok(Authorization { headers: vec![("authorization".into(), "Bearer ya29.test".into())], identity: String::new() })
    }
    async fn rejected(&self, _: &Authorization) -> bool {
        false
    }
}

fn antigravity_adapter(http: Arc<Scripted>, project: &str, traits: Arc<dyn ModelTraits>) -> GoogleAdapter {
    GoogleAdapter::new(GoogleCodec::antigravity(ANTIGRAVITY_ORIGIN, project, "2.19.1", traits), policy::antigravity(), http, Arc::new(Bearer), String::new())
}

#[tokio::test]
async fn an_account_without_a_project_posts_an_empty_object() {
    let http = Scripted::new(vec![(200, json!({"models": {}}).to_string())]);
    let _ = antigravity_adapter(http.clone(), "", traits()).list_models().await;
    assert_eq!(http.sent()[0].body, b"{}");
}

fn request(model: &str, effort: &str, thinking_level: Option<&str>) -> ModelRequest {
    let options = RequestOptions {
        effort: Some(effort.into()),
        model_parameters: thinking_level.map(|level| json!({"thinkingLevel": level, "keep": 1})),
        ..RequestOptions::default()
    };
    ModelRequest { model: model.into(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: vec![], options }
}

#[tokio::test]
async fn an_unlisted_id_is_sent_as_it_is() {
    let http = Scripted::new(vec![(400, json!({"error": {"code": 400}}).to_string())]);
    let adapter = antigravity_adapter(http.clone(), "p", traits());
    let _ = adapter.attempt(Arc::new(request("gemini-9-unlisted", "low", None))).await;
    let body: Value = serde_json::from_slice(&http.sent()[0].body).unwrap();
    assert_eq!(body["model"], "gemini-9-unlisted");
    assert_eq!(body["request"]["generationConfig"]["thinkingConfig"]["thinkingLevel"], "low");
}

#[tokio::test]
async fn a_catalog_ladder_narrows_the_levels_of_a_bare_gemini_wire() {
    let raw = json!({"models": {
        "gemini-3-flash": {"displayName": "Gemini 3 Flash", "maxTokens": 10, "supportsThinking": true},
        "claude-sonnet-4-6": {"displayName": "Claude Sonnet 4.6", "maxTokens": 10, "supportsThinking": true},
        "gpt-oss-120b": {"displayName": "GPT-OSS 120B", "maxTokens": 10, "supportsThinking": true},
        "gemini-3-quiet": {"displayName": "Gemini 3 Quiet", "maxTokens": 10, "supportsThinking": false},
    }});
    let levels = |control: ThinkingControl| {
        let records = antigravity_records(raw.to_string().as_bytes(), &Levels(control)).expect("listed");
        records.into_iter().map(|r| (r.id, r.reasoning_levels)).collect::<Vec<_>>()
    };
    let strings = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let narrowed = levels(ThinkingControl::Levels(strings(&["Minimal", "low", "high"])));
    assert!(narrowed.contains(&("gemini-3-flash".into(), strings(&["low", "high"]))));
    // Claude takes the gateway's levels whatever a catalog says; GPT-OSS and a
    // model the gateway does not flag as thinking-capable have none.
    assert!(narrowed.contains(&("claude-sonnet-4-6".into(), strings(&["low", "medium", "high"]))));
    assert!(narrowed.contains(&("gpt-oss-120b".into(), vec![])));
    assert!(narrowed.contains(&("gemini-3-quiet".into(), vec![])));
    let open = levels(ThinkingControl::Unspecified);
    assert!(open.contains(&("gemini-3-flash".into(), strings(&["low", "medium", "high"]))));
}

/// The roster's shape, ids and display names as this machine's cached live roster holds them (wire id, display name), plus
/// the three flagged rows it carries: `gemini-4-carbon-disabled` (`disabled`), and two `chat_*` ids (`isInternal`).
fn live_roster() -> Value {
    let rows = [
        ("claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"),
        ("claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"),
        ("claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"),
        ("claude-opus-5-5-high", "Claude Opus 5.5 (High)"),
        ("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"),
        ("claude-opus-5-5-low", "Claude Opus 5.5 (Low)"),
        ("gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"),
        ("gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"),
        ("gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"),
        ("gemini-4-neon-high", "Gemini 4 Neon (High)"),
        ("gemini-4-neon-medium", "Gemini 4 Neon (Medium)"),
        ("gemini-4-neon-low", "Gemini 4 Neon (Low)"),
        ("gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"),
        ("gemini-4-argon-high", "Gemini 4 Argon (High)"),
        ("gemini-4-argon-medium", "Gemini 4 Argon (Medium)"),
        ("gemini-4-argon-low", "Gemini 4 Argon (Low)"),
        ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
        ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
        ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
        ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
        ("gemini-3-flash", "Gemini 3 Flash"),
        ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ];
    let mut models = serde_json::Map::new();
    for (wire, display) in rows {
        models.insert(wire.into(), json!({ "displayName": display, "maxTokens": 1_000_000, "maxOutputTokens": 64_000, "supportsThinking": true }));
    }
    models.insert(
        "gemini-4-carbon-disabled".into(),
        json!({ "displayName": "Gemini 4 Carbon", "maxTokens": 1_048_576, "disabled": true, "tagTitle": "Unavailable" }),
    );
    models.insert("model-hidden-from-users".into(), json!({ "displayName": "Hidden Model", "maxTokens": 32_768, "isInternal": true }));
    json!({ "models": models })
}

/// An XHigh row is the fourth effort of its model, and the old standalone id still resolves.
#[test]
fn an_xhigh_row_is_the_fourth_effort_of_its_model() {
    let records = antigravity_records(live_roster().to_string().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    assert_eq!(records.iter().filter(|r| r.id.contains("neon")).count(), 1);
    let neon = records.iter().find(|r| r.id == "gemini-4-neon").expect("one Neon row");
    assert_eq!(neon.reasoning_levels, ["low", "medium", "high", "xhigh"]);
    assert_eq!(resolve_wire(&records, "gemini-4-neon", Some("xhigh")), ("gemini-4-neon-xhigh".to_owned(), None));
    assert_eq!(resolve_wire(&records, "gemini-4-neon-xhigh", Some("high")), ("gemini-4-neon-xhigh".to_owned(), None));
}

/// A session pinned to the old standalone XHigh id sends that wire id once and no thinkingLevel of its own, with a
/// tier map, a restored v2 cache that still holds the standalone row, or no roster at all.
#[tokio::test]
async fn a_session_pinned_to_the_old_xhigh_id_sends_no_second_effort() {
    let mut standalone = ModelRecord::new("gemini-4-neon-xhigh");
    standalone.wire = Some(WireIds::One("gemini-4-neon-xhigh".into()));
    standalone.reasoning_levels = vec!["low".into(), "medium".into(), "high".into()];
    let merged = antigravity_records(live_roster().to_string().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    for roster in [merged, vec![standalone], Vec::new()] {
        for explicit in [Some("high"), None] {
            let http = Scripted::new(vec![(400, json!({"error": {"code": 400}}).to_string())]);
            let adapter = antigravity_adapter(http.clone(), "p", traits()).with_roster(&roster);
            let mut pinned = request("gemini-4-neon-xhigh", "high", Some("high"));
            if explicit.is_none() {
                pinned.options.effort = None;
            }
            let _ = adapter.attempt(Arc::new(pinned)).await;
            let body: Value = serde_json::from_slice(&http.sent()[0].body).unwrap();
            assert_eq!(body["model"], "gemini-4-neon-xhigh");
            let config = &body["request"]["generationConfig"];
            assert!(config.get("thinkingConfig").is_none_or(|c| c.get("thinkingLevel").is_none()), "{config}");
        }
    }
}

/// A row the service marks disabled or internal is not a model: it answers 404 when asked for, so the catalog never offers it.
#[test]
fn a_disabled_or_internal_roster_row_is_not_listed() {
    let records = antigravity_records(live_roster().to_string().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    assert!(!ids.iter().any(|id| id.contains("carbon") || id.contains("hidden")), "{ids:?}");
    let wires: Vec<String> = records
        .iter()
        .flat_map(|r| match &r.wire {
            Some(WireIds::One(w)) => vec![w.clone()],
            Some(WireIds::Tiers(t)) => t.iter().map(|(_, w)| w.clone()).collect(),
            None => vec![],
        })
        .collect();
    assert!(!wires.iter().any(|w| w.contains("carbon") || w.contains("hidden")), "{wires:?}");
    assert!(ids.contains(&"gemini-4-argon"), "the served rows are still listed: {ids:?}");
}

/// The offline list holds only what the live roster lists: every fallback id is a model of it, each of its wire ids a wire id
/// of that model, none a retired id, and the default model (the first) among them.
#[test]
fn the_offline_fallback_holds_only_models_the_live_roster_serves() {
    let records = antigravity_records(live_roster().to_string().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    for (id, _, wires) in crate::catalog::ANTIGRAVITY_FALLBACK {
        let record = records.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("the fallback row {id} is not in the live roster"));
        let served: Vec<String> = match &record.wire {
            Some(WireIds::One(w)) => vec![w.clone()],
            Some(WireIds::Tiers(t)) => t.iter().map(|(_, w)| w.clone()).collect(),
            None => vec![],
        };
        for wire in wires {
            assert!(served.iter().any(|w| w == wire), "{id}: wire id {wire} is not served; the roster has {served:?}");
        }
    }
    for retired in ["gemini-3.1-pro", "claude-opus-4-6-thinking", "claude-sonnet-4-6"] {
        assert!(!crate::catalog::ANTIGRAVITY_FALLBACK.iter().any(|(id, _, wires)| *id == retired || wires.contains(&retired)), "{retired} is retired");
    }
    assert!(records.iter().any(|r| r.id == DEFAULT_ANTIGRAVITY_MODEL), "the default model is served");
}

/// The Gemini list that outlives its timer reads as the real Node function did (`sites.geminiModelList`):
/// `AbortSignal.timeout`'s own error, not `fetch failed`.
#[tokio::test(start_paused = true)]
async fn a_gemini_list_that_outlives_its_timer_reads_as_nodes() {
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

    let transport = TimingOut::new();
    let adapter =
        GoogleAdapter::new(GoogleCodec::gemini(GEMINI_ORIGIN, traits()), policy::gemini(), transport.clone(), Arc::new(ApiKeyAuth::new("k")), String::new());
    let error = adapter.list_models().await.expect_err("the list never answers");
    assert_transport("geminiModelList", &transport);
    assert_thrown("geminiModelList", &error.message);
}

fn vertex_adapter(http: Arc<Scripted>, place: super::super::serving::VertexPlace, auth: Arc<dyn RequestAuth>) -> GoogleAdapter {
    GoogleAdapter::new(GoogleCodec::vertex(place, traits()), policy::gemini(), http, auth, String::new())
}

#[tokio::test]
async fn vertex_express_adds_discovered_gemini_models_to_the_table() {
    use super::super::serving::VertexPlace;
    let page1 = json!({
        "publisherModels": [
            {"name": "publishers/google/models/gemini-4-argon", "versionId": "009", "launchStage": "GA"},
            {"name": "publishers/google/models/gemini-9-neon", "versionId": "001", "launchStage": "GA"},
            {"name": "publishers/google/models/gemini-9-neon-20260101", "launchStage": "GA"},
            {"name": "publishers/google/models/gemini-2.5-flash-preview-tts", "launchStage": "GA"},
            {"name": "publishers/google/models/gemini-live-2.5-flash", "launchStage": "GA"},
            {"name": "publishers/google/models/gemini-embedding-001", "launchStage": "GA"},
            {"name": "publishers/google/models/gemma-3", "launchStage": "GA"}
        ],
        "nextPageToken": "t2"
    });
    let page2 = json!({"publisherModels": [{"name": "publishers/google/models/gemini-9-neon-lite", "launchStage": "PRIVATE_PREVIEW"}]});
    let http = Scripted::new(vec![(200, page1.to_string()), (200, page2.to_string())]);
    let adapter = vertex_adapter(http.clone(), VertexPlace::express(), Arc::new(ApiKeyAuth::new("k")));
    let records = adapter.models().expect("lists models").list_models().await.expect("listed");
    let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    // A model absent from the table is discovered; no launch stage hides one.
    assert_eq!(&ids[ids.len() - 2..], ["gemini-9-neon", "gemini-9-neon-lite"]);
    assert_eq!(ids.len(), 54);
    // Non-chat models and a dated snapshot beside its alias are the sanitizer's to drop.
    for gone in ["gemini-2.5-flash-preview-tts", "gemini-live-2.5-flash", "gemini-9-neon-20260101", "gemini-embedding-001", "gemma-3"] {
        assert!(!ids.contains(&gone), "{gone}");
    }
    // A collision keeps the table's hand-written facts.
    let argon = records.iter().find(|r| r.id == "gemini-4-argon").unwrap();
    assert_eq!((argon.name.as_deref(), argon.context_window), (Some("Gemini 4 Argon"), Some(1_048_576)));
    assert_eq!(argon.picker.reasoning_options[0].values, ["low", "medium", "high"]);
    assert!(argon.raw.is_none());
    let neon = records.iter().find(|r| r.id == "gemini-9-neon").unwrap();
    assert!(neon.picker.model_parameter_options.is_empty() && neon.picker.reasoning_options.is_empty());
    assert!(neon.raw.is_none());
    // Express: one publisher, paged by token.
    let sent = http.sent();
    assert_eq!(sent.len(), 2);
    assert!(sent[0].url.starts_with("https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=1000"));
    assert!(sent[1].url.ends_with("pageToken=t2"));
    // A table row keeps its hand-written facts.
    assert!(records.iter().any(|r| r.id == "xai/grok-4.7"));
}

#[tokio::test]
async fn vertex_project_lists_anthropic_too_and_a_failed_listing_leaves_the_table() {
    use super::super::serving::VertexPlace;
    let google = json!({"publisherModels": []});
    let claude = json!({"publisherModels": [
        {"name": "publishers/anthropic/models/claude-opus-9", "launchStage": "GA"},
        {"name": "publishers/anthropic/models/claude-opus-4-5", "launchStage": "GA"}
    ]});
    let http = Scripted::new(vec![(200, google.to_string()), (200, claude.to_string())]);
    let adapter = vertex_adapter(http.clone(), VertexPlace::project("p", None, None), Arc::new(Bearer));
    let records = adapter.models().unwrap().list_models().await.unwrap();
    let added = records.last().unwrap();
    assert_eq!(added.id, "claude-opus-9");
    assert_eq!(added.family.as_deref(), Some("opus"));
    assert!(added.raw.is_none());
    assert!(http.sent()[1].url.contains("/publishers/anthropic/models"));

    // A refusal is an answer: the roster is the table, whole, and nothing asks again before the roster is next due.
    let http = Scripted::new(vec![(403, "{}".into()), (403, "{}".into())]);
    let adapter = vertex_adapter(http, VertexPlace::project("p", None, None), Arc::new(Bearer));
    let refused = adapter.models().unwrap().list_roster().await.unwrap();
    assert_eq!((refused.rows.len(), refused.provenance), (52, Provenance::Fetched));
    // One publisher refused beside one that lists: what the other found, and still whole.
    let found = json!({"publisherModels": [{"name": "publishers/google/models/gemini-9-neon"}]}).to_string();
    let http = Scripted::new(vec![(200, found.clone()), (403, "{}".into())]);
    let adapter = vertex_adapter(http, VertexPlace::project("p", None, None), Arc::new(Bearer));
    let partly = adapter.models().unwrap().list_roster().await.unwrap();
    assert_eq!((partly.rows.len(), partly.provenance), (53, Provenance::Fetched));

    // A listing that fails is no answer: the roster is shown stale (asked again later) with what was found before.
    // Neither is a spent daily quota, which resets.
    let spent = json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [{"quotaId": "ListPublisherModelsRequestsPerDayPerProject"}]
    }]}})
    .to_string();
    let http = Scripted::new(vec![(200, found), (200, claude.to_string()), (500, "{}".into()), (500, "{}".into()), (429, spent), (200, claude.to_string())]);
    let adapter = vertex_adapter(http, VertexPlace::project("p", None, None), Arc::new(Bearer));
    let first = adapter.models().unwrap().list_roster().await.unwrap();
    assert_eq!((first.rows.len(), first.provenance), (54, Provenance::Fetched));
    for _ in ["a fault", "a spent quota"] {
        let later = adapter.models().unwrap().list_roster().await.unwrap();
        assert_eq!((later.rows.len(), later.provenance), (54, Provenance::Seed));
    }
}

#[tokio::test]
async fn a_discovered_claude_the_configured_location_does_not_serve_is_not_listed() {
    use super::super::serving::VertexPlace;
    let google = json!({"publisherModels": []}).to_string();
    let claude = json!({"publisherModels": [
        {"name": "publishers/anthropic/models/claude-sonnet-4"},
        {"name": "publishers/anthropic/models/claude-opus-9"}
    ]})
    .to_string();
    for (location, listed) in [("global", false), ("us-east5", true)] {
        let http = Scripted::new(vec![(200, google.clone()), (200, claude.clone())]);
        let adapter = vertex_adapter(http, VertexPlace::project("p", Some(location), None), Arc::new(Bearer));
        let records = adapter.models().unwrap().list_models().await.unwrap();
        assert_eq!(records.iter().any(|r| r.id == "claude-sonnet-4"), listed, "{location}");
    }
}

#[tokio::test]
async fn a_slow_publisher_listing_answers_the_table_inside_the_catalog_budget() {
    use super::super::serving::VertexPlace;
    struct Hang;
    #[async_trait]
    impl HttpSend for Hang {
        async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            std::future::pending().await
        }
    }
    tokio::time::pause();
    let adapter = GoogleAdapter::new(
        GoogleCodec::vertex(VertexPlace::express(), traits()),
        policy::gemini(),
        Arc::new(Hang),
        Arc::new(ApiKeyAuth::new("k")),
        String::new(),
    );
    let began = tokio::time::Instant::now();
    let listed = adapter.models().unwrap().list_roster().await.unwrap();
    assert_eq!((listed.rows.len(), listed.provenance), (52, Provenance::Seed));
    assert!(began.elapsed() < crate::catalog::LIST_DEADLINE, "answered after {:?}", began.elapsed());
}

#[tokio::test]
async fn normalized_google_records_drop_raw_json_while_keeping_family_and_roster_cache() {
    let gemini = gemini_records(&[json!({
        "name": "models/gemini-2.5-pro",
        "displayName": "Gemini 2.5 Pro",
        "inputTokenLimit": 1_048_576,
        "outputTokenLimit": 65_536,
        "supportedGenerationMethods": ["generateContent"]
    })]);
    assert_eq!(gemini.len(), 1);
    assert!(gemini[0].raw.is_none());
    assert_eq!(gemini[0].family.as_deref(), Some("gemini-pro"));

    let body = json!({
        "models": {
            "gemini-3-pro-low": {
                "displayName": "Gemini 3 Pro (Low)",
                "maxTokens": 1_048_576,
                "maxOutputTokens": 65_536,
                "supportsImages": true,
                "supportsThinking": true
            },
            "gemini-3-pro-high": {
                "displayName": "Gemini 3 Pro (High)",
                "maxTokens": 1_048_576,
                "maxOutputTokens": 65_536,
                "supportsImages": true,
                "supportsThinking": true
            }
        }
    });
    let records = antigravity_records(&serde_json::to_vec(&body).unwrap(), traits().as_ref()).unwrap();
    assert_eq!(records.len(), 1);
    assert!(records[0].raw.is_none());
    assert_eq!(antigravity_family(&records, &records[0].id).as_deref(), Some("gemini-pro"));
    assert_eq!(antigravity_family(&records, "gemini-3-pro-high").as_deref(), Some("gemini-pro"));

    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let cache = super::super::roster_cache::RosterCache::new(
        dir.path().to_path_buf(),
        crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    cache.save(&records).await;
    let reloaded = cache.load(true).await.expect("reloaded roster");
    assert_eq!(reloaded.len(), 1);
    assert!(reloaded[0].raw.is_none());
    assert_eq!(antigravity_family(&reloaded, &reloaded[0].id).as_deref(), Some("gemini-pro"));
    assert_eq!(reloaded[0].wire, records[0].wire);
}
