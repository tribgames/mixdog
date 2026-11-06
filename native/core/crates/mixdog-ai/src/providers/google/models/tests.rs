//! The three listings against Node's recorded output (`cases.json`: Node's
//! `listModels` paths run with stubbed fetch and an empty data dir).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
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
use super::super::serving::VertexPlace;
use super::super::traits::ModelTraits;
use super::super::traits::ThinkingControl;
use super::*;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

const GOLDEN: &str = include_str!("../../../../../../fixtures/providers/google-models/cases.json");
const ANTIGRAVITY_ORIGIN: &str = "https://daily-cloudcode-pa.googleapis.com";

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden")
}

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

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
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
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

fn raws(records: &[ModelRecord]) -> Vec<Value> {
    records.iter().map(|r| r.raw.clone().expect("a raw row")).collect()
}

fn header<'a>(request: &'a WireRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn gemini_adapter(http: Arc<Scripted>) -> GoogleAdapter {
    GoogleAdapter::new(
        GoogleCodec::gemini(GEMINI_ORIGIN, traits()),
        policy::gemini(),
        http,
        Arc::new(ApiKeyAuth::new(golden()["apiKey"].as_str().unwrap())),
        String::new(),
    )
}

fn antigravity_adapter(http: Arc<Scripted>, project: &str, traits: Arc<dyn ModelTraits>) -> GoogleAdapter {
    GoogleAdapter::new(
        GoogleCodec::antigravity(ANTIGRAVITY_ORIGIN, project, "2.19.1", traits),
        policy::antigravity(),
        http,
        Arc::new(Bearer),
        String::new(),
    )
}

#[tokio::test]
async fn gemini_pages_are_fetched_and_normalized_as_node_does() {
    let g = golden();
    let pages = g["gemini"]["pages"].as_array().unwrap();
    let http = Scripted::new(pages.iter().map(|p| (200, p.to_string())).collect());
    let adapter = gemini_adapter(http.clone());
    let records = adapter.models().expect("lists models").list_models().await.expect("listed");
    let expected = g["gemini"]["listed"]["rows"].as_array().unwrap();
    assert_eq!(raws(&records), *expected);
    for (record, row) in records.iter().zip(expected) {
        crate::providers::listing_row::testing::assert_row_facts(record, row, &format!("gemini {}", record.id));
    }
    let sent = http.sent();
    let calls = g["gemini"]["listed"]["calls"].as_array().unwrap();
    assert_eq!(sent.len(), calls.len());
    for (request, call) in sent.iter().zip(calls) {
        assert_eq!((request.method.as_str(), request.url.as_str()), (call["method"].as_str().unwrap(), call["url"].as_str().unwrap()));
        assert_eq!(header(request, "x-goog-api-key"), call["headers"]["x-goog-api-key"].as_str());
        assert!(request.body.is_empty());
    }
    let flash = &records[0];
    assert_eq!(
        (flash.id.as_str(), flash.display_name.as_deref(), flash.context_window, flash.max_output_tokens),
        ("gemini-3.8-flash", Some("Gemini 3.8 Flash"), Some(1_048_576), Some(65_536))
    );
    let bare = records.iter().find(|r| r.id == "gemini-3-bare").unwrap();
    assert_eq!((bare.context_window, bare.max_output_tokens), (None, None));
}

#[tokio::test]
async fn a_rejected_gemini_listing_is_a_typed_error_with_no_list() {
    let g = golden();
    let body = json!({"error": {"code": 403, "status": "PERMISSION_DENIED"}}).to_string();
    let http = Scripted::new(vec![(403, body)]);
    let err = gemini_adapter(http.clone()).list_models().await.expect_err("a refusal is not a list");
    assert_eq!(err.status, Some(403));
    assert_eq!(http.sent().len(), 1, "no retry");
    assert!(g["gemini"]["rejected"]["error"].as_str().unwrap().ends_with("403"));
}

#[tokio::test]
async fn vertex_lists_its_static_table_without_any_request() {
    let http = Scripted::new(vec![]);
    let adapter = GoogleAdapter::new(
        GoogleCodec::vertex(VertexPlace::express(), traits()),
        policy::gemini(),
        http.clone(),
        Arc::new(ApiKeyAuth::new("")),
        String::new(),
    );
    let records = adapter.models().expect("lists models").list_models().await.expect("listed");
    assert_eq!(raws(&records), *golden()["vertex"]["listed"].as_array().unwrap());
    for (record, row) in records.iter().zip(golden()["vertex"]["listed"].as_array().unwrap()) {
        crate::providers::listing_row::testing::assert_row_facts(record, row, &format!("vertex {}", record.id));
    }
    assert!(http.sent().is_empty());
    let argon = &records[0];
    assert_eq!(argon.supports_reasoning, Some(true));
    assert_eq!(argon.picker.reasoning_options[0].values, ["low", "medium", "high"]);
    let tier = &argon.picker.model_parameter_options[0];
    assert_eq!((tier.id.as_str(), tier.kind.as_str()), ("serviceTier", "enum"));
    assert_eq!(tier.options.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(), ["standard", "priority"]);
    let grok = records.iter().find(|r| r.id == "xai/grok-4.7").unwrap();
    assert_eq!(grok.raw.as_ref().unwrap()["locations"], json!(["global", "us"]));
    assert!(grok.picker.model_parameter_options.is_empty());
}

#[tokio::test]
async fn antigravity_posts_the_catalog_request_and_collapses_tiers_as_node_does() {
    let g = golden();
    let a = &g["antigravity"];
    let http = Scripted::new(vec![(200, json!({ "models": a["raw"] }).to_string())]);
    let adapter = antigravity_adapter(http.clone(), "proj-1", traits());
    let records = adapter.models().expect("lists models").list_models().await.expect("listed");
    assert_eq!(raws(&records), *a["listed"].as_array().unwrap());
    let sent = http.sent();
    let node = &a["requests"][0];
    assert_eq!((sent[0].method.as_str(), sent[0].url.as_str()), ("POST", node["url"].as_str().unwrap()));
    assert_eq!(serde_json::from_slice::<Value>(&sent[0].body).unwrap(), serde_json::from_str::<Value>(node["body"].as_str().unwrap()).unwrap());
    for name in ["Content-Type", "User-Agent"] {
        assert_eq!(header(&sent[0], name), node["headers"][name].as_str(), "{name}");
    }
    assert_eq!(header(&sent[0], "authorization"), Some("Bearer ya29.test"));
    // A record carries the typed fields next to Node's row.
    let flash = records.iter().find(|r| r.id == "gemini-3.8-flash").unwrap();
    assert_eq!(flash.reasoning_levels, ["low", "medium", "high"]);
    assert_eq!((flash.context_window, flash.max_output_tokens, flash.supports_images), (Some(1_048_576), Some(40_000), Some(true)));
}

#[tokio::test]
async fn an_account_without_a_project_posts_an_empty_object() {
    let http = Scripted::new(vec![(200, json!({"models": {}}).to_string())]);
    let _ = antigravity_adapter(http.clone(), "", traits()).list_models().await;
    assert_eq!(http.sent()[0].body, b"{}");
}

#[tokio::test]
async fn a_catalog_without_chat_models_or_a_models_object_is_an_error_not_an_empty_list() {
    for body in [json!({"models": {}}), json!({"models": []}), json!({}), json!({"models": {"chat_1": {"displayName": "x", "maxTokens": 9}}})] {
        let http = Scripted::new(vec![(200, body.to_string())]);
        let err = antigravity_adapter(http, "p", traits()).list_models().await.expect_err("no list");
        assert_eq!(err.kind, ErrorKind::Unknown);
    }
    let node = golden()["antigravity"]["notAnObject"].as_str().unwrap().to_owned();
    assert!(node.contains("returned no models"));
}

fn catalog_body() -> String {
    json!({ "models": golden()["antigravity"]["raw"] }).to_string()
}

#[test]
fn every_listed_id_resolves_to_the_wire_id_and_effort_node_sends() {
    let routes = antigravity_records(catalog_body().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    let sends = golden()["antigravity"]["sends"].as_array().unwrap().clone();
    assert!(sends.len() > 60, "every listed id against every effort");
    for case in sends {
        let (model, effort) = (case["model"].as_str().unwrap(), case["effort"].as_str());
        let (wire, kept) = resolve_wire(&routes, model, effort);
        let node = &case["resolved"];
        assert_eq!(wire, node["model"].as_str().unwrap(), "{model} @ {effort:?}");
        assert_eq!(kept.as_deref(), node["effort"].as_str(), "{model} @ {effort:?}: effort kept");
    }
}

fn request(model: &str, effort: &str, thinking_level: Option<&str>) -> ModelRequest {
    let options = RequestOptions {
        effort: Some(effort.into()),
        model_parameters: thinking_level.map(|level| json!({"thinkingLevel": level, "keep": 1})),
        ..RequestOptions::default()
    };
    ModelRequest { model: model.into(), messages: vec![Message::new(Role::User, Content::Text("hi".into()))], tools: vec![], options }
}

/// A listing, then a send: the request body carries the tier's wire id, and
/// an effort the tier consumed is not sent again as a thinkingLevel.
#[tokio::test]
async fn a_send_after_a_listing_carries_the_tiers_wire_id() {
    let refused = || (400, json!({"error": {"code": 400, "status": "INVALID_ARGUMENT"}}).to_string());
    let http = Scripted::new(vec![(200, catalog_body()), refused(), refused(), refused()]);
    let adapter = antigravity_adapter(http.clone(), "proj-1", traits());
    adapter.models().expect("lists").list_models().await.expect("listed");
    for (model, effort, level) in [("gemini-3.1-pro", "low", Some("high")), ("gemini-3-flash", "high", Some("high")), ("gemini-3-flash", "LOW", None)] {
        let _ = adapter.attempt(Arc::new(request(model, effort, level))).await;
    }
    let bodies: Vec<Value> = http.sent().iter().skip(1).map(|r| serde_json::from_slice(&r.body).unwrap()).collect();
    // A tiered family: the effort chooses the wire id and leaves the request.
    assert_eq!(bodies[0]["model"], "gemini-3.1-pro-low");
    let config = &bodies[0]["request"]["generationConfig"];
    assert!(config.get("thinkingConfig").is_none_or(|c| c.get("thinkingLevel").is_none()), "{config}");
    // A bare leveled record keeps its effort as thinkingLevel.
    assert_eq!(bodies[1]["model"], "gemini-3-flash");
    assert_eq!(bodies[1]["request"]["generationConfig"]["thinkingConfig"]["thinkingLevel"], "high");
    assert_eq!(bodies[2]["request"]["generationConfig"]["thinkingConfig"]["thinkingLevel"], "low");
}

/// A restart: the catalog's restored rows seed the table, and the first send
/// resolves with no listing fetched.
#[tokio::test]
async fn a_seeded_roster_routes_a_send_before_any_listing() {
    let restored = antigravity_records(catalog_body().as_bytes(), &Levels(ThinkingControl::Unspecified)).expect("listed");
    for record in &restored {
        crate::providers::listing_row::testing::assert_row_facts(record, record.raw.as_ref().unwrap(), &format!("antigravity {}", record.id));
    }
    let http = Scripted::new(vec![(400, json!({"error": {"code": 400}}).to_string())]);
    let adapter = antigravity_adapter(http.clone(), "proj-1", traits()).with_roster(&restored);
    let _ = adapter.attempt(Arc::new(request("gemini-3.1-pro", "low", None))).await;
    let sent = http.sent();
    assert_eq!(sent.len(), 1, "no listing fetch");
    let body: Value = serde_json::from_slice(&sent[0].body).unwrap();
    assert_eq!(body["model"], "gemini-3.1-pro-low");
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
