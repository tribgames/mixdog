//! `fixtures/services/media-antigravity-image-twin.json` (`record-media-antigravity-image.mjs`):
//! Node's Antigravity image adapter with the network, the login and the random ids stubbed. The
//! request (address, headers, body text in key order, timeout) and the result or error with its
//! attached usage must equal Node's.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::antigravity_image::{AntigravityAuth, AntigravitySession, generate_image};
use super::catalog_fetch::HttpFailure;
use super::download::AdapterError;
use super::image_api::ImageReference;

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-antigravity-image-twin.json");

struct Script {
    reply: Value,
    sent: Mutex<Vec<Value>>,
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        let map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        self.sent.lock().unwrap().push(json!({ "url": url, "headers": map, "body": mixdog_js::json_stringify(body), "timeout": timeout == Duration::from_secs(180) }));
        if let Some(message) = self.reply["fail"].as_str() {
            return Err(HttpFailure { message: message.to_owned(), timed_out: self.reply["name"] == "TimeoutError" });
        }
        Ok(PostReply { status: self.reply["status"].as_u64().unwrap() as u16, headers: Vec::new(), body: self.reply["text"].as_str().unwrap().to_owned() })
    }

    async fn get(&self, _: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        unreachable!("the Antigravity image adapter never polls")
    }
}

struct Session {
    headers: Value,
    counter: AtomicUsize,
}

#[async_trait]
impl AntigravitySession for Session {
    async fn auth(&self) -> Result<AntigravityAuth, AdapterError> {
        Ok(AntigravityAuth { token: "agy-token-1".to_owned(), project_id: "proj-1".to_owned() })
    }

    fn headers(&self) -> Vec<(String, String)> {
        self.headers.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()
    }

    fn endpoint(&self) -> String {
        "https://agy.example.test".to_owned()
    }

    fn uuid(&self) -> String {
        format!("00000000-0000-4000-8000-{:012}", self.counter.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

#[tokio::test]
async fn the_antigravity_image_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let script = Script { reply: case["reply"].clone(), sent: Mutex::new(Vec::new()) };
        let session = Session { headers: golden["headers"].clone(), counter: AtomicUsize::new(0) };
        let references: Vec<ImageReference> = case["references"].as_array().unwrap().iter().map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() }).collect();
        let outcome = generate_image(&script, &session, case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &case["options"], &references, &cancel).await;
        let got = match outcome {
            Ok(image) => json!({ "bytes": image.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": image.mime, "revisedPrompt": image.revised_prompt, "usage": image.usage }),
            Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage }),
        };
        let want = case.get("value").or_else(|| case.get("error")).unwrap();
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{name}");
        let wanted: Vec<Value> = case["sent"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "headers": s["headers"], "body": s["body"], "timeout": s["signal"] })).collect();
        assert_eq!(*script.sent.lock().unwrap(), wanted, "{name}: requests");
    }
}