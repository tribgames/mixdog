//! `fixtures/services/media-image-api-twin.json` (`record-media-image-api.mjs`): Node's Image API
//! adapter with the network stubbed. What is sent (address, headers, body text in key order) and
//! what comes back (bytes, mime, revised prompt, reported usage, or the error with its attached
//! usage) must equal Node's. An address in the answer goes to the public fetch, which here answers
//! with Node's own SSRF refusal.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::{Auth, HttpFailure};
use super::download::{AdapterError, PublicFetch, PublicResponse};
use super::image_api::{ImageReference, generate_image};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-image-api-twin.json");

struct Script {
    reply: Value,
    sent: Mutex<Vec<Value>>,
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        let header_map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        self.sent.lock().unwrap().push(json!({ "url": url, "headers": header_map, "body": mixdog_js::json_stringify(body), "timeout": timeout == Duration::from_secs(180) }));
        if let Some(message) = self.reply["fail"].as_str() {
            return Err(HttpFailure { message: message.to_owned(), timed_out: self.reply["name"] == "TimeoutError" });
        }
        let body = match self.reply["json"].as_object() {
            Some(_) => mixdog_js::json_stringify(&self.reply["json"]),
            None => self.reply["text"].as_str().unwrap().to_owned(),
        };
        Ok(PostReply { status: self.reply["status"].as_u64().unwrap() as u16, headers: Vec::new(), body })
    }

    async fn get(&self, _: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        unreachable!("the Image API adapter never polls")
    }
}

/// Node's SSRF refusal for the addresses the scenarios use.
struct Refuse;

#[async_trait]
impl PublicFetch for Refuse {
    async fn get(&self, url: &str, _: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        let host = url.trim_start_matches("http://").split('/').next().unwrap();
        Err(AdapterError::plain(format!("Blocked request to private address: {host}")))
    }
}

#[tokio::test]
async fn the_image_api_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let script = Script { reply: case["reply"].clone(), sent: Mutex::new(Vec::new()) };
        let auth = Auth { token: case["auth"]["token"].as_str().unwrap().to_owned(), base_url: case["auth"]["baseURL"].as_str().unwrap().to_owned(), ..Auth::default() };
        let references: Vec<ImageReference> = case["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() })
            .collect();
        let options = if case["options"].is_null() { json!({}) } else { case["options"].clone() };
        let outcome = generate_image(&script, &Refuse, &auth, case["lane"].as_str().unwrap(), case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &options, &references, &cancel).await;
        let got = match outcome {
            Ok(image) => json!({ "bytes": image.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": image.mime, "revisedPrompt": image.revised_prompt, "usage": image.usage }),
            Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage }),
        };
        let want = case.get("value").or_else(|| case.get("error")).unwrap();
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{name}");
        let wanted_sent: Vec<Value> = case["sent"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "headers": s["headers"], "body": s["body"], "timeout": s["timeout"] })).collect();
        assert_eq!(*script.sent.lock().unwrap(), wanted_sent, "{name}: requests");
    }
}