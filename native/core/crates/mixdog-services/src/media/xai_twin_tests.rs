//! `fixtures/services/media-xai-twin.json` (`record-media-xai.mjs`): Node's xAI Imagine adapter
//! with the network, the clock and the poll wait stubbed. Every request (address, headers, body
//! text in key order, the timeout attached), the progress callbacks, the time the poll loop took
//! and the result or error with its attached usage must equal Node's. A signed video address goes
//! to the public fetch, which here answers with Node's own SSRF refusal.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::{Auth, HttpFailure};
use super::download::{AdapterError, PublicFetch, PublicResponse};
use super::image_api::ImageReference;
use super::xai::{Pacer, generate_image, generate_video};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-xai-twin.json");

struct Script {
    queue: Mutex<VecDeque<Value>>,
    sent: Mutex<Vec<Value>>,
    abort_after: Option<usize>,
    cancel: CancellationToken,
}

impl Script {
    fn answer(&self, url: &str, method: &str, headers: &[(String, String)], body: Option<String>, timeout: Duration) -> Result<PostReply, HttpFailure> {
        let header_map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        let count = {
            let mut sent = self.sent.lock().unwrap();
            sent.push(json!({ "url": url, "method": method, "headers": header_map, "body": body, "timeoutMs": timeout.as_millis() as u64 }));
            sent.len()
        };
        if self.abort_after.is_some_and(|after| count >= after) {
            self.cancel.cancel();
        }
        let Some(entry) = self.queue.lock().unwrap().pop_front() else { return Err(HttpFailure { message: "unscripted fetch".to_owned(), timed_out: false }) };
        if let Some(message) = entry["fail"].as_str() {
            return Err(HttpFailure { message: message.to_owned(), timed_out: entry["name"] == "TimeoutError" });
        }
        let body = if entry["json"].is_null() { entry["text"].as_str().unwrap().to_owned() } else { mixdog_js::json_stringify(&entry["json"]) };
        Ok(PostReply { status: entry["status"].as_u64().unwrap() as u16, headers: Vec::new(), body })
    }
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.answer(url, "POST", headers, Some(mixdog_js::json_stringify(body)), timeout)
    }

    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.answer(url, "GET", headers, None, timeout)
    }
}

struct Clock(AtomicI64);

#[async_trait]
impl Pacer for Clock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    async fn sleep(&self, ms: u64) {
        self.0.fetch_add(ms as i64, Ordering::SeqCst);
    }
}

struct Refuse;

#[async_trait]
impl PublicFetch for Refuse {
    async fn get(&self, url: &str, _: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        let host = url.trim_start_matches("http://").split('/').next().unwrap();
        Err(AdapterError::plain(format!("Blocked request to private address: {host}")))
    }
}

#[tokio::test]
async fn the_xai_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let start = golden["clock"].as_i64().unwrap();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let cancel = CancellationToken::new();
        let queue: VecDeque<Value> = case["script"].as_array().unwrap().iter().flat_map(|entry| std::iter::repeat_n(entry.clone(), entry["repeat"].as_u64().unwrap_or(1) as usize)).collect();
        let script = Script { queue: Mutex::new(queue), sent: Mutex::new(Vec::new()), abort_after: case["abortAfterFetches"].as_u64().map(|n| n as usize), cancel: cancel.clone() };
        let auth = Auth { token: case["auth"]["token"].as_str().unwrap().to_owned(), base_url: case["auth"]["baseURL"].as_str().unwrap().to_owned(), ..Auth::default() };
        let references: Vec<ImageReference> = case["references"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() })
            .collect();
        let clock = Clock(AtomicI64::new(start));
        let progress = Mutex::new(Vec::new());
        let (model, prompt, options) = (case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &case["options"]);
        let got = if case["kind"] == "image" {
            match generate_image(&script, &auth, model, prompt, options, &references, &cancel).await {
                Ok(image) => json!({ "bytes": image.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": image.mime, "revisedPrompt": image.revised_prompt, "durationSeconds": null, "usage": image.usage }),
                Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage }),
            }
        } else {
            let record = |value: f64| progress.lock().unwrap().push(mixdog_js::json_number(value));
            match generate_video(&script, &Refuse, &clock, &auth, model, prompt, options, &references, &cancel, &record).await {
                Ok(video) => json!({ "bytes": video.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": video.mime, "durationSeconds": video.duration_seconds, "usage": video.usage }),
                Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage }),
            }
        };
        let want = case.get("value").or_else(|| case.get("error")).unwrap();
        if want.get("message").is_some() {
            assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{name}");
        } else {
            // A result: the video has no revised prompt, the image no duration.
            for key in ["bytes", "mime", "usage"] {
                assert_eq!(got[key], want[key], "{name}: {key}");
            }
            if case["kind"] == "video" {
                assert_eq!(got["durationSeconds"], want["durationSeconds"], "{name}: duration");
            } else {
                assert_eq!(got["revisedPrompt"], want["revisedPrompt"], "{name}: revised prompt");
            }
        }
        let wanted_sent: Vec<Value> = case["sent"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "method": s["method"], "headers": s["headers"], "body": s["body"], "timeoutMs": s["timeoutMs"] })).collect();
        assert_eq!(*script.sent.lock().unwrap(), wanted_sent, "{name}: requests");
        assert_eq!(*progress.lock().unwrap(), case["progress"].as_array().unwrap().clone(), "{name}: progress");
        assert_eq!(clock.now() - start, case["elapsedMs"].as_i64().unwrap(), "{name}: time spent polling");
    }
}