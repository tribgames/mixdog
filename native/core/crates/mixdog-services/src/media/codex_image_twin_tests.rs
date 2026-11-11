//! `fixtures/services/media-codex-image-twin.json` (`record-media-codex-image.mjs`): Node's
//! ChatGPT image adapter and usage-window lookup with the network and the provider session
//! stubbed. Every request (address, headers, body text in key order), the reset-time lookups, the
//! warm-ups and the result or error (usage and reset time attached) must equal Node's. The
//! request id is random: it must be present exactly where Node sends one, 32 hex characters.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::HttpFailure;
use super::codex_image::{CodexAuth, CodexSession, chatgpt_limit_reset_at, generate_image, limit_reset_from_usage};
use super::download::AdapterError;
use super::image_api::ImageReference;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/services/media-codex-image-twin.json");

struct Script {
    queue: Mutex<VecDeque<Value>>,
    sent: Mutex<Vec<Value>>,
}

impl Script {
    fn new(script: &Value) -> Self {
        Self { queue: Mutex::new(script.as_array().unwrap().iter().cloned().collect()), sent: Mutex::new(Vec::new()) }
    }

    fn answer(&self, record: Value) -> Result<PostReply, HttpFailure> {
        self.sent.lock().unwrap().push(record);
        let Some(entry) = self.queue.lock().unwrap().pop_front() else { return Err(HttpFailure { message: "unscripted fetch".to_owned(), timed_out: false }) };
        if let Some(message) = entry["fail"].as_str() {
            return Err(HttpFailure { message: message.to_owned(), timed_out: false });
        }
        let headers = entry["headers"].as_object().map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default();
        Ok(PostReply { status: entry["status"].as_u64().unwrap() as u16, headers, body: entry["text"].as_str().unwrap().to_owned() })
    }
}

fn header_record(headers: &[(String, String)]) -> (serde_json::Map<String, Value>, bool) {
    let mut map = serde_json::Map::new();
    let mut id = false;
    for (name, value) in headers {
        if name == "x-client-request-id" {
            assert!(value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()), "request id {value}");
            id = true;
        } else {
            map.insert(name.clone(), json!(value));
        }
    }
    (map, id)
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        assert_eq!(timeout, Duration::from_secs(400));
        let (map, id) = header_record(headers);
        self.answer(json!({ "url": url, "method": "POST", "headers": map, "requestId": id, "body": mixdog_js::json_stringify(body) }))
    }

    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        assert_eq!(timeout, Duration::from_secs(10));
        let map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        self.answer(json!({ "url": url, "headers": map }))
    }
}

struct Session {
    constants: Value,
    account: Option<String>,
    reset: Option<i64>,
    warmed: AtomicUsize,
    ids: AtomicUsize,
    lookups: Mutex<Vec<Value>>,
}

#[async_trait]
impl CodexSession for Session {
    async fn auth(&self) -> Result<CodexAuth, AdapterError> {
        Ok(CodexAuth { access_token: "tok-1".to_owned(), account_id: self.account.clone() })
    }

    async fn warm_version(&self) {
        self.warmed.fetch_add(1, Ordering::SeqCst);
    }

    fn user_agent(&self) -> String {
        self.constants["userAgent"].as_str().unwrap().to_owned()
    }

    fn version_header(&self) -> String {
        self.constants["version"].as_str().unwrap().to_owned()
    }

    fn originator(&self) -> String {
        self.constants["originator"].as_str().unwrap().to_owned()
    }

    fn responses_url(&self) -> String {
        self.constants["responsesUrl"].as_str().unwrap().to_owned()
    }

    fn request_id(&self) -> String {
        format!("{:032x}", self.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }

    async fn lookup_reset(&self, auth: &CodexAuth, limit_id: &str, _: &CancellationToken) -> Option<i64> {
        self.lookups.lock().unwrap().push(json!({ "token": auth.access_token, "limitId": limit_id }));
        self.reset
    }
}

#[tokio::test]
async fn the_codex_image_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let script = Script::new(&case["script"]);
        let session = Session { constants: golden["constants"].clone(), account: case["accountId"].as_str().map(str::to_owned), reset: case["reset"].as_i64(), warmed: AtomicUsize::new(0), ids: AtomicUsize::new(0), lookups: Mutex::new(Vec::new()) };
        let references: Vec<ImageReference> = case["references"].as_array().unwrap().iter().map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() }).collect();
        let outcome = generate_image(&script, &session, case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &case["options"], &references, &cancel).await;
        let got = match outcome {
            Ok(image) => json!({ "bytes": image.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": image.mime, "revisedPrompt": image.revised_prompt, "actualModel": image.actual_model, "usage": image.usage }),
            Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage, "resetsAt": error.resets_at }),
        };
        let want = case.get("value").or_else(|| case.get("error")).unwrap();
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{name}");
        let wanted_sent: Vec<Value> = case["sent"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "method": s["method"], "headers": s["headers"], "requestId": s["requestId"], "body": s["body"] })).collect();
        assert_eq!(*script.sent.lock().unwrap(), wanted_sent, "{name}: requests");
        assert_eq!(*session.lookups.lock().unwrap(), *case["lookups"].as_array().unwrap(), "{name}: lookups");
        assert_eq!(session.warmed.load(Ordering::SeqCst) as u64, case["warmed"].as_u64().unwrap(), "{name}: warm-ups");
    }
}

#[test]
fn the_reset_time_is_read_from_the_usage_summary_as_nodes_reads_it() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    for case in golden["fromUsage"].as_array().unwrap() {
        let limit_id = mixdog_js::value_to_string(&case["limitId"]);
        assert_eq!(limit_reset_from_usage(&case["payload"], &limit_id), case["resetAt"].as_i64(), "{} {}", case["payload"], limit_id);
    }
}

#[tokio::test]
async fn the_reset_time_lookup_asks_as_nodes_asks() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["lookups"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let script = Script::new(&json!([case["reply"]]));
        let auth = CodexAuth { access_token: case["auth"]["access_token"].as_str().unwrap().to_owned(), account_id: case["auth"]["account_id"].as_str().map(str::to_owned) };
        let got = chatgpt_limit_reset_at(&script, golden["constants"]["userAgent"].as_str().unwrap(), &auth, case["limitId"].as_str().unwrap(), &cancel).await;
        assert_eq!(got, case["resetAt"].as_i64(), "{name}");
        let sent = &case["sent"][0];
        assert_eq!(*script.sent.lock().unwrap(), vec![json!({ "url": sent["url"], "headers": sent["headers"] })], "{name}: request");
    }
}