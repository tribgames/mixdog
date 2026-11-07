//! `fixtures/services/media-gemini-image-twin.json` (`record-media-gemini-image.mjs`): Node's
//! Gemini image adapter with the network stubbed. The request (address with the model encoded,
//! headers, body text in key order, timeout) and the result or error with its attached usage must
//! equal Node's.

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::HttpFailure;
use super::gemini_image::generate_image;
use super::image_api::ImageReference;

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-gemini-image-twin.json");

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
        unreachable!("the Gemini image adapter never polls")
    }
}

#[tokio::test]
async fn the_gemini_image_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let script = Script { reply: case["reply"].clone(), sent: Mutex::new(Vec::new()) };
        let references: Vec<ImageReference> = case["references"].as_array().unwrap().iter().map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() }).collect();
        let outcome = generate_image(&script, "secret-key", case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &case["options"], &references, &cancel).await;
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