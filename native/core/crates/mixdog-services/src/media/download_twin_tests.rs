//! `fixtures/services/media-download-public-twin.json` (`record-media-download-public.mjs`):
//! Node's `downloadPublicMedia` / `downloadGeminiMedia` over a scripted fetch. The bytes or the
//! error (message, code, status) and the requests made (address, headers) must equal Node's. The
//! recording holds Node's SSRF verdict for every address, which the scripted fetch answers as the
//! real one does.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::download::{AdapterError, Limits, PublicFetch, PublicResponse, download_gemini_media, download_public_media};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-download-public-twin.json");

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Option<VecDeque<Vec<u8>>>,
}

#[async_trait]
impl PublicResponse for Reply {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.clone())
    }

    fn has_body(&self) -> bool {
        self.body.is_some()
    }

    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, AdapterError> {
        Ok(self.body.as_mut().and_then(VecDeque::pop_front))
    }
}

struct Script {
    guard: Value,
    answers: Mutex<HashMap<String, VecDeque<Value>>>,
    seen: Mutex<Vec<Value>>,
}

#[async_trait]
impl PublicFetch for Script {
    async fn get(&self, url: &str, headers: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        let verdict = &self.guard[url];
        assert!(verdict.is_object(), "no recorded verdict for {url}");
        if verdict["ok"] != true {
            let code = verdict["code"].as_str().map(str::to_owned);
            return Err(AdapterError { message: verdict["message"].as_str().unwrap().to_owned(), code, status: None, usage: None, resets_at: None });
        }
        let header_map: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        self.seen.lock().unwrap().push(json!({ "url": url, "headers": header_map }));
        let next = self.answers.lock().unwrap().get_mut(url).and_then(VecDeque::pop_front);
        let Some(next) = next else { return Err(AdapterError::plain(format!("unscripted fetch {url}"))) };
        if let Some(message) = next["fail"].as_str() {
            return Err(AdapterError::plain(message));
        }
        let body = if let Some(chunks) = next["chunks"].as_array() {
            Some(chunks.iter().map(|c| c.as_str().unwrap().as_bytes().to_vec()).collect())
        } else {
            next["body"].as_str().map(|text| VecDeque::from([text.as_bytes().to_vec()]))
        };
        let headers = next["headers"].as_object().map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default();
        Ok(Box::new(Reply { status: next["status"].as_u64().unwrap_or(200) as u16, headers, body }))
    }
}

#[tokio::test]
async fn generated_media_is_fetched_as_nodes_fetches_it() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cancel = CancellationToken::new();
    for case in golden["scenarios"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let answers = case["answers"].as_object().unwrap().iter().map(|(url, list)| (url.clone(), list.as_array().unwrap().iter().cloned().collect())).collect();
        let script = Script { guard: case["guard"].clone(), answers: Mutex::new(answers), seen: Mutex::new(Vec::new()) };
        let gemini = case["kind"] == "gemini";
        let default_label = if gemini { "Veo video" } else { "generated media" };
        let options = &case["options"];
        let defaults = Limits::default();
        let limits = Limits {
            max_bytes: options["maxBytes"].as_u64().map_or(defaults.max_bytes, |n| n as usize),
            label: options["label"].as_str().unwrap_or(default_label),
        };
        let url = case["url"].as_str().unwrap();
        let outcome = if gemini {
            download_gemini_media(&script, url, options["key"].as_str().unwrap(), &limits, &cancel).await
        } else {
            download_public_media(&script, url, &limits, &cancel).await
        };
        let got = match outcome {
            Ok(bytes) => json!({ "value": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>() }),
            Err(error) => json!({ "error": { "message": error.message, "code": error.code, "status": error.status } }),
        };
        let want = match case.get("value") {
            Some(value) => json!({ "value": value }),
            None => json!({ "error": { "message": case["error"]["message"], "code": case["error"]["code"], "status": case["error"]["status"] } }),
        };
        assert_eq!(got, want, "{name}");
        let wanted_seen: Vec<Value> = case["seen"].as_array().unwrap().iter().map(|s| json!({ "url": s["url"], "headers": s["headers"] })).collect();
        assert_eq!(*script.seen.lock().unwrap(), wanted_seen, "{name}: requests");
    }
}
