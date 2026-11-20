//! The model-facing media tool over a scripted media graph: what each action answers, how a lane, a model and the options are
//! chosen and refused, what is started, and what is copied where.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_services::media::MediaFailure;
use mixdog_services::media::tool::{MediaGraph, MediaToolService};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Graph {
    lanes: Mutex<Vec<Value>>,
    lanes_asked: Mutex<Vec<Option<(String, String)>>>,
    jobs: Mutex<HashMap<String, Vec<Value>>>,
    started: Mutex<Vec<Value>>,
    job_started: tokio::sync::Notify,
    start_answer: Mutex<Option<Result<Value, MediaFailure>>>,
    canceled: Mutex<Vec<String>>,
    original: Mutex<Option<PathBuf>>,
    remembered: Mutex<HashMap<String, Value>>,
    pins: Mutex<HashMap<String, Value>>,
    account_provider: Mutex<String>,
    /// Job id -> how many times `get` has been asked: the n-th ask answers the n-th snapshot, the last one stays.
    asked: Mutex<HashMap<String, usize>>,
}

#[async_trait]
impl MediaGraph for Graph {
    async fn lanes(&self, account: Option<(&str, &str)>) -> Result<Vec<Value>, String> {
        self.lanes_asked.lock().unwrap().push(account.map(|(p, a)| (p.to_owned(), a.to_owned())));
        Ok(self.lanes.lock().unwrap().clone())
    }
    fn account_provider(&self, _: &str) -> String {
        self.account_provider.lock().unwrap().clone()
    }
    async fn start(&self, input: &Value) -> Result<Value, MediaFailure> {
        self.started.lock().unwrap().push(input.clone());
        self.job_started.notify_one();
        self.start_answer
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| Ok(json!({"id": "j1", "status": "running", "kind": input["kind"], "lane": input["lane"], "model": input["model"]})))
    }
    fn get(&self, id: &str) -> Option<Value> {
        let jobs = self.jobs.lock().unwrap();
        let snapshots = jobs.get(id)?;
        let mut asked = self.asked.lock().unwrap();
        let n = asked.entry(id.to_owned()).or_insert(0);
        let snapshot = snapshots[(*n).min(snapshots.len() - 1)].clone();
        *n += 1;
        Some(snapshot)
    }
    fn cancel(&self, id: &str) -> Value {
        self.canceled.lock().unwrap().push(id.to_owned());
        json!({"id": id, "canceled": true})
    }
    async fn original_path(&self, _: &str) -> Option<PathBuf> {
        self.original.lock().unwrap().clone()
    }
    async fn remembered(&self, kind: &str) -> Option<Value> {
        self.remembered.lock().unwrap().get(kind).cloned()
    }
    async fn pin(&self, kind: &str) -> Option<Value> {
        self.pins.lock().unwrap().get(kind).cloned()
    }
}

fn lanes() -> Vec<Value> {
    vec![
        json!({"id": "openai-oauth", "label": "OpenAI Images", "authType": "oauth", "authenticated": true, "kinds": ["image"],
            "image": {"defaultModel": "gpt-image-2", "models": [{"id": "gpt-image-2", "label": "GPT Image 2", "description": "ChatGPT engine", "controls": {"maxReferences": 5, "background": ["auto", "transparent", "opaque"]}}]}, "video": null}),
        json!({"id": "xai", "label": "Grok Imagine", "authType": "api-key", "authenticated": true, "kinds": ["image", "video"],
            "image": {"defaultModel": "grok-imagine-image", "models": [{"id": "grok-imagine-image", "label": "Grok Imagine Image", "controls": {"aspectRatio": ["auto", "16:9", "1:1"], "resolution": ["1k", "2k"], "maxReferences": 5}}]},
            "video": {"defaultModel": "grok-imagine-video", "models": [{"id": "grok-imagine-video", "label": "Grok Imagine Video", "controls": {"aspectRatio": ["auto", "16:9"], "resolution": ["480p", "720p"], "durationRange": [1, 15], "maxReferences": 0}}]}}),
        json!({"id": "gemini", "label": "Google Gemini", "authType": "api-key", "authenticated": false, "kinds": [], "image": null, "video": null}),
    ]
}

struct Rig {
    graph: Arc<Graph>,
    service: MediaToolService,
    dir: tempfile::TempDir,
    clock: Arc<AtomicI64>,
}

fn rig() -> Rig {
    let graph = Arc::new(Graph::default());
    *graph.lanes.lock().unwrap() = lanes();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let now = clock.clone();
    let service = MediaToolService::new(graph.clone(), mixdog_rt::testing::tokens().durability_io, Arc::new(|session| format!("source-of-{session}")))
        .with_timing(Arc::new(move || now.load(Ordering::SeqCst)), Duration::from_millis(1));
    Rig { graph, service, dir: tempfile::tempdir().unwrap(), clock }
}

impl Rig {
    async fn run(&self, args: Value) -> (Value, bool) {
        self.run_cancelable(args, &CancellationToken::new()).await
    }

    async fn run_cancelable(&self, args: Value, cancel: &CancellationToken) -> (Value, bool) {
        let envelope = self.service.execute(&args, self.dir.path(), "sess_1", cancel).await;
        let text = envelope["content"][0]["text"].as_str().unwrap().to_owned();
        (serde_json::from_str(&text).unwrap(), envelope["isError"] == json!(true))
    }

    fn job(&self, id: &str, snapshots: Vec<Value>) {
        self.graph.jobs.lock().unwrap().insert(id.to_owned(), snapshots);
    }

    fn source_file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.path().join("source").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn started(&self) -> Vec<Value> {
        self.graph.started.lock().unwrap().clone()
    }
}

async fn failed(r: &Rig, args: Value) -> Value {
    let (body, is_error) = r.run(args).await;
    assert!(is_error, "{body}");
    assert_eq!(body["ok"], false);
    body
}

// ---- list ----

#[tokio::test]
async fn listing_without_a_kind_shows_the_signed_in_lanes_with_their_default_models_and_names_the_rest() {
    let r = rig();
    let (body, is_error) = r.run(json!({"action": "list"})).await;
    assert!(!is_error);
    assert_eq!(
        body,
        json!({"ok": true, "lanes": [
            {"id": "openai-oauth", "label": "OpenAI Images", "authType": "oauth", "kinds": ["image"], "image": "gpt-image-2"},
            {"id": "xai", "label": "Grok Imagine", "authType": "api-key", "kinds": ["image", "video"], "image": "grok-imagine-image", "video": "grok-imagine-video"},
        ], "signedOut": ["gemini"]})
    );
}

#[tokio::test]
async fn listing_a_kind_names_each_lanes_models_and_what_a_generate_without_a_lane_would_use() {
    let r = rig();
    r.graph.remembered.lock().unwrap().insert("image".into(), json!({"lane": "xai", "model": "grok-imagine-image"}));
    let (body, _) = r.run(json!({"action": "list", "kind": "image"})).await;
    assert_eq!(
        body,
        json!({"ok": true, "kind": "image", "lanes": [
            {"id": "openai-oauth", "label": "OpenAI Images", "defaultModel": "gpt-image-2", "models": ["gpt-image-2"]},
            {"id": "xai", "label": "Grok Imagine", "defaultModel": "grok-imagine-image", "models": ["grok-imagine-image"]},
        ], "remembered": {"lane": "xai", "model": "grok-imagine-image"}, "signedOut": ["gemini"]})
    );
    r.graph.pins.lock().unwrap().insert("image".into(), json!({"lane": "openai-oauth"}));
    let (pinned, _) = r.run(json!({"action": "list", "kind": "image"})).await;
    assert_eq!(pinned["remembered"], json!({"lane": "openai-oauth", "model": ""}), "a pin outranks the remembered choice");
    let (video, _) = r.run(json!({"action": "list", "kind": "video"})).await;
    assert_eq!(video["lanes"].as_array().map(Vec::len), Some(1));
    let bad = failed(&r, json!({"action": "list", "kind": "audio"})).await;
    assert_eq!(bad["error"], "kind must be one of image, video");
}

#[tokio::test]
async fn listing_a_model_shows_its_controls_on_every_lane_that_has_it_or_says_what_is_available() {
    let r = rig();
    let (body, _) = r.run(json!({"action": "list", "kind": "image", "model": "grok-imagine-image"})).await;
    assert_eq!(body["models"][0]["lane"], "xai");
    assert_eq!(body["models"][0]["controls"]["resolution"], json!(["1k", "2k"]));
    let (described, _) = r.run(json!({"action": "list", "kind": "image", "model": "gpt-image-2"})).await;
    assert_eq!(described["models"][0]["description"], "ChatGPT engine");
    let missing = failed(&r, json!({"action": "list", "kind": "image", "model": "nope"})).await;
    assert_eq!(missing["error"], "model \"nope\" is not available for image on a signed-in lane");
    assert_eq!(missing["available"], json!(["openai-oauth/gpt-image-2", "xai/grok-imagine-image"]));
}

#[tokio::test]
async fn a_lane_whose_catalog_failed_or_fell_back_is_reported_beside_the_list() {
    let r = rig();
    {
        let mut all = r.graph.lanes.lock().unwrap();
        all[2]["catalogError"] = json!("Google Gemini (API key): Authentication failed.");
        all[2]["catalogErrorCode"] = json!("MEDIA_AUTH_REJECTED");
        all[1]["catalogWarning"] = json!("Using the last successful model catalog.");
    }
    let (body, _) = r.run(json!({"action": "list"})).await;
    assert_eq!(body["catalogErrors"], json!([{"lane": "gemini", "error": "Google Gemini (API key): Authentication failed.", "code": "MEDIA_AUTH_REJECTED"}]));
    assert_eq!(body["catalogWarnings"], json!([{"lane": "xai", "warning": "Using the last successful model catalog."}]));
}

// ---- generate: what is asked for, what is refused ----

#[tokio::test]
async fn a_generate_names_its_kind_prompt_and_path_or_is_refused() {
    let r = rig();
    assert_eq!(failed(&r, json!({"action": "generate"})).await["error"], "generate requires kind: image | video");
    assert_eq!(
        failed(&r, json!({"action": "generate", "kind": "image", "prompt": "  "})).await["error"],
        "generate requires prompt: the subject, the treatment, the mood, the framing, and what must not appear"
    );
    assert_eq!(failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p"})).await["error"], "generate requires path: where to write the file");
    assert_eq!(failed(&r, json!({"action": "zap"})).await["error"], "Unsupported media action \"zap\"; use list, generate, status, cancel");
    assert!(r.started().is_empty());
}

#[tokio::test]
async fn a_generate_runs_the_job_waits_for_it_and_copies_the_asset_to_the_path_with_its_extension() {
    let r = rig();
    *r.graph.original.lock().unwrap() = Some(r.source_file("a.png", b"PNGDATA"));
    r.job(
        "j1",
        vec![
            json!({"id": "j1", "status": "running"}),
            json!({"id": "j1", "status": "done", "assetId": "asset-1", "startedAt": 1_000_000, "endedAt": 1_004_000}),
        ],
    );
    let (body, is_error) = r.run(json!({"action": " Generate ", "kind": "image", "prompt": "a lamp", "path": "out/lamp"})).await;
    assert!(!is_error, "{body}");
    let output = r.dir.path().join("out").join("lamp.png");
    assert_eq!(std::fs::read(&output).unwrap(), b"PNGDATA");
    assert_eq!(body["output"], output.to_string_lossy().as_ref());
    assert_eq!(
        (
            body["lane"].clone(),
            body["model"].clone(),
            body["laneSource"].clone(),
            body["assetId"].clone(),
            body["elapsedMs"].clone(),
            body["referenceCount"].clone()
        ),
        (json!("openai-oauth"), json!("gpt-image-2"), json!("first"), json!("asset-1"), json!(4000), json!(0))
    );
    assert_eq!(body["options"], json!({}));
    assert_eq!(
        r.started(),
        vec![
            json!({"lane": "openai-oauth", "kind": "image", "model": "gpt-image-2", "prompt": "a lamp", "options": {}, "references": [], "sessionId": "sess_1", "sourceType": "source-of-sess_1"})
        ]
    );
}

#[tokio::test]
async fn a_path_that_names_an_extension_is_kept_as_it_is() {
    let r = rig();
    *r.graph.original.lock().unwrap() = Some(r.source_file("a.png", b"x"));
    r.job("j1", vec![json!({"id": "j1", "status": "done", "assetId": "a"})]);
    let (body, _) = r.run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "x.bin"})).await;
    assert!(r.dir.path().join("x.bin").exists(), "{body}");
}

#[tokio::test]
async fn without_waiting_a_generate_returns_the_job_and_how_to_poll_it() {
    let r = rig();
    let (body, is_error) = r.run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "out/pic", "wait": false})).await;
    assert!(!is_error);
    assert_eq!((body["job"].as_str(), body["status"].as_str(), body["lane"].as_str()), (Some("j1"), Some("running"), Some("openai-oauth")));
    assert_eq!(body["nextAction"], "Poll media status job:j1 path:out/pic; the file is written when status is done.");
    assert!(!r.dir.path().join("out").exists(), "nothing is written before the job is done");
}

#[tokio::test]
async fn a_job_that_fails_or_never_ends_is_an_error_naming_the_job() {
    let r = rig();
    r.job("j1", vec![json!({"id": "j1", "status": "failed", "error": "upstream said no"})]);
    let error = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    assert_eq!((error["error"].as_str(), error["job"].as_str()), (Some("generation failed on openai-oauth/gpt-image-2: upstream said no"), Some("j1")));
    r.job("j1", vec![json!({"id": "j1", "status": "cancelled"})]);
    assert_eq!(
        failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await["error"],
        "generation failed on openai-oauth/gpt-image-2: cancelled"
    );
    r.job("j1", vec![json!({"id": "j1", "status": "running"})]);
    let clock = r.clock.clone();
    let ticking = MediaToolService::new(r.graph.clone(), mixdog_rt::testing::tokens().durability_io, Arc::new(|_| String::new()))
        .with_timing(Arc::new(move || clock.fetch_add(60_000, Ordering::SeqCst)), Duration::from_millis(1));
    let envelope =
        ticking.execute(&json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"}), r.dir.path(), "s", &CancellationToken::new()).await;
    let body: Value = serde_json::from_str(envelope["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(body["error"], "generation is still running after 180s on openai-oauth; poll media status job:j1");
    assert_eq!(body["job"], "j1");
}

#[tokio::test]
async fn a_cancel_while_waiting_cancels_the_job() {
    let r = rig();
    r.job("j1", vec![json!({"id": "j1", "status": "running"})]);
    let stop = CancellationToken::new();
    stop.cancel();
    let (body, is_error) = r.run_cancelable(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"}), &stop).await;
    assert!(is_error);
    assert_eq!(body["error"], "generation canceled");
    assert_eq!(*r.graph.canceled.lock().unwrap(), vec!["j1"]);
}

#[tokio::test]
async fn dropping_a_cancelled_waiting_call_still_cancels_the_media_job() {
    let r = rig();
    let stop = CancellationToken::new();
    let mut running = Box::pin(r.run_cancelable(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"}), &stop));
    tokio::select! {
        _ = r.graph.job_started.notified() => {}
        _ = &mut running => panic!("generation should still be waiting for the job"),
    }
    stop.cancel();
    drop(running);
    assert_eq!(*r.graph.canceled.lock().unwrap(), vec!["j1"]);
}

#[tokio::test]
async fn a_start_that_the_graph_refuses_keeps_its_message_and_code() {
    let r = rig();
    *r.graph.start_answer.lock().unwrap() = Some(Err(MediaFailure::new("no credits", "MEDIA_BILLING_BLOCKED")));
    let body = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    assert_eq!((body["error"].as_str(), body["code"].as_str()), (Some("no credits"), Some("MEDIA_BILLING_BLOCKED")));
}

// ---- generate: choosing the lane and model ----

#[tokio::test]
async fn the_lane_is_the_named_one_else_the_remembered_one_else_the_chatgpt_lane_else_the_first() {
    let r = rig();
    r.job("j1", vec![json!({"id": "j1", "status": "failed", "error": "stop here"})]);
    let rig = &r;
    let run = |args: Value| async move { failed(rig, args).await["error"].as_str().unwrap().to_owned() };
    assert!(run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai"})).await.contains("xai/grok-imagine-image"));
    r.graph.remembered.lock().unwrap().insert("image".into(), json!({"lane": "xai", "model": "grok-imagine-image"}));
    assert!(run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await.contains("xai/grok-imagine-image"), "the remembered lane");
    assert_eq!(r.started().last().unwrap()["lane"], "xai");
    r.graph.remembered.lock().unwrap().insert("image".into(), json!({"lane": "xai", "model": "unlisted"}));
    run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    assert_eq!(r.started().last().unwrap()["model"], "grok-imagine-image", "a remembered model counts only while the lane lists it");
    r.graph.remembered.lock().unwrap().insert("image".into(), json!({"lane": "gemini"}));
    run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    assert_eq!(r.started().last().unwrap()["lane"], "openai-oauth", "a remembered lane that is not signed in is passed over");
    r.graph.remembered.lock().unwrap().clear();
    run(json!({"action": "generate", "kind": "video", "prompt": "p", "path": "o"})).await;
    assert_eq!(r.started().last().unwrap()["lane"], "xai", "the only lane with video");
}

#[tokio::test]
async fn a_lane_or_model_that_cannot_serve_the_request_is_refused_with_what_could() {
    let r = rig();
    let lane = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "gemini"})).await;
    assert_eq!(lane["error"], "lane \"gemini\" is not signed in or does not generate image");
    assert_eq!(lane["lanes"].as_array().map(Vec::len), Some(2));
    let model = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "model": "nope"})).await;
    assert_eq!(model["error"], "model \"nope\" is not available on xai for image");
    assert_eq!(model["available"], json!(["grok-imagine-image"]));
    r.graph.lanes.lock().unwrap().truncate(0);
    let none = failed(&r, json!({"action": "generate", "kind": "video", "prompt": "p", "path": "o"})).await;
    assert_eq!(none["error"], "No signed-in lane generates video (Settings → Providers). Use user-supplied files or continue without media.");
    assert_eq!(none["lanes"], json!([]));
    *r.graph.lanes.lock().unwrap() = lanes();
    r.graph.lanes.lock().unwrap()[1]["catalogError"] = json!("Grok Imagine (API key): Authentication failed.");
    let broken = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai"})).await;
    assert_eq!(broken["error"], "Grok Imagine (API key): Authentication failed.", "a lane with a broken catalog says so");
}

#[tokio::test]
async fn a_pinned_default_applies_unless_the_call_names_a_lane_or_model_and_a_pinned_account_scopes_the_lanes() {
    let r = rig();
    r.job("j1", vec![json!({"id": "j1", "status": "failed", "error": "stop"})]);
    r.graph.pins.lock().unwrap().insert("image".into(), json!({"lane": "xai", "model": "grok-imagine-image", "account": "acct-1"}));
    *r.graph.account_provider.lock().unwrap() = "grok-oauth".into();
    failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    let started = r.started();
    assert_eq!((started[0]["lane"].clone(), started[0]["account"].clone()), (json!("xai"), json!("acct-1")));
    assert_eq!(r.graph.lanes_asked.lock().unwrap()[0], Some(("grok-oauth".to_owned(), "acct-1".to_owned())));
    failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "openai-oauth"})).await;
    assert_eq!(r.started()[1]["lane"], "openai-oauth", "a named lane beats the pin");
    assert!(r.started()[1].get("account").is_none());
    let (body, _) = r.run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "wait": false})).await;
    assert_eq!(body["laneSource"], "pinned");
    r.graph.pins.lock().unwrap().insert("image".into(), json!({"lane": "gemini"}));
    let refused = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o"})).await;
    assert!(refused["error"].as_str().unwrap().contains("lane \"gemini\" is not signed in"), "a pin never falls back to another lane");
}

// ---- generate: the options ----

async fn started_options(r: &Rig, args: Value) -> Value {
    let mut full = json!({"action": "generate", "prompt": "p", "path": "o", "wait": false});
    full.as_object_mut().unwrap().extend(args.as_object().unwrap().clone());
    let (body, is_error) = r.run(full).await;
    assert!(!is_error, "{body}");
    r.started().last().unwrap()["options"].clone()
}

#[tokio::test]
async fn the_placement_words_become_the_lanes_options_checked_against_the_models_controls() {
    let r = rig();
    assert_eq!(
        started_options(&r, json!({"kind": "image", "lane": "xai", "aspect": "16:9", "resolution": "1k"})).await,
        json!({"aspectRatio": "16:9", "resolution": "1k"})
    );
    assert_eq!(started_options(&r, json!({"kind": "image", "lane": "xai"})).await, json!({"resolution": "2k"}), "a lane that lists 2k gets it by default");
    assert_eq!(started_options(&r, json!({"kind": "image", "lane": "openai-oauth", "background": "transparent"})).await, json!({"background": "transparent"}));
    assert_eq!(started_options(&r, json!({"kind": "image", "lane": "openai-oauth", "background": "auto"})).await, json!({}), "auto is the lane's own default");
    assert_eq!(
        started_options(&r, json!({"kind": "video", "lane": "xai", "duration": 6, "resolution": "720p"})).await,
        json!({"resolution": "720p", "duration": 6})
    );
}

#[tokio::test]
async fn an_option_the_model_does_not_take_is_refused_with_the_ones_it_does() {
    let r = rig();
    let run = |args: Value| async move {
        let mut full = json!({"action": "generate", "prompt": "p", "path": "o"});
        full.as_object_mut().unwrap().extend(args.as_object().unwrap().clone());
        full
    };
    let aspect = failed(&r, run(json!({"kind": "image", "lane": "xai", "aspect": "4:3"})).await).await;
    assert_eq!(aspect["error"], "aspect \"4:3\" is not supported by this model; use one of auto, 16:9, 1:1");
    let resolution = failed(&r, run(json!({"kind": "image", "lane": "xai", "resolution": "8k"})).await).await;
    assert_eq!(resolution["error"], "resolution \"8k\" is not supported by this model; use one of 1k, 2k");
    let quality = failed(&r, run(json!({"kind": "image", "lane": "xai", "quality": "high"})).await).await;
    assert_eq!(quality["error"], "quality \"high\" is not supported by this model");
    let background = failed(&r, run(json!({"kind": "image", "lane": "openai-oauth", "background": "red"})).await).await;
    assert_eq!(background["error"], "background \"red\" is not supported by this model; use one of auto, transparent, opaque");
    let chatgpt = failed(&r, run(json!({"kind": "image", "lane": "openai-oauth", "aspect": "16:9"})).await).await;
    assert_eq!(chatgpt["error"], "ChatGPT selects image output settings; explicit size and quality are not supported on this connection.");
    let long = failed(&r, run(json!({"kind": "video", "lane": "xai", "duration": 20})).await).await;
    assert_eq!(long["error"], "duration 20s is outside 1-15s");
    assert!(r.started().is_empty());
}

#[tokio::test]
async fn reference_images_are_read_as_base64_with_their_mime_and_counted_against_the_models_limit() {
    let r = rig();
    std::fs::write(r.dir.path().join("a.PNG"), b"AAA").unwrap();
    std::fs::write(r.dir.path().join("b.jpeg"), b"BBB").unwrap();
    std::fs::write(r.dir.path().join("c.txt"), b"x").unwrap();
    let (body, is_error) = r
        .run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "wait": false, "references": ["a.PNG", " b.jpeg ", ""]}))
        .await;
    assert!(!is_error, "{body}");
    assert_eq!(body["referenceCount"], 2);
    assert_eq!(r.started()[0]["references"], json!([{"base64": "QUFB", "name": "a.PNG"}, {"base64": "QkJC", "name": "b.jpeg"}]));
    // The graph's admission checks bytes, not extensions. This fake just captures the request.
    let (text, is_error) =
        r.run(json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "wait": false, "references": ["c.txt"]})).await;
    assert!(!is_error, "{text}");
    assert_eq!(r.started()[1]["references"], json!([{"base64": "eA==", "name": "c.txt"}]));
    let malformed = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "references": [true]})).await;
    assert_eq!(malformed["error"], "references must be an array of file paths");
    let many = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "references": ["a.PNG", "a.PNG", "a.PNG", "a.PNG", "a.PNG", "a.PNG"]})).await;
    assert_eq!(many["error"], "this model takes at most 5 reference image(s); 6 given");
    let none = failed(&r, json!({"action": "generate", "kind": "video", "prompt": "p", "path": "o", "lane": "xai", "references": ["a.PNG"]})).await;
    assert_eq!(none["error"], "this model takes no reference images");
    let missing = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "references": ["gone.png"]})).await;
    assert!(missing["error"].as_str().unwrap().starts_with("ENOENT: no such file or directory, open "), "{missing}");
    // A reference file past 12 MB is refused by name before any job starts.
    std::fs::write(r.dir.path().join("big.png"), vec![0u8; 12 * 1024 * 1024 + 1]).unwrap();
    let big = failed(&r, json!({"action": "generate", "kind": "image", "prompt": "p", "path": "o", "lane": "xai", "references": ["big.png"]})).await;
    assert_eq!(big["error"], "reference \"big.png\" exceeds 12 MB");
    assert_eq!(r.started().len(), 2);
}

// ---- status and cancel ----

#[tokio::test]
async fn status_reports_a_job_and_writes_the_file_of_a_finished_one() {
    let r = rig();
    assert_eq!(failed(&r, json!({"action": "status"})).await["error"], "status requires job");
    assert_eq!(failed(&r, json!({"action": "status", "job": "x"})).await["error"], "job \"x\" is not known (finished jobs expire after 10 minutes)");
    r.job("run", vec![json!({"id": "run", "status": "running", "kind": "video", "lane": "xai", "model": "m", "progress": 40, "startedAt": 100, "endedAt": 0})]);
    let (running, is_error) = r.run(json!({"action": "status", "job": "run"})).await;
    assert!(!is_error);
    assert_eq!(
        (running["ok"].clone(), running["job"].clone(), running["progress"].clone(), running["status"].clone()),
        (json!(true), json!("run"), json!(40), json!("running"))
    );
    r.job("bad", vec![json!({"id": "bad", "status": "failed", "error": "boom"})]);
    let (bad, is_error) = r.run(json!({"action": "status", "job": "bad"})).await;
    assert!(!is_error, "a failed job is still a successful status");
    assert_eq!((bad["ok"].clone(), bad["error"].clone()), (json!(false), json!("boom")));
    *r.graph.original.lock().unwrap() = Some(r.source_file("v.mp4", b"MP4"));
    r.job("ok", vec![json!({"id": "ok", "status": "done", "assetId": "a1", "startedAt": 1, "endedAt": 3})]);
    let (done, _) = r.run(json!({"action": "status", "job": "ok", "path": "clips/v"})).await;
    let output = r.dir.path().join("clips").join("v.mp4");
    assert_eq!(done["output"], output.to_string_lossy().as_ref());
    assert_eq!((std::fs::read(&output).unwrap(), done["elapsedMs"].clone()), (b"MP4".to_vec(), json!(2)));
    *r.graph.original.lock().unwrap() = None;
    let unreadable = failed(&r, json!({"action": "status", "job": "ok", "path": "clips/w"})).await;
    assert_eq!(unreadable["error"], "the generated asset is not readable from the media store");
}

#[tokio::test]
async fn cancel_names_the_job_and_whether_it_was_canceled() {
    let r = rig();
    assert_eq!(failed(&r, json!({"action": "cancel"})).await["error"], "cancel requires job");
    assert_eq!(failed(&r, json!({"action": "cancel", "job": "x"})).await["error"], "job \"x\" is not known");
    r.job("j9", vec![json!({"id": "j9", "status": "running"})]);
    let (body, is_error) = r.run(json!({"action": "cancel", "job": "j9"})).await;
    assert!(!is_error);
    assert_eq!((body["ok"].clone(), body["canceled"].clone(), body["job"].clone()), (json!(true), json!(true), json!("j9")));
    assert_eq!(*r.graph.canceled.lock().unwrap(), vec!["j9"]);
}

#[test]
fn the_tools_actions_are_list_generate_status_and_cancel() {
    assert_eq!(mixdog_services::media::tool::MEDIA_ACTIONS, ["list", "generate", "status", "cancel"]);
    let _ = Path::new("");
}
