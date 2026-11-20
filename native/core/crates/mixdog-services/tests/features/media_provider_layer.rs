//! What the media lanes take from the chat providers: the Codex model rows, the Antigravity model list, the client identity
//! and the late-bound login check.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_services::media::accounts::AccountProbe;
use mixdog_services::media::adapter_http::{JsonPost, PostReply};
use mixdog_services::media::catalog::CatalogFailure;
use mixdog_services::media::catalog_fetch::{Auth, HttpFailure};
use mixdog_services::media::lanes::CatalogRows;
use mixdog_services::media::provider_layer::{
    ANTIGRAVITY_GATEWAY, CODEX_NOT_AUTHENTICATED, CodexProviderSession, LateProbe, PROBE_UNBOUND, antigravity_headers, antigravity_rows, codex_row,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[test]
fn a_codex_row_carries_the_names_and_the_catalogs_own_word_on_the_image_tool() {
    let mut record = ModelRecord::new("gpt-5.1");
    assert_eq!(codex_row(&record), json!({"id": "gpt-5.1"}));
    record.name = Some("gpt-5.1".into());
    record.display_name = Some("GPT 5.1".into());
    record.raw = Some(json!({"supports_image_generation": true, "supported_tools": ["image_generation", {"type": "web_search"}, {"nothing": 1}, ""]}));
    assert_eq!(
        codex_row(&record),
        json!({"id": "gpt-5.1", "name": "gpt-5.1", "display": "GPT 5.1", "supportsImageGeneration": true, "supportedTools": ["image_generation", "web_search"]})
    );
    record.raw = Some(json!({"supports_image_generation": "yes", "supported_tools": "image_generation"}));
    assert_eq!(codex_row(&record)["supportsImageGeneration"], Value::Null, "only a boolean is a statement");
    assert!(codex_row(&record).get("supportedTools").is_none());
}

struct Post {
    reply: Mutex<Option<Result<PostReply, HttpFailure>>>,
    sent: Mutex<Vec<(String, Vec<(String, String)>, Value, Duration)>>,
}

impl Post {
    fn answering(reply: Result<PostReply, HttpFailure>) -> Self {
        Self { reply: Mutex::new(Some(reply)), sent: Mutex::default() }
    }
}

#[async_trait]
impl JsonPost for Post {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.sent.lock().unwrap().push((url.to_owned(), headers.to_vec(), body.clone(), timeout));
        self.reply.lock().unwrap().take().expect("one request")
    }
    async fn get(&self, _: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        unreachable!("the model list is a POST")
    }
}

fn answered(status: u16, body: impl ToString) -> Result<PostReply, HttpFailure> {
    Ok(PostReply { status, headers: Vec::new(), body: body.to_string() })
}

fn auth(project: Option<&str>) -> Auth {
    Auth { token: "at".into(), project_id: project.map(str::to_owned), ..Auth::default() }
}

#[tokio::test]
async fn the_antigravity_model_list_is_asked_for_the_project_with_the_clients_identity() {
    let post = Post::answering(answered(200, json!({"models": {"gemini-3-pro-image": {"displayName": "Nano"}, "plain": 5}})));
    let rows = antigravity_rows(&post, "1.2.3", &auth(Some("proj"))).await.unwrap();
    assert_eq!(rows, json!([{"displayName": "Nano", "id": "gemini-3-pro-image"}, {"id": "plain"}]), "a row keeps its fields and takes its key as the id");
    let sent = post.sent.lock().unwrap().clone();
    assert_eq!(sent[0].0, format!("{ANTIGRAVITY_GATEWAY}/v1internal:fetchAvailableModels"));
    assert_eq!(sent[0].1[0], ("Authorization".to_owned(), "Bearer at".to_owned()));
    assert_eq!(sent[0].1[1], ("Content-Type".to_owned(), "application/json".to_owned()));
    assert_eq!(sent[0].1[2..], antigravity_headers("1.2.3")[..]);
    assert_eq!((sent[0].2.clone(), sent[0].3), (json!({"project": "proj"}), Duration::from_secs(15)));
    let none = Post::answering(answered(200, json!({"models": {}})));
    assert_eq!(antigravity_rows(&none, "1", &auth(None)).await.unwrap(), json!([]));
    assert_eq!(none.sent.lock().unwrap()[0].2, json!({}), "no project, an empty body");
}

#[tokio::test]
async fn an_antigravity_list_that_fails_says_what_the_gateway_answered_without_a_secret() {
    let refused = Post::answering(answered(403, format!("denied {}", "x".repeat(400))));
    let error = antigravity_rows(&refused, "1", &auth(None)).await.unwrap_err();
    assert!(error.message.starts_with("[antigravity-oauth] fetchAvailableModels failed: 403 denied "), "{}", error.message);
    assert!(error.message.len() <= "[antigravity-oauth] fetchAvailableModels failed: 403 ".len() + 300, "the answer is cut at 300 characters");
    let secret = Post::answering(answered(401, r#"{"access_token":"ya29.SECRETVALUE"}"#));
    let error = antigravity_rows(&secret, "1", &auth(None)).await.unwrap_err();
    assert!(!error.message.contains("SECRETVALUE"), "{}", error.message);
    let no_models = Post::answering(answered(200, "{}"));
    assert_eq!(antigravity_rows(&no_models, "1", &auth(None)).await.unwrap_err().message, "[antigravity-oauth] fetchAvailableModels returned no models");
    let not_json = Post::answering(answered(200, "<html>"));
    let error = antigravity_rows(&not_json, "1", &auth(None)).await.unwrap_err();
    assert!(error.message.contains("JSON"), "{}", error.message);
    let slow = Post::answering(Err(HttpFailure { message: "timed out".into(), timed_out: true }));
    let error = antigravity_rows(&slow, "1", &auth(None)).await.unwrap_err();
    assert_eq!((error.message.as_str(), error.timed_out), ("timed out", true));
}

#[test]
fn the_antigravity_client_identity_names_the_hub_version() {
    let headers = antigravity_headers("9.8.7");
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[0].0, "User-Agent");
    assert!(headers[0].1.starts_with("antigravity/hub/9.8.7 (aidev_client;"), "{}", headers[0].1);
}

#[test]
fn the_codex_originator_is_the_environment_override_else_codex_cli_rs_read_at_each_call() {
    let env = Arc::new(Mutex::new(None::<String>));
    let read = env.clone();
    let originator = CodexProviderSession::originator_of(Arc::new(move |name| {
        assert_eq!(name, "MIXDOG_CODEX_ORIGINATOR");
        read.lock().unwrap().clone()
    }));
    assert_eq!(originator.get(), "codex_cli_rs");
    *env.lock().unwrap() = Some("  mixdog  ".into());
    assert_eq!(originator.get(), "mixdog");
    *env.lock().unwrap() = Some("   ".into());
    assert_eq!(originator.get(), "codex_cli_rs", "a blank override is no override");
}

struct Signed;

#[async_trait]
impl AccountProbe for Signed {
    async fn authenticated(&self, _: &str, _: Option<&Path>) -> bool {
        true
    }
    async fn models(&self, _: &str, _: Option<&Path>) -> Result<CatalogRows, CatalogFailure> {
        Ok(CatalogRows::default())
    }
}

#[test]
fn the_login_check_is_bound_once_and_reading_it_unbound_says_so() {
    let late = LateProbe::default();
    assert_eq!(late.bound().err().map(|e| e.message), Some(PROBE_UNBOUND.to_owned()));
    assert!(late.bind(Arc::new(Signed)).is_ok());
    assert!(late.bind(Arc::new(Signed)).is_err(), "a second bind is refused");
    let shared = late.clone();
    assert!(shared.bound().is_ok(), "a clone sees the bind");
    assert!(CODEX_NOT_AUTHENTICATED.contains("not authenticated"));
}
