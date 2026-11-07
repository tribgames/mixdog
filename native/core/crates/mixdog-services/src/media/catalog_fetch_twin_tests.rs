//! `fixtures/services/media-catalog-fetch-twin.json` (`record-media-catalog-fetch.mjs`): Node's
//! `fetchMediaModelRows` over a scripted transport and `makeModelCache` as `sourceCache` configures
//! it. The requests made, the rows or the failure (message, code, status), the cache file's bytes
//! and every load's answer must equal Node's. The recording holds `{data}` for its data folder.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::catalog_fetch::{Auth, CatalogHttp, FileCatalogCache, HttpFailure, HttpReply, fetch_media_model_rows, media_catalog_timeout};
use super::loader::CatalogCache;

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-catalog-fetch-twin.json");

/// The recorder's `fetchFn`: the scripted replies in order, every request logged.
struct Scripted {
    replies: Mutex<Vec<Value>>,
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl CatalogHttp for Scripted {
    async fn get(&self, url: &str, headers: &[(String, String)], _: std::time::Duration) -> Result<HttpReply, HttpFailure> {
        let headers: serde_json::Map<String, Value> = headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        // The transport refuses redirects and carries the lane's timeout: Node's `redirect: 'error'`
        // and `signal`; it adds no dispatcher of its own here.
        self.calls.lock().unwrap().push(json!({ "url": url, "headers": headers, "redirect": "error", "hasSignal": true, "hasDispatcher": false }));
        let next = self.replies.lock().unwrap().remove(0);
        match next["throws"].as_str() {
            Some(text) => Err(HttpFailure { message: text.to_owned(), timed_out: false }),
            None => Ok(HttpReply { status: next["status"].as_u64().unwrap() as u16, body: next["body"].as_str().unwrap().to_owned() }),
        }
    }
}

#[test]
fn lane_timeouts_match_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for (lane, ms) in golden["timeouts"].as_object().unwrap() {
        assert_eq!(media_catalog_timeout(lane).as_millis() as u64, ms.as_u64().unwrap(), "{lane}");
    }
}

#[tokio::test]
async fn the_catalog_request_is_what_nodes_sends_and_fails_as_nodes_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for recorded in golden["fetches"].as_array().unwrap() {
        let name = recorded["name"].as_str().unwrap();
        let http = Scripted { replies: Mutex::new(recorded["replies"].as_array().unwrap().clone()), calls: Mutex::default() };
        let auth = Auth { token: recorded["auth"]["token"].as_str().unwrap().to_owned(), base_url: recorded["auth"]["baseURL"].as_str().unwrap_or_default().to_owned(), ..Auth::default() };
        let got = match fetch_media_model_rows(&http, recorded["lane"].as_str().unwrap(), &auth).await {
            Ok(rows) => json!({ "rows": rows }),
            Err(error) => json!({ "error": { "message": error.message, "code": error.code, "status": error.status } }),
        };
        match recorded.get("rows") {
            Some(rows) => assert_eq!(got, json!({ "rows": rows }), "{name}"),
            None => assert_eq!(got, json!({ "error": recorded["error"] }), "{name}"),
        }
        assert_eq!(json!(http.calls.lock().unwrap().clone()), recorded["calls"], "{name}: requests");
    }
}

#[tokio::test]
async fn the_cache_file_and_its_loads_match_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().to_path_buf();
    let clock = Arc::new(AtomicI64::new(golden["clock"].as_i64().unwrap()));
    let now: Arc<dyn Fn() -> i64 + Send + Sync> = {
        let clock = clock.clone();
        Arc::new(move || clock.load(Ordering::SeqCst))
    };
    let tokens = mixdog_rt::testing::tokens();
    let cache = FileCatalogCache { data_dir: data.clone(), lane: tokens.durability_io, now };
    assert_eq!(golden["cachePath"], "{data}/studio-models-k1.json");
    for (index, recorded) in golden["cache"].as_array().unwrap().iter().enumerate() {
        let step = &recorded["step"];
        let key = step["key"].as_str().unwrap();
        clock.store(golden["clock"].as_i64().unwrap() + step["at"].as_i64().unwrap_or(0), Ordering::SeqCst);
        let mut got = Value::Null;
        match step["op"].as_str().unwrap() {
            "raw" => std::fs::write(data.join(format!("studio-models-{key}.json")), step["text"].as_str().unwrap()).unwrap(),
            "save" => cache.save(key, step["rows"].as_array().unwrap()).await,
            "load" => got = json!(cache.load(key, step["stale"] == true).await),
            other => panic!("{other}"),
        }
        assert_eq!(got, recorded["result"], "step {index}: {step}");
        if step["op"] != "load" {
            let file = std::fs::read_to_string(data.join(format!("studio-models-{key}.json"))).ok();
            assert_eq!(json!(file), recorded["file"], "step {index}: file");
        }
    }
}
