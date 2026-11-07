//! `fixtures/services/media-gemini-video-twin.json` (`record-media-gemini-video.mjs`): Node's
//! Gemini video adapter (Omni and Veo) with the network, the clock and the poll wait stubbed.
//! Every request (address, headers, body text in key order, timeout), the progress ticks, the
//! time spent polling and the result or error with its attached usage must equal Node's. Veo's
//! sample address is refused or malformed in every recorded scenario, so the download itself is
//! the part -15's golden covers.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::HttpFailure;
use super::download::{AdapterError, PublicFetch, PublicResponse};
use super::gemini_video::generate_video;
use super::image_api::ImageReference;
use super::xai::Pacer;

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-gemini-video-twin.json");

struct Script {
    queue: Mutex<VecDeque<Value>>,
    sent: Mutex<Vec<Value>>,
    abort_after: Option<usize>,
    cancel: CancellationToken,
}

impl Script {
    fn answer(&self, record: Value) -> Result<PostReply, HttpFailure> {
        let count = {
            let mut sent = self.sent.lock().unwrap();
            sent.push(record);
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

fn header_map(headers: &[(String, String)]) -> serde_json::Map<String, Value> {
    headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect()
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.answer(json!({ "url": url, "method": "POST", "headers": header_map(headers), "body": mixdog_js::json_stringify(body), "timeoutMs": timeout.as_millis() as u64 }))
    }

    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.answer(json!({ "url": url, "method": "GET", "headers": header_map(headers), "body": null, "timeoutMs": timeout.as_millis() as u64 }))
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

struct NeverFetched;

#[async_trait]
impl PublicFetch for NeverFetched {
    async fn get(&self, url: &str, _: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        panic!("the recorded scenarios never reach the download: {url}")
    }
}

#[tokio::test]
async fn the_gemini_video_adapter_answers_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let start = golden["clock"].as_i64().unwrap();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let cancel = CancellationToken::new();
        let queue: VecDeque<Value> = case["script"].as_array().unwrap().iter().flat_map(|entry| std::iter::repeat_n(entry.clone(), entry["repeat"].as_u64().unwrap_or(1) as usize)).collect();
        let script = Script { queue: Mutex::new(queue), sent: Mutex::new(Vec::new()), abort_after: case["abortAfterFetches"].as_u64().map(|n| n as usize), cancel: cancel.clone() };
        let references: Vec<ImageReference> = case["references"].as_array().unwrap().iter().map(|r| ImageReference { base64: r["base64"].as_str().unwrap_or_default().to_owned(), mime: r["mime"].as_str().unwrap_or_default().to_owned() }).collect();
        let clock = Clock(AtomicI64::new(start));
        let progress = Mutex::new(Vec::new());
        let record = |value: f64| progress.lock().unwrap().push(mixdog_js::json_number(value));
        let outcome = generate_video(&script, &NeverFetched, &clock, "gem-key-1", case["model"].as_str().unwrap(), case["prompt"].as_str().unwrap(), &case["options"], &references, &cancel, &record).await;
        let got = match outcome {
            Ok(video) => json!({ "bytes": video.bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), "mime": video.mime, "usage": video.usage }),
            Err(error) => json!({ "message": error.message, "code": error.code, "status": error.status, "usage": error.usage }),
        };
        let want = case.get("value").or_else(|| case.get("error")).unwrap();
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{name}");
        let wanted: Vec<Value> = case["sent"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "method": s["method"], "headers": s["headers"], "body": s["body"], "timeoutMs": s["timeoutMs"] })).collect();
        assert_eq!(*script.sent.lock().unwrap(), wanted, "{name}: requests");
        assert_eq!(*progress.lock().unwrap(), case["progress"].as_array().unwrap().clone(), "{name}: progress");
        assert_eq!(clock.now() - start, case["elapsedMs"].as_i64().unwrap(), "{name}: time spent polling");
    }
}